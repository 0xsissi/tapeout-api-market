import { initI18n, setText, textNode, locale, onLanguageChange, t, stabilizeLocalizedLayout } from './i18n.js';
import { networkSnapshot, createCatalogRefresher } from './market-network.js';
import { initProjectBrief } from './project-brief.js';
await initI18n();

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { catalog: null, currency: 'all', wallet: null, provider: null, faucet: null, claiming: false, detail: null };
const labels = { market: 'API 市场', about: '项目介绍', nodes: '网络节点', faucet: '领取测试币', guide: '快速开始', ai: 'AI 接入' };
const pendingKey = 'tam-test-claim-v1';
let toastTimer, polling = false, lastMarketRefresh = null;
function element(tag, text, className, raw = false) {
  const node = document.createElement(tag);
  if (raw) node.dataset.i18nRaw = '';
  if (text !== undefined) { if (raw) node.textContent = text; else setText(node, text); }
  if (className) node.className = className;
  return node;
}
function short(value) { return value ? `${value.slice(0, 7)}…${value.slice(-5)}` : '—'; }
function time(value) { return value ? new Date(value).toLocaleTimeString(locale(), { hour12: false }) : '—'; }
function toast(message) { setText($('#toast'), message); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000); }
async function api(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message || '服务暂时不可用，请稍后再试。'); error.status = response.status; throw error; }
  return data;
}
function page(name) {
  if (!Object.hasOwn(labels, name)) name = 'about';
  const previousPage = $('.page:not([hidden])')?.id;
  $$('.page').forEach(node => { node.hidden = node.id !== `page-${name}`; });
  $$('[data-page]').forEach(node => { const active = node.dataset.page === name; node.classList.toggle('active', active); node.setAttribute('aria-current', active ? 'page' : 'false'); });
  setText($('#breadcrumb-page'), labels[name]);
  if (location.hash !== `#${name}`) location.hash = name;
  if (previousPage !== `page-${name}`) { stabilizeLocalizedLayout(); window.scrollTo(0, 0); }
}
$$('[data-page], [data-go]').forEach(button => button.addEventListener('click', () => page(button.dataset.page || button.dataset.go)));
window.addEventListener('hashchange', () => page(location.hash.slice(1)));
page(location.hash.slice(1));
$$('[data-browse]').forEach(button => button.addEventListener('click', () => {
  $('#market-list').scrollIntoView({ block: 'start' });
  $('#search').focus({ preventScroll: true });
}));
$('#show-gas').addEventListener('click', () => {
  $('#gas-help').open = true;
  $('#gas-help').scrollIntoView({ block: 'start' });
  $('#gas-help > summary').focus({ preventScroll: true });
});

