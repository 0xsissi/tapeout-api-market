import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { CONTRACTS, PAYMENT_TOKEN, PAYMENT_AGENT_PORT, PAYMENT_NETWORK_NAME, PAYMENT_NATIVE_SYMBOL, parsePaymentAmount, type AgentActionRequest } from '@clawmarket/shared';
import type { CliDefaults } from '../config/store.js';
import { fetchJson, fetchWithTimeout } from '../services/http.js';
import { AgentError, AgentStore } from './store.js';
import { assertGatewaySettlement, checkGatewaySettlement } from '../payment/gateway.js';

export interface AgentBackend {
  status(): Promise<{ buyer: any; seller: any; network: any }>;
  execute(request: AgentActionRequest, maxCallToken: string): Promise<any>;
}
export function agentStoreFor(config: CliDefaults): AgentStore {
  const prefix = `${config.paths.walletPath}|${config.buyer.url}|${config.seller.url}|${PAYMENT_TOKEN.chainId}|`;
  const aliases = PAYMENT_TOKEN.symbol === 'USDC' && PAYMENT_TOKEN.chainId === 84532 && config.settlement.escrowPoolAddress.toLowerCase() === '0x8a392a77eb88f477fef060033937a2e4692eb56e' ? [`${prefix}default`] : [];
  // Keep existing journals in place; filenames already separate the two currencies.
  return new AgentStore(path.join(config.paths.homeDir, '.clawmarket'), `${prefix}${config.settlement.escrowPoolAddress}`, aliases);
}
export function localAgentBackend(config: CliDefaults): AgentBackend {
  const validateLocalUrl = (value: string) => { const u = new URL(value); if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.username || u.password) throw new AgentError('nonlocal_gateway', 'AI 管理入口只连接本机买家和卖家网关。'); return value.replace(/\/$/, ''); };
  const buyer = validateLocalUrl(config.buyer.url), seller = validateLocalUrl(config.seller.url);
  const read = async (url: string) => { try { const data = await fetchJson(url, { timeoutMs: 2_000 }); assertGatewaySettlement(data, config.settlement.escrowPoolAddress); return data; } catch { return null; } };
  return {
    async status() { const [b, s, n] = await Promise.all([read(`${buyer}/v1/credits`), read(`${seller}/v1/seller/status`), read(`${buyer}/v1/network/status`)]); return { buyer: b, seller: s, network: n }; },
    async execute(request, maxCallToken) {
      try { await checkGatewaySettlement(request.action === 'invoke' || request.action === 'deposit' ? buyer : seller, request.action === 'invoke' || request.action === 'deposit' ? 'buyer' : 'seller', config.settlement.escrowPoolAddress); }
      catch (error) { throw new AgentError('payment_mismatch', error instanceof Error ? error.message : '无法核对网关结算配置，已停止操作。', 409); }
      let url: string, body: unknown;
      switch (request.action) {
        case 'invoke': url = `${buyer}/v1/chat/completions`; body = { ...request.params, stream: false, max_cost_token: maxCallToken }; break;
        case 'deposit': url = `${buyer}/v1/credits/purchase`; body = { amountToken: request.params.amountToken }; break;
        case 'collect': url = `${seller}/v1/seller/claims/flush`; body = {}; break;
        case 'price': url = `${seller}/v1/seller/pricing`; body = request.params; break;
        default: throw new AgentError('invalid_action', '不支持的操作。');
      }
      const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 180_000);
      const result = await response.json() as any;
      if (!response.ok) {
        const kind = result?.error?.type ?? result?.error;
        if (typeof kind === 'string' && ['invalid_request', 'budget_exceeded', 'service_unavailable', 'action_not_allowed', 'invalid_pricing', 'local_token_required'].includes(kind)) throw new AgentError(kind, result?.error?.message ?? result?.message ?? '操作未执行。', response.status);
        throw new Error('网关未确认操作结果，请检查余额和交易记录，勿换编号重复执行。');
      }
      return result;
    },
  };
}

