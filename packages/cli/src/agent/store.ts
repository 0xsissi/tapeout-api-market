import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAYMENT_TOKEN, PAYMENT_NETWORK, formatPaymentAmount, parsePaymentAmount, type AgentActionRequest, type AgentBudget, type AgentOperation, type AgentPolicy } from '@clawmarket/shared';

interface State { version: 1; symbol: string; scope: string; operations: AgentOperation[] }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function defaultAgentPolicy(): AgentPolicy {
  return { version: 1, paymentSymbol: PAYMENT_TOKEN.symbol, paused: true, allowedActions: [], dailySpendToken: '0', maxCallToken: '0', dailyDepositToken: '0', models: [], sellerPrice: { minimum: 0, maximum: 0, maxChangePercent: 10, minIntervalSeconds: 60 } };
}
export function validateAgentPolicy(value: AgentPolicy): AgentPolicy {
  if (!value || value.version !== 1 || value.paymentSymbol !== PAYMENT_TOKEN.symbol || typeof value.paused !== 'boolean') throw new AgentError('invalid_policy', '规则版本或币种不匹配。');
  if (!Array.isArray(value.allowedActions) || value.allowedActions.some(x => !['invoke', 'deposit', 'collect', 'price'].includes(x))) throw new AgentError('invalid_policy', '自动操作权限无效。');
  for (const amount of [value.dailySpendToken, value.maxCallToken, value.dailyDepositToken]) if (typeof amount !== 'string') throw new AgentError('invalid_policy', '额度必须使用十进制字符串。'); else parsePaymentAmount(amount);
  if (!Array.isArray(value.models) || value.models.some(x => typeof x !== 'string' || !x.trim() || x.length > 200)) throw new AgentError('invalid_policy', '模型清单无效。');
  const p = value.sellerPrice;
  if (!p || ![p.minimum, p.maximum, p.maxChangePercent, p.minIntervalSeconds].every(x => typeof x === 'number' && Number.isFinite(x)) || p.minimum < 0 || p.maximum < p.minimum || p.maxChangePercent < 0 || p.maxChangePercent > 100 || p.minIntervalSeconds < 1) throw new AgentError('invalid_policy', '最低价、最高价、调价幅度或间隔无效。');
  if (value.allowedActions.includes('invoke') && (parsePaymentAmount(value.maxCallToken) <= 0n || parsePaymentAmount(value.dailySpendToken) < parsePaymentAmount(value.maxCallToken))) throw new AgentError('invalid_policy', '请先设置每日调用预算和单次上限。');
  if (value.allowedActions.includes('deposit') && parsePaymentAmount(value.dailyDepositToken) <= 0n) throw new AgentError('invalid_policy', '请先设置每日自动充值额度。');
  if (value.allowedActions.includes('price') && (p.minimum <= 0 || p.maximum <= 0)) throw new AgentError('invalid_policy', '请先设置卖家最低价和最高价。');
  return value;
}

