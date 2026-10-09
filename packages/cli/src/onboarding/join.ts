import fs from 'node:fs/promises';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PAYMENT_TOKEN, CONTRACTS, parsePaymentAmount, PAYMENT_AGENT_PORT } from '@clawmarket/shared';
import type { CliDefaults } from '../config/store.js';
import { saveCliConfig } from '../config/store.js';
import { readStoredWallet } from '../wallet/store.js';
import { readBalances } from '../services/chain.js';
import { getServiceStatus } from '../services/http.js';
import { loadBuyerSummary } from '../services/buyer.js';
import { loadSellerSummary } from '../services/seller.js';
import { startBuyerRuntime, getDefaultBuyerRuntimeOptions } from '../runtime/buyer-runtime.js';
import { startSellerRuntime, getDefaultSellerRuntimeOptions } from '../runtime/seller-runtime.js';
import { AgentController, agentStoreFor, localAgentBackend } from '../agent/controller.js';
import { runClientUI } from '../web/runtime.js';

type Role = 'buyer' | 'seller' | 'both';
interface JoinProfile { version: 1; role: Role; currency: string; chainId: number; walletAddress: string; market: string; upstreamFile?: string; preparedAt: string }
export interface PrepareJoin { role: Role; model: string; maxCall: string; dailyBudget: string; inputPrice?: string; outputPrice?: string; upstreamFile?: string; market?: string }
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const filename = (config: CliDefaults) => path.join(config.paths.dataDir, 'join-profile.json');
function marketOrigin(value = 'https://shenjige.xyz') { const u = new URL(value); if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('市场地址必须是 HTTPS 根地址，或本机测试地址。'); return u.origin; }
function amount(value: string, name: string) { if (typeof value !== 'string' || !/^\d{1,6}(\.\d{1,8})?$/.test(value) || parsePaymentAmount(value) <= 0n) throw new Error(`${name} 必须是明确的正数，单位是 ${PAYMENT_TOKEN.symbol}。`); return Number(value); }
async function writePrivate(file: string, value: unknown) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = file + '.' + process.pid + '.tmp'; await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temp, file); }
export async function readUpstreamFile(file: string): Promise<{ proxyUrl: string; proxyHeaders?: Record<string, string> }> {
  const full = path.resolve(file), relative = path.relative(process.cwd(), full);
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('模型凭据文件必须放在客户端安装目录之外。');
  if ((await fs.stat(full)).size > 65536) throw new Error('模型配置文件过大。');
  let value: any; try { value = JSON.parse(await fs.readFile(full, 'utf8')); } catch { throw new Error('模型配置 JSON 无效，请检查私有文件；不要在对话里粘贴密钥。'); }
  let u: URL; try { u = new URL(value.proxyUrl); } catch { throw new Error('上游 URL 无效，请检查私有配置文件。'); }
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('上游使用 HTTPS 根地址，或本机 HTTP 根地址；凭据放在请求头。');
  if (value.proxyHeaders != null && (!value.proxyHeaders || Array.isArray(value.proxyHeaders) || typeof value.proxyHeaders !== 'object' || Object.entries(value.proxyHeaders).some(([key, v]) => !/^[a-z0-9-]{1,80}$/i.test(key) || typeof v !== 'string' || /[\r\n\x00]/.test(v) || v.length > 8192 || key.toLowerCase() === 'host'))) throw new Error('上游请求头格式无效。');
  return { proxyUrl: u.origin, proxyHeaders: value.proxyHeaders };
}
export async function prepareJoin(config: CliDefaults, options: PrepareJoin) {
  if (!['buyer', 'seller', 'both'].includes(options.role) || PAYMENT_TOKEN.chainId !== 97) throw new Error('请选择 buyer / seller / both，当前仅支持 BSC 测试网。');
  if (!/^[a-z0-9._:/-]{1,160}$/i.test(options.model)) throw new Error('请指定市场或上游实际支持的模型名。');
  const maxCall = amount(options.maxCall, '单次上限'), daily = amount(options.dailyBudget, '每日上限');
  if (daily < maxCall) throw new Error('每日上限不能小于单次上限。');
  const market = marketOrigin(options.market);
  let input = config.seller.pricing.input, out = config.seller.pricing.output;
  if (options.role !== 'buyer') { input = amount(options.inputPrice!, '输入报价'); out = amount(options.outputPrice!, '输出报价'); if (options.upstreamFile) await readUpstreamFile(options.upstreamFile); }
  await fs.mkdir(path.dirname(config.paths.walletPath), { recursive: true, mode: 0o700 });
  let wallet;
  try { wallet = await readStoredWallet(config.paths.walletPath); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('现有钱包无法读取，已停止；不会覆盖或重新生成。');
    const privateKey = generatePrivateKey(), created = { privateKey, address: privateKeyToAccount(privateKey).address, createdAt: new Date().toISOString() };
    try { await fs.writeFile(config.paths.walletPath, JSON.stringify(created), { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    wallet = await readStoredWallet(config.paths.walletPath);
  }
  if (privateKeyToAccount(wallet.privateKey).address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('钱包地址与密钥不一致，已停止。');
  const next: CliDefaults = { ...config, onboarding: { role: options.role, completedAt: new Date().toISOString() },
    settlement: { ...config.settlement, maxRequestCostToken: maxCall, dailyLimitToken: daily, maxUnconfirmedCreditToken: maxCall },
    buyer: { ...config.buyer, selectedModel: options.model, subscribedModels: [options.model] },
    seller: { ...config.seller, models: [options.model], pricing: { ...config.seller.pricing, input, output: out, p0: (input + out) / 2, alpha: 0, maxConcurrent: 1 } } };
  await saveCliConfig(next, { homeDir: config.paths.homeDir });
  const profile: JoinProfile = { version: 1, role: options.role, chainId: 97, currency: PAYMENT_TOKEN.symbol, walletAddress: wallet.address, market, upstreamFile: options.upstreamFile ? path.resolve(options.upstreamFile) : undefined, preparedAt: new Date().toISOString() };
  await writePrivate(filename(config), profile);
  return { prepared: true, role: profile.role, chainId: 97, currency: PAYMENT_TOKEN.symbol, walletAddress: wallet.address, model: options.model, maxCallToken: options.maxCall, dailyBudgetToken: options.dailyBudget, transactionsSent: 0, automaticPermissionsChanged: false,
    nextSteps: ['Run tam join status.', ...(options.role !== 'seller' ? ['Apply to the chosen seller with tam join apply --seller <wallet>.', 'Get test tokens with tam join claim; get test BNB via the website; fund the pool only after owner approval.'] : []), 'Run tam join start. AI permissions remain controlled by tam agent policy / the owner UI.'], guide: market + '/skill.md' };
}
async function readProfile(config: CliDefaults): Promise<JoinProfile> {
  const p = JSON.parse(await fs.readFile(filename(config), 'utf8')) as JoinProfile;
  const wallet = await readStoredWallet(config.paths.walletPath);
  if (p.version !== 1 || p.chainId !== 97 || p.currency !== PAYMENT_TOKEN.symbol || !['buyer', 'seller', 'both'].includes(p.role) || p.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('接入配置与当前钱包或币种不匹配，请核对配置。');
  marketOrigin(p.market); return p;
}
async function publicApi(origin: string, route: string, body?: unknown) {
  const response = await fetch(origin + route, { redirect: 'error', signal: AbortSignal.timeout(20000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const text = await response.text(); if (text.length > 100000) throw new Error('市场响应过大。'); const result = JSON.parse(text);
  if (!response.ok) { const error = new Error(result.error?.message || '市场请求失败。') as Error & { status: number }; error.status = response.status; throw error; }
  return result;
}
export async function joinStatus(config: CliDefaults) {
  const profile = await readProfile(config);
  const result = await Promise.allSettled([readBalances(profile.walletAddress as `0x${string}`, config.settlement.rpcUrl), loadBuyerSummary(config.buyer.url), loadSellerSummary(config.seller.url)]);
  const value = <T>(i: number): T | null => result[i].status === 'fulfilled' ? (result[i] as PromiseFulfilledResult<T>).value : null;
  const balances = value<Awaited<ReturnType<typeof readBalances>>>(0), buyer = value<Awaited<ReturnType<typeof loadBuyerSummary>>>(1), seller = value<any>(2);
  if (buyer && buyer[1].address.toLowerCase() !== profile.walletAddress.toLowerCase()) throw new Error('本机买家端口属于另一个钱包，请更改 buyer.url 后重新准备。');
  if (seller && seller.seller.walletAddress.toLowerCase() !== profile.walletAddress.toLowerCase()) throw new Error('本机卖家端口属于另一个钱包，请更改 seller.url。');
  return { ...profile, upstreamFile: profile.upstreamFile ? 'configured-private-file' : undefined, balances: balances ? { nativeTbnb: balances.ethFormatted, token: balances.usdcFormatted } : null, buyer: buyer ? { online: true, url: config.buyer.url, availableToken: buyer[1].escrowAvailable } : { online: false, url: config.buyer.url }, seller: { online: !!seller, url: config.seller.url }, agent: { policy: agentStoreFor(config).policy(), budget: agentStoreFor(config).budget() }, guidance: ['Access applications require seller review.', 'Receiving test tokens does not authorize paid calls.', 'Run buyer status and check pool credit before invoking.'], faucetPage: profile.market + '/#faucet' };
}
export async function joinSignedRequest(config: CliDefaults, action: 'apply' | 'claim', sellerAddress?: string) {
  const profile = await readProfile(config), wallet = await readStoredWallet(config.paths.walletPath);
  if (action === 'apply' && (!sellerAddress || !/^0x[a-f0-9]{40}$/i.test(sellerAddress))) throw new Error('请指定卖家钱包地址。');
  const account = privateKeyToAccount(wallet.privateKey), key = action + (sellerAddress ? '-' + sellerAddress.toLowerCase() : '');
  const file = path.join(config.paths.dataDir, key + '.json');
  let saved: any; try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const base = action === 'apply' ? '/api/admission' : '/api/faucet';
  if (saved) {
    if (saved.address !== profile.walletAddress || saved.currency !== profile.currency || saved.origin !== profile.market) throw new Error('已有操作记录与当前配置不匹配，不会自动重建。');
    try { return await publicApi(profile.market, base + (action === 'apply' ? '/requests/' : '/claims/') + saved.id); }
    catch (e) { if ((e as any).status !== 404) throw e; }
  } else {
    const challenge = await publicApi(profile.market, base + '/challenge', { address: wallet.address, currency: PAYMENT_TOKEN.symbol, ...(action === 'apply' ? { sellerAddress } : {}) });
    if (!/^[a-f0-9]{48}$/.test(challenge.id) || challenge.chainId !== 97 || challenge.currency !== PAYMENT_TOKEN.symbol || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now() + 360000) throw new Error('市场签名请求的网络、币种或有效期不正确。');
    const expiry = new Date(challenge.expiresAt).toISOString();
    let expected: string;
    if (action === 'apply') {
      if (challenge.sellerAddress?.toLowerCase() !== sellerAddress!.toLowerCase()) throw new Error('签名中的卖家不匹配。');
      expected = `Tapeout API Market — buyer access application\nWebsite: ${profile.market}\nChain: BSC Testnet (97)\nBuyer: ${wallet.address}\nSeller: ${challenge.sellerAddress}\nCurrency: ${PAYMENT_TOKEN.symbol}\nNonce: ${challenge.id}\nExpires: ${expiry}\nThis signature proves wallet ownership and requests review only. It does not authorize a payment, approve token spending, or grant access. Approved wallet addresses are published in the pilot access list.`;
    } else {
      const claimAmount = PAYMENT_TOKEN.symbol === 'USDC' ? '20' : '100'; if (challenge.amountToken !== claimAmount) throw new Error('测试币领取数量与固定额度不同。');
      expected = `Tapeout API Market — test-token request\nWebsite: ${profile.market}\nChain: BSC Testnet (97)\nWallet: ${wallet.address}\nToken: t${PAYMENT_TOKEN.symbol}\nAmount: ${claimAmount}\nNonce: ${challenge.id}\nExpires: ${expiry}\nThis signature only requests test tokens. It does not approve spending or a payment.`;
    }
    if (challenge.message !== expected) throw new Error('签名内容与本地用途模板不一致，已拒绝签名。');
    saved = { id: challenge.id, address: wallet.address, currency: PAYMENT_TOKEN.symbol, origin: profile.market, expiresAt: challenge.expiresAt, signature: await account.signMessage({ message: expected }) };
    await writePrivate(file, saved);
  }
  return await publicApi(profile.market, base + (action === 'apply' ? '/apply' : '/claim'), { id: saved.id, signature: saved.signature });
}
export async function startJoined(config: CliDefaults, options: { headless?: boolean; open: boolean; uiPort: number; agentPort: number }) {
  const profile = await readProfile(config);
  for (const port of [options.uiPort, options.agentPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('界面与 AI 端口必须在 1–65535 之间。');
  if (profile.role !== 'buyer' && (await getServiceStatus(config.seller.url + '/health', 'seller')).online) {
    const seller = await loadSellerSummary(config.seller.url); if (seller.seller.walletAddress.toLowerCase() !== profile.walletAddress.toLowerCase()) throw new Error('卖家端口属于另一个钱包，请先修改本机端口。');
  }
  if (profile.role !== 'seller') {
    if ((await getServiceStatus(config.buyer.url + '/health', 'buyer')).online) { const [, wallet] = await loadBuyerSummary(config.buyer.url); if (wallet.address.toLowerCase() !== profile.walletAddress.toLowerCase()) throw new Error('买家端口属于另一个钱包，请先修改本机端口。'); }
    await startBuyerRuntime(getDefaultBuyerRuntimeOptions(config));
  }
  if (profile.role !== 'buyer') await startSellerRuntime({ ...getDefaultSellerRuntimeOptions(config), directBackend: profile.upstreamFile ? await readUpstreamFile(profile.upstreamFile) : undefined });
  if (!options.headless && profile.role !== 'seller') await runClientUI(config, { port: options.uiPort, open: options.open });
  else { const controller = new AgentController(agentStoreFor(config), localAgentBackend(config)); const url = await controller.start(options.agentPort); output({ running: true, role: profile.role, aiManagement: url, statusCommand: 'tam join status', automaticPolicy: agentStoreFor(config).policy(), notice: 'Keep this process running. No deposit or invocation was performed.' }); process.once('SIGINT', () => void controller.stop()); process.once('SIGTERM', () => void controller.stop()); }
}
export async function trustJoinedBuyer(config: CliDefaults, address: string, hours: number, revoke = false) {
  const profile = await readProfile(config);
  if (profile.role === 'buyer' || !/^0x[a-f0-9]{40}$/i.test(address) || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('只有卖家可以授权明确的买家钱包，期限为 1–168 小时。');
  const file = path.join(config.paths.dataDir, 'trusted-buyers.json');
  const lock = file + '.lock', handle = await fs.open(lock, 'wx', 0o600);
  try {
  let value = { version: 1, grants: [] as any[] };
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if ((e as any).code !== 'ENOENT') throw e; }
  if (value.version !== 1 || !Array.isArray(value.grants)) throw new Error('现有授权文件无效，已停止。');
  value.grants = value.grants.filter(g => g.address.toLowerCase() !== address.toLowerCase() && g.expiresAt > Date.now());
  if (!revoke) value.grants.push({ address, sellerAddress: profile.walletAddress, currency: PAYMENT_TOKEN.symbol, chainId: 97, poolAddress: config.settlement.escrowPoolAddress, expiresAt: Date.now() + hours * 3600000 });
  await writePrivate(file, value);
  return { buyer: address, currency: PAYMENT_TOKEN.symbol, chainId: 97, approved: !revoke, hours: revoke ? 0 : hours, transactionsSent: 0, notice: 'Only this seller is affected. Approve buyers you have vetted; proof of wallet ownership is not creditworthiness.' };
  } finally { await handle.close(); await fs.unlink(lock); }
}
export { output as printJoinResult, PAYMENT_AGENT_PORT };