function detail(seller, model) {
  state.detail = { seller, model };
  const container = $('#detail-content'); container.replaceChildren(element('h2', model.model, undefined, true), element('p', '卖家公告 · BSC 测试网', 'subtitle'));
  const dl = element('dl', undefined, 'detail-list');
  for (const [label, value] of [
    ['网络', `${t(seller.networkName)} / Chain ${seller.chainId}`], ['报价与收款', seller.tokenSymbol], ['卖家钱包', seller.walletAddress],
    ['代币合约', seller.tokenAddress], ['结算池', seller.poolAddress], ['P2P 节点', seller.peerId], ['并发上限', seller.maxConcurrent ?? '未声明'],
    ['公告时间', new Date(seller.announcementAt).toLocaleString(locale(), { hour12: false })], ['最近读取', time(seller.observedAt)],
  ]) { const row = element('div'); row.append(element('dt', label), element('dd', value)); dl.append(row); }
  container.append(dl, element('div', '在 TAM 客户端连接卖家，使用同币种的测试币结算。', 'notice'));
  const copy = element('button', '复制卖家节点地址', 'text-button');
  copy.disabled = !seller.multiaddrs.length;
  copy.addEventListener('click', () => copyText(seller.multiaddrs.join('\n'))); container.append(copy);
  if (!$('#seller-detail').open) $('#seller-detail').showModal();
}
$('#close-detail').addEventListener('click', () => { $('#seller-detail').close(); state.detail = null; });
function renderMarket() {
  if (!state.catalog) return;
  const { sellers, stats, observedAt } = state.catalog;
  setText($('#stat-sellers'), stats.visibleSellers); setText($('#nav-sellers'), stats.visibleSellers);
  setText($('#stat-models'), stats.models); setText($('#stat-nodes'), stats.onlineNodes);
  for (const [key, value] of Object.entries({ sellers: stats.visibleSellers, models: stats.models, nodes: stats.onlineNodes })) setText($(`[data-brief-metric="${key}"]`), value);
  setText($('#last-updated'), observedAt ? `最近观察 ${time(observedAt)}` : '正在连接卖家…');
  const search = $('#search').value.trim().toLowerCase();
  let rows = sellers.flatMap(seller => seller.models.map(model => ({ seller, model }))).filter(({ seller, model }) =>
    seller.chainId === 97 && (state.currency === 'all' || seller.currency === state.currency) &&
    (!search || [seller.walletAddress, seller.peerId, model.model].some(value => value.toLowerCase().includes(search))));
  if ($('#sort').value === 'price') {
    const groups = new Set(rows.map(({ seller }) => `${seller.chainId}:${seller.currency}`));
    if (groups.size > 1) { $('#sort').value = 'recent'; toast('请先选择 USDC 或 BEM，再比较同币种的价格。'); }
    else rows.sort((a, b) => a.model.inputPer1m - b.model.inputPer1m);
  }
  if ($('#sort').value === 'recent') rows.sort((a, b) => b.seller.observedAt - a.seller.observedAt);
  const tbody = $('#seller-rows'); tbody.replaceChildren();
  for (const { seller, model } of rows) {
    const tr = element('tr'), modelCell = element('td');
    modelCell.append(element('div', model.model, 'model-name', true));
    if (model.dynamic) modelCell.append(element('div', '随负载调价 · 显示底价', 'seller-address'));
    const sellerCell = element('td', short(seller.walletAddress), 'seller-address', true); sellerCell.title = seller.walletAddress;
    const prices = [model.inputPer1m, model.outputPer1m].map(value => {
      const td = element('td', undefined, 'price-cell');
      td.append(element('div', value.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 8 }), 'price', true));
      return td;
    });
    const settlement = element('td'); settlement.append(element('span', seller.currency, `currency-badge ${seller.currency === 'USDC' ? 'usdc' : 'bem'}`));
    const status = element('td'), badge = element('div', undefined, `online ${seller.status === 'reachable' ? '' : 'stale'}`);
    badge.append(textNode(seller.status === 'reachable' ? '可连接' : '较久未见')); status.append(badge);
    const action = element('td'), button = element('button', '查看', 'row-action'); button.addEventListener('click', () => detail(seller, model)); action.append(button);
    tr.append(modelCell, sellerCell, ...prices, settlement, status, action); tbody.append(tr);
  }
  $('#market-empty').hidden = rows.length > 0;
  if (!rows.length) {
    setText($('#market-empty h3'), observedAt ? '没有匹配的卖家' : '正在查找卖家…');
    setText($('#market-empty p'), observedAt ? '试试其他模型或币种。' : '请稍候。');
  }
}
for (const event of ['input', 'change']) $('#search').addEventListener(event, renderMarket);
$('#sort').addEventListener('change', renderMarket);
$$('[data-currency]').forEach(button => button.addEventListener('click', () => { state.currency = button.dataset.currency; $$('[data-currency]').forEach(node => node.classList.toggle('selected', node === button)); renderMarket(); }));
function renderNodes() {
  if (!state.catalog) return;
  const { nodes, sellers } = networkSnapshot(state.catalog);
  setText($('#network-updated'), `页面刷新 ${time(lastMarketRefresh)} · 卖家观察 ${time(state.catalog.observedAt)}`);
  setText($('#network-entry-count'), `${nodes.filter(node => node.status === 'online').length} 个入口在线`);
  setText($('#network-seller-count'), `${sellers.filter(seller => seller.status === 'reachable').length} 个卖家可连接`);
  $('#node-cards').replaceChildren();
  for (const node of nodes) {
    const card = element('article', undefined, 'node-card'), heading = element('div', undefined, 'node-title');
    const badge = element('span', node.status === 'online' ? '在线' : node.status === 'checking' ? '检查中' : node.status === 'stale' ? '较久未见' : '暂不可连接', node.status === 'online' ? 'online' : 'stale');
    const knownName = { 'node-a': '入口节点 A', 'node-b': '入口节点 B' }[node.id];
    heading.append(element('h2', knownName || node.name, undefined, !knownName), badge); card.append(heading, element('div', node.host, 'host', true));
    const dl = element('dl');
    for (const [label, value] of [['角色', '发现入口 / 连接中继'], ['健康接口耗时', node.latencyMs === undefined ? '—' : `${node.latencyMs} ms`], ['当前连接', node.connections ?? '—'], ['P2P / WebSocket', '9090 / 9091'], ['最近检查', time(node.checkedAt)]]) {
      const row = element('div'); row.append(element('dt', label), element('dd', value)); dl.append(row);
    }
    card.append(dl); const link = element('a', '查看入口配置 ↗'); link.href = `http://${node.host}:9092/bootstrap.json`; link.target = '_blank'; link.rel = 'noreferrer'; card.append(link);
    $('#node-cards').append(card);
  }
  $('#seller-node-cards').replaceChildren();
  for (const seller of sellers) {
    const card = element('article', undefined, 'node-card seller-node-card'), heading = element('div', undefined, 'node-title');
    card.dataset.peerId = seller.peerId;
    heading.append(element('h2', '卖家节点'), element('span', seller.status === 'reachable' ? '可连接' : '较久未见', seller.status === 'reachable' ? 'online' : 'stale'));
    const wallet = element('div', short(seller.walletAddress), 'host', true); wallet.title = seller.walletAddress;
    card.append(heading, wallet);
    const addresses = seller.multiaddrs ?? [];
    const hasRelay = addresses.some(address => address.includes('/p2p-circuit/'));
    const hasDirect = addresses.some(address => !address.includes('/p2p-circuit'));
    const connection = hasRelay && hasDirect ? '直连 / 中继' : hasRelay ? '通过中继' : hasDirect ? '直接连接' : '未声明';
    const dl = element('dl');
    for (const [label, value, raw] of [
      ['提供模型', seller.models.map(model => model.model).join(', '), true],
      ['报价与收款', seller.tokenSymbol || seller.currency, true], ['连接方式', connection, false],
      ['P2P 节点', short(seller.peerId), true], ['最近公告', time(seller.announcementAt), true], ['最近读取', time(seller.observedAt), true],
    ]) { const row = element('div'); row.append(element('dt', label), element('dd', value, undefined, raw)); dl.append(row); }
    card.append(dl);
    const button = element('button', '查看服务与价格 →', 'text-button');
    button.addEventListener('click', () => {
      $('#search').value = seller.walletAddress; state.currency = 'all';
      $$('[data-currency]').forEach(node => node.classList.toggle('selected', node.dataset.currency === 'all'));
      renderMarket(); page('market');
    });
    card.append(button); $('#seller-node-cards').append(card);
  }
  $('#seller-nodes-empty').hidden = sellers.length > 0;
}
const refreshMarket = createCatalogRefresher({
  read: () => api('/api/market'),
  onCatalog: catalog => { state.catalog = catalog; lastMarketRefresh = Date.now(); renderMarket(); renderNodes(); },
  onBusy: busy => $$('[data-refresh-market]').forEach(button => { button.disabled = busy; button.setAttribute('aria-busy', String(busy)); setText(button, busy ? '正在刷新…' : '刷新'); }),
  onError: () => {
    renderNodes();
    setText($('#network-updated'), lastMarketRefresh ? `刷新失败，显示上次数据 ${time(lastMarketRefresh)}` : '网络连接暂不可用，请点击刷新重试。');
    setText($('#last-updated'), '暂时无法读取市场');
    if (!state.catalog) { setText($('#market-empty h3'), '市场连接暂不可用'); setText($('#market-empty p'), '请稍后刷新页面。'); }
  },
});
$$('[data-refresh-market]').forEach(button => button.addEventListener('click', refreshMarket));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshMarket(); });