/** Lock + atomic replacement protect budgets across the controller and owner console. */
export class AgentStore {
  readonly policyPath: string;
  readonly tokenPath: string;
  readonly statePath: string;
  get tokenDisplayPath(): string { return `~/.clawmarket/${path.basename(this.tokenPath)}`; }
  constructor(readonly directory: string, readonly scope: string, private readonly legacyScopes: string[] = []) {
    mkdirSync(directory, { recursive: true });
    const suffix = PAYMENT_TOKEN.symbol.toLowerCase() + (PAYMENT_NETWORK === 'bsc-testnet' ? '-bsc-testnet' : '');
    this.policyPath = path.join(directory, `tam-agent-policy-${suffix}.json`);
    this.tokenPath = path.join(directory, PAYMENT_NETWORK === 'bsc-testnet' ? `tam-agent-token-${suffix}` : 'tam-agent-token');
    this.statePath = path.join(directory, `tam-agent-state-${suffix}.json`);
  }
  token(): string {
    if (!existsSync(this.tokenPath)) { try { writeFileSync(this.tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
    const token = readFileSync(this.tokenPath, 'utf8').trim();
    if (token.length < 32) throw new AgentError('invalid_token', 'AI 接入令牌无效。', 503);
    return token;
  }
  policy(): AgentPolicy {
    return existsSync(this.policyPath) ? validateAgentPolicy(JSON.parse(readFileSync(this.policyPath, 'utf8'))) : defaultAgentPolicy();
  }
  savePolicy(policy: AgentPolicy): void { this.lock(() => this.write(this.policyPath, validateAgentPolicy(policy))); }
  operations(): AgentOperation[] { return this.read().operations; }
  budget(now = new Date()): AgentBudget {
    const day = now.toISOString().slice(0, 10);
    let spent = 0n, reserved = 0n, deposits = 0n, depositReserved = 0n;
    for (const op of this.operations()) {
      const today = op.createdAt.startsWith(day);
      const held = op.status === 'pending' || op.status === 'uncertain';
      if (op.action === 'invoke') { if (today) spent += parsePaymentAmount(op.chargedToken); if (held) reserved += parsePaymentAmount(op.reservedToken); }
      if (op.action === 'deposit') { if (today) deposits += parsePaymentAmount(op.chargedToken); if (held) depositReserved += parsePaymentAmount(op.reservedToken); }
    }
    const remaining = parsePaymentAmount(this.policy().dailySpendToken) - spent - reserved;
    return { day, spentToken: formatPaymentAmount(spent), reservedToken: formatPaymentAmount(reserved), remainingToken: formatPaymentAmount(remaining > 0n ? remaining : 0n), depositedToken: formatPaymentAmount(deposits), depositReservedToken: formatPaymentAmount(depositReserved) };
  }
  begin(request: AgentActionRequest, reserve: string): { operation: AgentOperation; replay: boolean } {
    return this.lock(() => {
      if (!request || typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(request.id) || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new AgentError('invalid_action', '需要唯一操作编号和参数对象。');
      const state = this.read();
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ action: request.action, params: request.params }))).digest('hex');
      const previous = state.operations.find(x => x.id === request.id);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new AgentError('id_conflict', '同一个操作编号不能用于不同参数。', 409); return { operation: previous, replay: true }; }
      if (state.operations.some(op => op.fingerprint === fingerprint && (op.status === 'pending' || op.status === 'uncertain'))) throw new AgentError('duplicate_pending', '同样的操作仍在执行或待核对，请查询原操作编号，勿换编号重试。', 409);
      const policy = this.policy();
      if (policy.paused || !policy.allowedActions.includes(request.action)) throw new AgentError('action_not_allowed', '自动操作已暂停，或主人尚未授权这项操作。', 403);
      const model = request.params.model;
      if (['invoke', 'price'].includes(request.action) && (typeof model !== 'string' || !policy.models.includes(model))) throw new AgentError('model_not_allowed', '模型不在主人允许的清单内。', 403);
      const budget = this.budget();
      if (request.action === 'invoke' && (parsePaymentAmount(reserve) > parsePaymentAmount(policy.maxCallToken) || parsePaymentAmount(reserve) > parsePaymentAmount(budget.remainingToken))) throw new AgentError('budget_exceeded', '调用超出单次或每日预算。', 403);
      if (request.action === 'deposit' && parsePaymentAmount(reserve) + parsePaymentAmount(budget.depositedToken) + parsePaymentAmount(budget.depositReservedToken) > parsePaymentAmount(policy.dailyDepositToken)) throw new AgentError('deposit_budget_exceeded', '充值超出每日自动充值额度。', 403);
      if (request.action === 'price' && state.operations.some(op => op.action === 'price' && op.model === model && op.status !== 'failed' && Date.now() - Date.parse(op.createdAt) < policy.sellerPrice.minIntervalSeconds * 1000)) throw new AgentError('price_interval', '调价过于频繁，请等待主人设置的间隔。', 403);
      if (state.operations.length >= 20_000) throw new AgentError('journal_full', '操作账本已满，请由主人归档后继续。', 503);
      const now = new Date().toISOString();
      const op: AgentOperation = { id: request.id, action: request.action, fingerprint, createdAt: now, updatedAt: now, status: 'pending', message: '正在执行', reason: typeof request.reason === 'string' ? request.reason.slice(0, 160) : '', model: typeof model === 'string' ? model : undefined, reservedToken: reserve, chargedToken: '0' };
      state.operations.push(op); this.write(this.statePath, state); return { operation: op, replay: false };
    });
  }
  finish(id: string, status: AgentOperation['status'], message: string, chargedToken = '0', result?: unknown): AgentOperation {
    return this.lock(() => {
      const state = this.read(), op = state.operations.find(x => x.id === id);
      if (!op) throw new AgentError('missing_operation', '找不到操作记录。', 500);
      if (parsePaymentAmount(chargedToken) > parsePaymentAmount(op.reservedToken) && ['invoke', 'deposit'].includes(op.action)) throw new AgentError('unsafe_amount', '实际金额超过预留额度。', 500);
      Object.assign(op, { status, message, chargedToken, updatedAt: new Date().toISOString(), result });
      if (status === 'succeeded' || status === 'failed') op.reservedToken = '0';
      this.write(this.statePath, state); return op;
    });
  }
  private read(): State {
    if (!existsSync(this.statePath)) return { version: 1, symbol: PAYMENT_TOKEN.symbol, scope: this.scope, operations: [] };
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as State;
    if (state.version !== 1 || state.symbol !== PAYMENT_TOKEN.symbol || (state.scope !== this.scope && !this.legacyScopes.includes(state.scope)) || !Array.isArray(state.operations)) throw new AgentError('state_mismatch', '操作账本与当前钱包或网关不匹配，不能重置预算。', 503);
    for (const op of state.operations) { parsePaymentAmount(op.reservedToken); parsePaymentAmount(op.chargedToken); if (!['pending', 'succeeded', 'failed', 'uncertain'].includes(op.status)) throw new AgentError('invalid_state', '操作账本损坏。', 503); }
    return { ...state, scope: this.scope };
  }
  private write(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}.tmp`, fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    if (process.platform !== 'win32') { const directory = openSync(path.dirname(file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
  }
  private lock<T>(task: () => T): T {
    const directory = `${this.statePath}.lock`;
    try { mkdirSync(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentError('state_busy', '规则或账本正在更新，请稍后重试。', 409); throw e; }
    try { return task(); } finally { rmdirSync(directory); }
  }
}
