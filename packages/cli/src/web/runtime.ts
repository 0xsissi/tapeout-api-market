import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PAYMENT_TOKEN, PAYMENT_NETWORK_NAME, PAYMENT_NATIVE_SYMBOL, PAYMENT_AGENT_PORT, parsePaymentAmount } from '@clawmarket/shared';
import type { CliDefaults } from '../config/store.js';
import { loadBuyerSummary, loadBuyerNetworkStatus, requestChatStream, executePurchase, executeWithdrawRequest, executeWithdrawCancel, executeWithdrawComplete } from '../services/buyer.js';
import { fetchJson, getServiceStatus } from '../services/http.js';
import { getDefaultBuyerRuntimeOptions, startBuyerRuntime } from '../runtime/buyer-runtime.js';
import { AgentController, agentStoreFor, localAgentBackend } from '../agent/controller.js';
import { startClientServer } from './server.js';

function openBrowser(url: string) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  const child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => console.log('请在浏览器打开上面的本机地址。')); child.unref();
}
export async function runClientUI(config: CliDefaults, options: { port: number; open: boolean }) {
  for (const value of [config.buyer.url, config.seller.url]) {
    const u = new URL(value);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('本机界面只连接本机买家和卖家网关。');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('界面端口必须在 1–65535 之间。');
  const profileId = createHash('sha256').update(`${config.paths.dataDir}|${config.paths.walletPath}|${config.buyer.url}|${config.settlement.escrowPoolAddress}`).digest('hex').slice(0, 24);
  const url = `http://127.0.0.1:${options.port}`;
  try {
    const health = await fetchJson<{ product: string; profileId: string }>(url + '/health', { timeoutMs: 1000 });
    if (health.product === 'Tapeout API Market Client' && health.profileId === profileId) { console.log(`TAM 客户端已运行：${url}`); if (options.open) openBrowser(url); return; }
    throw new Error('该端口已被其他应用或付款配置占用，请使用其他 --port。');
  } catch (error) { if (error instanceof Error && error.message.includes('该端口')) throw error; }
  const store = agentStoreFor(config), controller = new AgentController(store, localAgentBackend(config));
  let agentStarted = false;
  try { await controller.start(); agentStarted = true; } catch { /* an existing controller keeps the same owner policy */ }
  const backend = {
    profileId,
    currencyDecimals: PAYMENT_TOKEN.decimals,
    async status() {
      const service = await getServiceStatus(config.buyer.url + '/health', 'buyer');
      let wallet = null, network = null, issue: string | null = null;
      if (service.online) {
        const result = await Promise.allSettled([loadBuyerSummary(config.buyer.url), loadBuyerNetworkStatus(config.buyer.url)]);
        if (result[0].status === 'fulfilled') wallet = result[0].value[1]; else issue = '余额暂未读取成功，请稍后刷新。';
        if (result[1].status === 'fulfilled') network = result[1].value;
      }
      return { product: 'Tapeout API Market', profileId, payment: { symbol: PAYMENT_TOKEN.symbol, displaySymbol: 't' + PAYMENT_TOKEN.symbol, decimals: PAYMENT_TOKEN.decimals, chainId: PAYMENT_TOKEN.chainId, network: PAYMENT_NETWORK_NAME, nativeSymbol: PAYMENT_NATIVE_SYMBOL },
        buyer: { online: service.online, url: config.buyer.url, wallet, issue }, network, selectedModel: config.buyer.selectedModel,
        agent: { url: `http://127.0.0.1:${PAYMENT_AGENT_PORT}`, policy: store.policy(), budget: store.budget(), recentOperations: store.operations().slice(-10).map(op => ({ id: op.id, action: op.action, message: op.message, status: op.status, createdAt: op.createdAt, chargedToken: op.chargedToken })) },
        limits: { maxRequestCostToken: config.settlement.maxRequestCostToken, dailyLimitToken: config.settlement.dailyLimitToken } };
    },
    async chat(input: Parameters<Parameters<typeof startClientServer>[0]['backend']['chat']>[0], onDelta: (delta: string) => void) {
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 180000);
      try { return await requestChatStream({ url: config.buyer.url, model: input.model, messages: input.messages, signal: abort.signal, maxTokens: 4096 }, { onDelta }); }
      finally { clearTimeout(timer); }
    },
    async transaction(action: string, amount?: string) {
      if (amount && parsePaymentAmount(amount) <= 0n) throw new Error('金额必须大于零，并符合当前代币精度。');
      if (action === 'deposit') return executePurchase(config.buyer.url, amount!);
      if (action === 'withdraw-request') return executeWithdrawRequest(config.buyer.url, amount!);
      if (action === 'withdraw-cancel') return executeWithdrawCancel(config.buyer.url);
      if (action === 'withdraw-complete') return executeWithdrawComplete(config.buyer.url);
      throw new Error('不支持这个交易操作。');
    },
    async startBuyer() { await startBuyerRuntime({ ...getDefaultBuyerRuntimeOptions(config), report: () => {} }); },
    policy(value: any) {
      const previous = store.policy(); const keys = ['paused', 'allowedActions', 'dailySpendToken', 'maxCallToken', 'dailyDepositToken', 'models'];
      if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('不支持这个规则字段。');
      store.savePolicy({ ...previous, ...value });
    },
  };
  try {
    const client = await startClientServer({ backend, directory: path.join(config.paths.dataDir, 'client-ui'), port: options.port });
    console.log(`TAM 本机客户端：${client.url}`);
    console.log('浏览器页面可关闭；请保留这个后台进程。已有买家、钱包和 AI 权限继续使用原配置。');
    process.once('SIGINT', () => { void client.stop(); if (agentStarted) void controller.stop(); });
    process.once('SIGTERM', () => { void client.stop(); if (agentStarted) void controller.stop(); });
    if (options.open) openBrowser(client.url);
  } catch (error) { if (agentStarted) await controller.stop(); throw error; }
}