async function connectWallet() {
  const provider = window.ethereum;
  if (!provider) throw new Error('请在装有浏览器钱包的 Chrome 或 Edge 中打开此网站，或者通过 AI 接口领取。');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('请先解锁钱包。');
  state.provider = provider; setWallet(accounts[0]); return provider;
}
function setWallet(address) { state.wallet = address || null; setText($('#wallet-connect'), address ? `${short(address)} ↗` : '连接钱包 ↗'); }
window.ethereum?.on?.('accountsChanged', accounts => setWallet(accounts[0]));
window.ethereum?.on?.('disconnect', () => setWallet(null));
$('#wallet-connect').addEventListener('click', () => connectWallet().catch(error => toast(errorMessage(error))));
$('#gas-network').addEventListener('click', async () => { try { await connectWallet(); await testNetwork(); toast('钱包已切换到 BSC 测试网（Chain 97）。'); } catch (error) { toast(errorMessage(error)); } });
$('#gas-copy-address').addEventListener('click', async () => { try { await connectWallet(); await copyText(state.wallet); } catch (error) { toast(errorMessage(error)); } });
function errorMessage(error) { return [4001, 'ACTION_REJECTED'].includes(error.code) ? '你取消了钱包确认，可以稍后重试。' : error.message || '操作未完成，请稍后再试。'; }
async function testNetwork() {
  const provider = state.provider || await connectWallet();
  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== 97n) {
    try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x61' }] }); }
    catch (error) {
      if (Number(error.code) !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x61', chainName: 'BSC Testnet', nativeCurrency: { name: 'Test BNB', symbol: 'tBNB', decimals: 18 }, rpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org'], blockExplorerUrls: ['https://testnet.bscscan.com'] }] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x61' }] });
    }
  }
  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== 97n) throw new Error('请把钱包切换到 BSC 测试网后再继续。');
  return provider;
}
async function refreshFaucet() {
  try {
    state.faucet = await api('/api/faucet');
    setText($('#faucet-status'), state.faucet.enabled ? '领币服务可用' : '领币服务暂不可用，请稍后再试。');
  } catch { state.faucet = null; setText($('#faucet-status'), '暂时无法连接领币服务，请稍后再试。'); }
  claimButtons();
}
function claimButtons() { $$('[data-claim]').forEach(button => { button.disabled = state.claiming || !state.faucet?.enabled; }); }
function storePending(value) { try { if (value) localStorage.setItem(pendingKey, JSON.stringify({ id: value.id, txHash: value.txHash })); else localStorage.removeItem(pendingKey); } catch { /* browser storage is optional */ } }
function claimResult(value) {
  const box = $('#claim-result'); box.hidden = false; box.replaceChildren();
  const messages = { confirmed: `已确认：${value.amountToken} ${state.faucet?.assets[value.currency]?.symbol || value.currency} 已发送到 ${short(value.address)}。`, pending: '交易已提交，正在等待链上确认。请查询同一个领取编号。', reverted: '这笔交易未成功，未确认到账。请保留交易链接并联系项目方。' };
  box.append(textNode(messages[value.status] || '正在查询交易…'));
  if (/^0x[0-9a-f]{64}$/i.test(value.txHash || '')) { const link = element('a', '查看链上交易 ↗'); link.href = `https://testnet.bscscan.com/tx/${value.txHash}`; link.target = '_blank'; link.rel = 'noreferrer'; box.append(link); }
  if (value.status === 'pending') { const button = element('button', '继续查询', 'text-button'); button.addEventListener('click', () => watchClaim(value.id)); box.append(button); }
}
async function watchClaim(id) {
  if (polling) return; polling = true;
  try {
    for (let i = 0; i < 20; i++) {
      const result = await api(`/api/faucet/claims/${id}`); claimResult(result);
      if (result.status !== 'pending') { storePending(null); return; }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch { toast('暂时无法确认领取结果。请保留当前页面，继续查询同一笔交易。'); }
  finally { polling = false; }
}
$$('[data-claim]').forEach(button => button.addEventListener('click', async () => {
  if (state.claiming) return; state.claiming = true; claimButtons();
  let challenge, signature, submitted = false;
  try {
    await connectWallet(); const provider = await testNetwork(), address = state.wallet;
    challenge = await api('/api/faucet/challenge', { address, currency: button.dataset.claim });
    const bytes = new TextEncoder().encode(challenge.message), hex = '0x' + [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
    signature = await provider.request({ method: 'personal_sign', params: [hex, address] });
    submitted = true; storePending({ id: challenge.id });
    const result = await api('/api/faucet/claim', { id: challenge.id, signature });
    claimResult(result); storePending(result.status === 'pending' ? result : null);
    if (result.status === 'pending') await watchClaim(result.id);
  } catch (error) {
    toast(errorMessage(error));
    if (submitted && challenge && (!error.status || error.status >= 500)) {
      $('#claim-result').hidden = false; $('#claim-result').replaceChildren(textNode('提交结果暂未确认，请先查询这次领取；不要重复申请。'));
      const query = element('button', '查询领取结果', 'text-button'); query.addEventListener('click', () => watchClaim(challenge.id)); $('#claim-result').append(query);
      const retry = element('button', '重试同一笔申请', 'text-button'); retry.addEventListener('click', async () => { retry.disabled = true; try { const result = await api('/api/faucet/claim', { id: challenge.id, signature }); claimResult(result); storePending(result.status === 'pending' ? result : null); if (result.status === 'pending') watchClaim(result.id); } catch (error) { toast(errorMessage(error)); } finally { retry.disabled = false; } }); $('#claim-result').append(retry);
    } else if (submitted) storePending(null);
  } finally { state.claiming = false; claimButtons(); refreshFaucet(); }
}));
$$('[data-token]').forEach(button => button.addEventListener('click', async () => {
  try { if (!state.faucet) await refreshFaucet(); const asset = state.faucet?.assets[button.dataset.token]; if (!asset) throw new Error('无法读取代币配置。'); await connectWallet(); const provider = await testNetwork(); await provider.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: asset.address, symbol: asset.symbol, decimals: asset.decimals } } }); }
  catch (error) { toast(errorMessage(error)); }
}));
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('已复制。'); } catch { toast('浏览器未允许复制，请手动选择文本。'); } }
$('#copy-api').addEventListener('click', () => copyText(`${location.origin}/api/market`));
$('#copy-ai-prompt').addEventListener('click', () => copyText($('#ai-prompt').textContent));
setText($('#api-code'), `GET ${location.origin}/api/market`);
refreshMarket(); refreshFaucet();
setInterval(() => { if (!document.hidden) refreshMarket(); }, 15000); setInterval(refreshFaucet, 30000);
try { const saved = JSON.parse(localStorage.getItem(pendingKey) || 'null'); if (/^[a-f0-9]{48}$/.test(saved?.id || '')) watchClaim(saved.id); } catch { /* no pending browser claim */ }

initProjectBrief();

onLanguageChange(() => {
  // Repaint presentation only: no wallet requests, claims, API calls or filter resets.
  renderMarket();
  renderNodes();
  if (state.detail) detail(state.detail.seller, state.detail.model);
});