export class AgentController {
  private server: http.Server | null = null;
  private active = 0;
  constructor(readonly store: AgentStore, private readonly backend: AgentBackend) {}
  async status() {
    const sources = await this.backend.status();
    return { product: 'Tapeout API Market', payment: { symbol: PAYMENT_TOKEN.symbol, decimals: PAYMENT_TOKEN.decimals, network: PAYMENT_NETWORK_NAME, chainId: PAYMENT_TOKEN.chainId, nativeSymbol: PAYMENT_NATIVE_SYMBOL }, policy: this.store.policy(), budget: this.store.budget(), buyer: sources.buyer, seller: sources.seller, network: sources.network, recentOperations: this.store.operations().slice(-20).reverse(), notice: '预算与权限适用于本 AI 管理入口；原有本地网关令牌属于主人权限。每日预算按 UTC 日计算，未确认操作继续预留额度。' };
  }
  async execute(request: AgentActionRequest) {
    if (!request || !['invoke', 'deposit', 'collect', 'price'].includes(request.action) || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new AgentError('invalid_action', '需要有效的操作名称和参数对象。');
    const policy = this.store.policy();
    let reserved = '0';
    if (request.action === 'invoke') reserved = policy.maxCallToken;
    if (request.action === 'deposit') {
      if (typeof request.params?.amountToken !== 'string' || parsePaymentAmount(request.params.amountToken) <= 0n) throw new AgentError('invalid_amount', '充值金额必须是正的十进制字符串。');
      reserved = request.params.amountToken;
    }
    // All financial and price operations enter the persistent journal before calling a gateway.
    const started = this.store.begin(request, reserved);
    if (started.replay) return { operation: started.operation, replay: true };
    let submitted = false;
    try {
      if (request.action === 'price') await this.validatePrice(request);
      const executable = request.action === 'price' ? { ...request, params: { ...request.params, maximum: policy.sellerPrice.maximum } } : request;
      submitted = true;
      const result = await this.backend.execute(executable, policy.maxCallToken);
      if (request.action === 'collect' && !result.flushed && result.claims?.queuedCount > 0) throw new Error('尚有待结算收入，但网关未确认收款。');
      const charged = request.action === 'deposit' ? reserved : request.action === 'invoke' ? result?.tamSettlement?.amountToken : '0';
      if (typeof charged !== 'string') throw new Error('调用已返回，但缺少可验证的费用状态，请人工核对。');
      // Never store API prompts, response text, credentials or signing keys in the activity log.
      const receipt = request.action === 'invoke' ? { requestId: result.id, amountToken: charged, seller: result.tamSettlement.seller } : request.action === 'deposit' ? { approvalTx: result.approvalTx, depositTx: result.depositTx, amountToken: reserved } : result;
      const operation = this.store.finish(request.id, 'succeeded', ({ invoke: '调用完成，费用已确认', deposit: '充值已确认，可用预算已增加', collect: result.flushed ? '收款已确认，请查看钱包余额' : '当前没有可结算收入', price: '报价规则已更新，后续报价生效' } as const)[request.action], charged, receipt);
      return { operation, result, replay: false };
    } catch (error) {
      const known = error instanceof AgentError && (!submitted || ['invalid_request', 'budget_exceeded', 'service_unavailable', 'action_not_allowed', 'invalid_pricing', 'local_token_required', 'payment_mismatch'].includes(error.code));
      const message = known ? error.message : '结果尚未确认，已保留操作编号和额度。请查看链上记录后由主人处理，勿自动重试。';
      return { operation: this.store.finish(request.id, known ? 'failed' : 'uncertain', message), replay: false };
    }
  }
  private async validatePrice(request: AgentActionRequest) {
    const policy = this.store.policy(), p = policy.sellerPrice;
    const { model, p0, alpha } = request.params;
    if (typeof p0 !== 'number' || !Number.isFinite(p0) || p0 < p.minimum || p0 > p.maximum || (alpha != null && (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha > 5))) throw new AgentError('price_out_of_bounds', '报价超过主人设置的范围，或调价参数无效。', 403);
    const status = await this.backend.status();
    const current = status.seller?.backend?.models?.find((m: any) => m.model === model);
    if (!current) throw new AgentError('model_unavailable', '卖家服务尚未启动，或模型没有上架。', 409);
    const base = current.p0 ?? Math.max(current.inputPer1m, current.outputPer1m);
    if (base <= 0 || Math.abs(p0 - base) > base * p.maxChangePercent / 100 + 1e-10) throw new AgentError('price_change_too_large', '单次调价幅度超过主人设置的范围。', 403);
  }
  async start(port = PAYMENT_AGENT_PORT): Promise<string> {
    if (this.server) throw new AgentError('already_running', 'AI 管理入口已启动。');
    const token = this.store.token();
    this.server = http.createServer((req, res) => { void this.handle(req, res, token).catch((error) => { if (!res.headersSent) this.json(res, error instanceof AgentError ? error.status : 503, { error: { code: error instanceof AgentError ? error.code : 'management_unavailable', message: error instanceof AgentError ? error.message : '规则或账本读取失败，已停止执行。' } }); }); });
    this.server.requestTimeout = 30_000; this.server.headersTimeout = 10_000; this.server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> { const server = this.server; this.server = null; if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
    const port = (this.server!.address() as AddressInfo).port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host ?? '') || req.headers.origin) throw new AgentError('forbidden_origin', 'AI 管理接口仅接受本机程序请求。', 403);
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? ''), expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AgentError('unauthorized', '需要 AI 管理令牌；该令牌不是钱包私钥。', 401);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/tam/status') { this.json(res, 200, await this.status()); return; }
    if (req.method === 'GET' && url.pathname === '/v1/tam/tools') { this.json(res, 200, agentTools()); return; }
    if (req.method === 'GET' && url.pathname === '/v1/tam/operations') { this.json(res, 200, { operations: this.store.operations().slice(-100).reverse() }); return; }
    if (req.method === 'POST' && url.pathname === '/v1/tam/actions') {
      if (this.active >= 8) throw new AgentError('busy', '正在处理较多操作，请稍后查询状态。', 429);
      ++this.active;
      try {
        let text = ''; for await (const chunk of req) { text += chunk.toString(); if (Buffer.byteLength(text) > 262_144) throw new AgentError('body_too_large', '操作内容过大。', 413); }
        let body: AgentActionRequest; try { body = JSON.parse(text); } catch { throw new AgentError('invalid_json', '操作必须使用 JSON。'); }
        this.json(res, 200, await this.execute(body));
      } finally { --this.active; }
      return;
    }
    throw new AgentError('not_found', '未找到接口；AI 不能修改主人的规则。', 404);
  }
  private json(res: http.ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
}
export function agentTools() {
  const actions = [
    { name: 'invoke', description: '按主人预算调用 API，费用在完整交付后确认。', parameters: { type: 'object', properties: { model: { type: 'string' }, messages: { type: 'array', minItems: 1, items: { type: 'object' } }, max_tokens: { type: 'integer', minimum: 1 } }, required: ['model', 'messages'] } },
    { name: 'deposit', description: '将钱包代币充值为可用预算；需要主人授权和每日充值额度。', parameters: { type: 'object', properties: { amountToken: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$', description: '正的代币数量，使用十进制字符串。' } }, required: ['amountToken'], additionalProperties: false } },
    { name: 'collect', description: '将已确认收入批量结算到卖家钱包。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'price', description: '调整模型底价，在主人范围、幅度和间隔内执行。', parameters: { type: 'object', properties: { model: { type: 'string' }, p0: { type: 'number', exclusiveMinimum: 0, description: '结算代币数量/百万推理 Token。' }, alpha: { type: 'number', minimum: 0, maximum: 5 } }, required: ['model', 'p0'], additionalProperties: false } },
  ];
  const functionTools = actions.map(action => ({ type: 'function', function: { name: `tam_${action.name}`, description: action.description, parameters: { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$', description: '唯一操作编号；不确定时查询这个编号，不能换编号重试。' }, reason: { type: 'string', maxLength: 160, description: '简短说明原因，不包含密钥或聊天正文。' }, params: action.parameters }, required: ['id', 'params'], additionalProperties: false } } }));
  return { version: 1, status: 'GET /v1/tam/status', operations: 'GET /v1/tam/operations', endpoint: 'POST /v1/tam/actions', actions, functionTools, request: { id: 'unique operation id, reuse for status lookup; never use a new id to retry an uncertain payment', action: 'action name', reason: 'short explanation without secrets or prompt contents', params: 'parameters' }, rules: 'Only the owner console or local CLI can edit rules. Observe operation.status, not only HTTP status. Map tam_<action> tool calls to POST {id, action, reason, params}.' };
}
