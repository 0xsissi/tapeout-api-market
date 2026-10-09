import { contextMessages, markdown, shouldSend, nearBottom } from './ui-lib.js';

const $ = id => document.getElementById(id);
const pageNames = { chat: '智能问答', market: '服务市场', wallet: '钱包与充值', agent: 'AI 管理', settings: '设置与接入' };
let status = null, currentPage = 'chat', conversations = [], activeId = null, renderedConversationId = null, storageKey = null, selectedModel = '', pendingId = null, composing = false, toastTimer, saveTimer, statusLoading = false, agentDirty = false;
const messageNodes = new Map();
const queuedMessages = new Map(); let renderFrame = null, marketKey = '';
const terminal = new Set(['complete', 'unknown']);
const currency = () => status?.payment?.displaySymbol || 'tUSDC';
const active = () => conversations.find(c => c.id === activeId);
const short = value => value ? value.slice(0, 8) + '…' + value.slice(-5) : '—';
const text = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
function toast(message) { clearTimeout(toastTimer); text('toast', message); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500); }
async function api(route, body) {
  const response = await fetch(route, { credentials: 'same-origin', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || '操作未完成。');
  return result;
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!storageKey) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ activeId, conversations: conversations.slice(0, 20).map(c => ({ ...c, messages: c.messages.slice(-100) })) })); }
  catch { toast('浏览器记录空间不足。本次对话仍在内存中，可复制后备份。'); }
}
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(save, 700); }
function scheduleMessage(message) {
  queuedMessages.set(message.id, message);
  if (renderFrame == null) renderFrame = requestAnimationFrame(() => { renderFrame = null; for (const value of queuedMessages.values()) if (active()?.messages.includes(value)) renderMessage(value); queuedMessages.clear(); });
}
function initializeProfile(next) {
  if (!next.profileId) return;
  let wallet = next.buyer?.wallet?.address;
  const walletKey = 'tam-client-wallet:' + next.profileId;
  try { if (wallet) localStorage.setItem(walletKey, wallet); else wallet = localStorage.getItem(walletKey); } catch {}
  if (!wallet) return;
  const key = `tam-client:v1:${next.profileId}:${next.payment.symbol}:${wallet.toLowerCase()}`;
  if (key === storageKey) return;
  save(); storageKey = key; conversations = []; activeId = null; renderedConversationId = null; selectedModel = '';
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(cached?.conversations)) conversations = cached.conversations.filter(c => typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.messages)).slice(0, 20);
    activeId = conversations.some(c => c.id === cached?.activeId) ? cached.activeId : conversations[0]?.id;
  } catch {}
  if (!activeId) newConversation(false); else selectConversation(activeId, false);
  for (const c of conversations) for (const m of c.messages) if (m.state === 'running' && m.requestId) { pendingId = m.requestId; void recoverOperation(c.id, m.id, m.requestId); }
}
function newConversation(navigate = true) {
  rememberConversation();
  const c = { id: crypto.randomUUID(), title: '新对话', model: selectedModel || status?.selectedModel || '', draft: '', messages: [], createdAt: Date.now() };
  conversations.unshift(c); conversations = conversations.slice(0, 20); activeId = c.id;
  if (navigate) showPage('chat'); renderConversations(); renderConversation(); save(); $('message-input').focus();
}
function selectConversation(id, navigate = true) {
  if (!conversations.some(c => c.id === id)) return;
  rememberConversation();
  activeId = id; selectedModel = active().model || selectedModel;
  if (navigate) showPage('chat'); renderConversations(); renderConversation(); renderModels(); save();
}
function renderConversations() {
  $('conversations').replaceChildren(...conversations.map(c => { const button = document.createElement('button'); button.className = 'conversation-item' + (c.id === activeId ? ' active' : ''); button.textContent = c.title; button.title = c.title; button.addEventListener('click', () => selectConversation(c.id)); return button; }));
}
function showPage(page) {
  if (!(page in pageNames)) page = 'chat';
  if (currentPage === 'chat') rememberConversation();
  currentPage = page;
  for (const [key, name] of Object.entries(pageNames)) { $('page-' + key).hidden = key !== page; document.querySelector(`[data-page="${key}"]`).classList.toggle('active', key === page); document.querySelector(`[data-page="${key}"]`).setAttribute('aria-current', key === page ? 'page' : 'false'); }
  text('page-title', pageNames[page]); document.body.classList.remove('sidebar-open');
  if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
  if (page === 'chat') { renderModels(); updateComposer(); restoreChatPosition(); }
}
function rememberConversation() {
  const c = active();
  if (!c || c.id !== renderedConversationId) return;
  c.draft = $('message-input').value;
  if (currentPage === 'chat' && !$('page-chat').hidden) { c.scrollTop = $('messages').scrollTop; c.followLatest = nearBottom($('messages')); }
}
function restoreChatPosition() {
  requestAnimationFrame(() => {
    if (currentPage !== 'chat' || !active()) return;
    $('messages').scrollTop = active().followLatest === false ? active().scrollTop || 0 : $('messages').scrollHeight;
    $('jump-latest').hidden = nearBottom($('messages'));
  });
}
function renderConversation() {
  messageNodes.clear(); $('messages').replaceChildren();
  const c = active();
  if (!c?.messages.length) {
    $('messages').innerHTML = emptyMarkup;
    $('messages').querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('message-input').value = button.dataset.prompt; if (active()) active().draft = button.dataset.prompt; $('message-input').focus(); save(); }));
  } else for (const message of c.messages) renderMessage(message, false);
  $('message-input').value = c?.draft || '';
  renderedConversationId = c?.id || null;
  restoreChatPosition(); $('jump-latest').hidden = true; updateComposer();
}
const emptyMarkup = $('messages').innerHTML;
function renderMessage(message, follow = true) {
  const scroll = $('messages'), shouldFollow = currentPage === 'chat' && follow && nearBottom(scroll);
  let node = messageNodes.get(message.id);
  if (!node) {
    $('chat-empty')?.remove();
    node = document.createElement('article'); node.className = 'message ' + message.role; node.dataset.messageId = message.id;
    const head = document.createElement('div'); head.className = 'message-head';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = message.role === 'user' ? '你' : 'T';
    const author = document.createElement('strong'); author.textContent = message.role === 'user' ? '你' : message.model || '助手';
    const time = document.createElement('time'); time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const copy = document.createElement('button'); copy.className = 'copy-message'; copy.textContent = '复制'; copy.addEventListener('click', () => { void copyText(message.content); });
    head.append(avatar, author, time, copy);
    const content = document.createElement('div'); content.className = 'message-content';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const error = document.createElement('div'); error.className = 'message-error';
    node.append(head, content, meta, error); scroll.append(node); messageNodes.set(message.id, node);
  }
  const content = node.querySelector('.message-content');
  if (node.dataset.content !== message.content || node.dataset.state !== message.state) {
    if (message.role === 'user') content.textContent = message.content;
    else if (message.content) content.innerHTML = markdown(message.content);
    else if (message.state === 'running') content.innerHTML = '<span class="typing-dot"></span><span class="muted">正在准备回答…</span>';
    else content.textContent = '没有收到完整回答。';
    node.dataset.content = message.content; node.dataset.state = message.state;
  }
  const usage = message.usage;
  node.querySelector('.message-meta').textContent = message.state === 'running' ? `回答中 · 已等待 ${Math.max(0, Math.floor((Date.now() - message.createdAt) / 1000))} 秒` : usage ? `输入 ${usage.prompt_tokens} · 输出 ${usage.completion_tokens} Token · ${Math.max(1, Math.round(((message.endedAt || Date.now()) - message.createdAt) / 1000))} 秒` : '';
  node.querySelector('.message-error').textContent = message.error || '';
  if (shouldFollow) scroll.scrollTop = scroll.scrollHeight;
  else if (currentPage === 'chat' && message.state === 'running') $('jump-latest').hidden = false;
}
function updateComposer() {
  const busy = pendingId || status?.operations?.some(op => op.state === 'running');
  $('send-message').disabled = !!busy || !status?.buyer?.online || !selectedModel || !storageKey;
  text('send-message', busy ? '回答 / 操作进行中…' : '发送 ↑');
  if (busy) text('chat-state', '可继续阅读或切换菜单。当前请求会保留同一个编号。');
  else if (!status?.buyer?.online) text('chat-state', '买家尚未连接，前往「设置与接入」启动。');
  else if (!selectedModel) text('chat-state', '没有可用模型，前往服务市场查看连接状态。');
  else text('chat-state', `使用 ${selectedModel} · 按实际用量结算`);
}
function renderModels() {
  const models = (status?.network?.models || []).filter(m => m.providerCount > 0 || m.bestProvider);
  if (!selectedModel) selectedModel = active()?.model || (models.some(m => m.model === status?.selectedModel) ? status.selectedModel : models[0]?.model || '');
  const choices = [...new Set([...(selectedModel ? [selectedModel] : []), ...models.map(m => m.model)])];
  const key = JSON.stringify(choices);
  if ($('model-select').dataset.options !== key) {
    $('model-select').replaceChildren(...(choices.length ? choices : ['']).map(model => { const option = document.createElement('option'); option.value = model; option.textContent = model || '暂无可用模型'; return option; }));
    $('model-select').dataset.options = key;
  }
  $('model-select').value = selectedModel;
  const provider = models.find(m => m.model === selectedModel)?.bestProvider;
  text('model-price', provider ? `输入 ${provider.inputPer1m} / 输出 ${provider.outputPer1m} ${currency()} / 百万 Token` : '');
  updateComposer();
}
function updateOperation(cId, messageId, operation) {
  const c = conversations.find(c => c.id === cId), message = c?.messages.find(m => m.id === messageId);
  if (!message) return;
  message.content = operation.content || ''; message.state = operation.state; message.usage = operation.usage; message.error = operation.error; message.endedAt = operation.endedAt;
  if (cId === activeId) scheduleMessage(message);
  if (terminal.has(operation.state)) save(); else scheduleSave();
  if (terminal.has(operation.state)) { if (pendingId === operation.id) pendingId = null; updateComposer(); void refreshStatus(); }
}
async function recoverOperation(cId, messageId, id) {
  try {
    const operation = await api('/api/operations/' + encodeURIComponent(id)); updateOperation(cId, messageId, operation);
    if (operation.state === 'running') setTimeout(() => { void recoverOperation(cId, messageId, id); }, 1200);
  } catch (error) {
    const c = conversations.find(c => c.id === cId), m = c?.messages.find(m => m.id === messageId);
    if (m) { m.state = 'unknown'; m.error = '无法确认上次请求的结果。请先核对余额，不会自动重发。'; if (cId === activeId) renderMessage(m); save(); }
    if (pendingId === id) pendingId = null; updateComposer();
  }
}
async function send(event) {
  event?.preventDefault();
  if ($('send-message').disabled || composing) return;
  const prompt = $('message-input').value.trim(); if (!prompt) { $('message-input').focus(); return; }
  if (!active()) newConversation(false);
  const c = active(), messages = contextMessages(c.messages, prompt), id = crypto.randomUUID();
  if (messages.some(m => m.content.length > 16000)) { toast('有一条历史消息过长，请开始新对话。'); return; }
  const user = { id: crypto.randomUUID(), role: 'user', content: prompt, state: 'complete', createdAt: Date.now() };
  const assistant = { id: crypto.randomUUID(), role: 'assistant', model: selectedModel, content: '', state: 'running', requestId: id, createdAt: Date.now() };
  c.model = selectedModel; if (!c.messages.length) c.title = prompt.replace(/\s+/g, ' ').slice(0, 28); c.messages.push(user, assistant); c.draft = '';
  pendingId = id; $('message-input').value = ''; renderConversations(); renderMessage(user); renderMessage(assistant); $('messages').scrollTop = $('messages').scrollHeight; updateComposer(); save();
  text('context-note', `本次带上 ${messages.length - 1} 条完整前文 · Enter 发送 / Shift + Enter 换行`);
  try {
    const response = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, model: selectedModel, messages }) });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || '请求未完成。'); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary; while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (data) updateOperation(c.id, assistant.id, JSON.parse(data));
      }
      if (done) break;
    }
    if (assistant.state === 'running') { toast('连接暂时中断，正在按原编号核对结果。'); void recoverOperation(c.id, assistant.id, id); }
  } catch (error) {
    toast(error.message + ' 正在核对原请求。'); void recoverOperation(c.id, assistant.id, id);
  }
}
async function copyText(value) { try { await navigator.clipboard.writeText(value); toast('已复制。'); } catch { toast('复制失败，请选中文本手动复制。'); } }
async function confirm(title, description, label = '确认') {
  text('confirm-title', title); text('confirm-description', description); text('confirm-action', label);
  $('confirm-dialog').returnValue = ''; $('confirm-dialog').showModal();
  return new Promise(resolve => $('confirm-dialog').addEventListener('close', () => resolve($('confirm-dialog').returnValue === 'confirm'), { once: true }));
}
async function transaction(action, amount) {
  if (pendingId || status?.operations?.some(op => op.state === 'running')) { toast('请等待当前操作完成。'); return; }
  if (!status?.buyer?.wallet) { toast('尚未读取到钱包，请先刷新状态。'); return; }
  if (amount && !new RegExp(`^\\d{1,12}(\\.\\d{1,${status.payment.decimals}})?$`).test(amount)) { toast('请输入符合当前代币精度的正数。'); return; }
  if (amount && Number(amount) <= 0) { toast('数量必须大于零。'); return; }
  const titles = { deposit: '确认充值', 'withdraw-request': '确认申请提现', 'withdraw-cancel': '确认取消提现', 'withdraw-complete': '确认完成提现' };
  const description = action === 'deposit' ? `将 ${amount} ${currency()} 从钱包转入当前结算池。\n钱包：${status.buyer.wallet.address}\n网络：BSC 测试网（97）\n需要少量 tBNB 作为 Gas。` : `${amount ? '数量：' + amount + ' ' + currency() + '\n' : ''}将在当前 BSC 测试网钱包发送这项链上操作，需要测试 BNB 手续费。`;
  if (!await confirm(titles[action], description, '确认并发送')) return;
  const id = crypto.randomUUID(); pendingId = id; updateComposer();
  try {
    const result = await api('/api/transaction', { id, action, ...(amount ? { amount } : {}) });
    toast('操作已提交，正在等待确认。可切换页面。');
    await watchTransaction(id, result);
  } catch (error) { toast(error.message + ' 请按原编号核对结果。'); try { await watchTransaction(id); } catch { pendingId = null; updateComposer(); } }
}
async function watchTransaction(id, initial) {
  const operation = initial || await api('/api/operations/' + id);
  if (operation.state === 'running') { setTimeout(() => { void watchTransaction(id).catch(() => { pendingId = null; updateComposer(); toast('结果暂未确认，请查看最近操作。'); }); }, 1200); return; }
  if (pendingId === id) pendingId = null;
  toast(operation.state === 'complete' ? '链上操作已确认。' : operation.error || '结果暂未确认，请核对交易记录，不要重复提交。'); updateComposer(); await refreshStatus();
}
function renderActivities(target, operations) {
  target.replaceChildren();
  if (!operations.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '还没有操作记录。'; target.append(p); return; }
  for (const operation of operations) {
    const row = document.createElement('div'); row.className = 'activity-item';
    const label = document.createElement('div'); label.textContent = (operation.kind === 'chat' ? '模型调用' : operation.action ? ({ invoke: 'AI 调用', deposit: 'AI 充值', collect: 'AI 收款', price: 'AI 调价' })[operation.action] : '钱包操作') + ' · ' + ({ complete: '已完成', running: '进行中', unknown: '待核对' })[operation.state] || operation.message;
    if (operation.message && !operation.kind) label.textContent = operation.message;
    const small = document.createElement('small'); small.textContent = new Date(operation.startedAt || operation.createdAt).toLocaleString() + (operation.error ? ' · ' + operation.error : ''); label.append(small); row.append(label);
    const hash = operation.result?.depositTx || operation.result?.tx;
    if (hash && /^0x[a-f0-9]{64}$/i.test(hash)) { const link = document.createElement('a'); link.href = 'https://testnet.bscscan.com/tx/' + hash; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = '查看交易 ↗'; row.append(link); }
    target.append(row);
  }
}
function renderStatus() {
  const wallet = status.buyer?.wallet, connected = status.buyer?.online;
  $('buyer-dot').classList.toggle('online', connected); text('buyer-state', connected ? '本机买家已连接' : '本机买家未启动'); text('profile-label', `${status.payment.network} · ${currency()}`);
  text('top-credit', wallet ? `可用 ${wallet.escrowAvailable} ${currency()}` : '可用额度 —'); text('network-label', 'BSC TESTNET · 97');
  text('wallet-credit', wallet ? `${wallet.escrowAvailable} ${currency()}` : '—'); text('wallet-token', wallet ? `${wallet.usdcBalance} ${currency()}` : '—'); text('wallet-gas', wallet ? `${wallet.nativeBalance} tBNB` : '—'); text('wallet-address', wallet?.address || '—'); text('wallet-currency', currency());
  const pending = wallet?.pendingWithdraw;
  text('withdraw-status', pending ? `待提现 ${pending.amount} ${currency()} · 解锁时间 ${new Date(pending.unlocksAt).toLocaleString()}` : '没有待提现申请。');
  $('withdraw-cancel').disabled = !pending; $('withdraw-complete').disabled = !pending || Date.now() < pending.unlocksAt;
  renderActivities($('wallet-operations'), (status.operations || []).slice(0, 10));
  const agent = status.agent;
  text('agent-spent', `${agent.budget.spentToken} ${currency()}`); text('agent-remaining', `${agent.budget.remainingToken} ${currency()}`); text('agent-reserved', `${agent.budget.reservedToken} ${currency()}`); text('agent-pause', agent.policy.paused ? '恢复已授权的 AI 操作' : '暂停 AI 自动操作');
  if (!agentDirty) {
    $('agent-daily').value = agent.policy.dailySpendToken; $('agent-call').value = agent.policy.maxCallToken; $('agent-deposit').value = agent.policy.dailyDepositToken; $('agent-models').value = agent.policy.models.join(', ');
    document.querySelectorAll('#agent-form input[name=action]').forEach(input => { input.checked = agent.policy.allowedActions.includes(input.value); });
  }
  renderActivities($('agent-activity'), agent.recentOperations || []);
  $('settings-status').replaceChildren();
  for (const [key, value] of Object.entries({ 状态: connected ? '已连接' : '未启动', 买家地址: status.buyer.url, 网络: `${status.payment.network} · Chain ${status.payment.chainId}`, 结算币种: currency(), 钱包: wallet?.address || '等待连接', 单次最高费用: `${status.limits.maxRequestCostToken} ${currency()}`, AI接入: agent.url })) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key; dd.textContent = value; $('settings-status').append(dt, dd); }
  $('start-buyer').disabled = connected; text('start-buyer', connected ? '本机买家已运行' : '启动本机买家');
  text('api-example', `Base URL: ${status.buyer.url}/v1\nModel: ${selectedModel || status.selectedModel}\nAuthorization: Bearer YOUR_LOCAL_API_TOKEN\n\nAI 管理入口: ${agent.url}`);
  const issue = !connected ? '买家尚未连接。聊天记录仍保留；可在「设置与接入」启动买家。' : status.buyer.issue;
  $('connection-banner').hidden = !issue; if (issue) text('connection-banner', issue);
  renderModels(); renderMarket(); updateComposer();
}
function renderMarket() {
  const data = status?.network?.models || [], available = data.filter(m => m.providerCount > 0 || m.bestProvider);
  const key = JSON.stringify(available.map(m => ({ model: m.model, providers: (m.providers?.length ? m.providers : [m.bestProvider]).filter(Boolean).map(p => [p.peerId, p.walletAddress, p.inputPer1m, p.outputPer1m, p.region]) })));
  if (key === marketKey) return;
  marketKey = key;
  $('market-list').replaceChildren();
  if (!available.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '暂未发现卖家。请确认买家已启动，稍后刷新；聊天记录不会受影响。'; $('market-list').append(p); return; }
  for (const model of available) {
    const providers = model.providers?.length ? model.providers : [model.bestProvider];
    for (const provider of providers.filter(Boolean)) {
      const card = document.createElement('article'); card.className = 'market-card';
      const top = document.createElement('div'); top.className = 'market-card-top';
      const info = document.createElement('div'), h = document.createElement('h2'), p = document.createElement('p'); h.textContent = model.model; p.textContent = `卖家 ${short(provider.walletAddress)} · ${provider.region || '未知地区'} · ${status.payment.network}`; info.append(h, p);
      const button = document.createElement('button'); button.className = 'secondary-button'; button.textContent = '使用这个模型 ↗'; button.addEventListener('click', () => { selectedModel = model.model; if (active()) active().model = selectedModel; renderModels(); showPage('chat'); save(); $('message-input').focus(); }); top.append(info, button);
      const prices = document.createElement('div'); prices.className = 'market-prices';
      for (const [label, value] of [['输入', provider.inputPer1m], ['输出', provider.outputPer1m]]) { const column = document.createElement('div'), caption = document.createElement('label'), number = document.createElement('strong'), unit = document.createElement('small'); caption.textContent = label; number.textContent = value; unit.textContent = currency() + ' / 百万 Token'; column.append(caption, number, unit); prices.append(column); }
      card.append(top, prices); $('market-list').append(card);
    }
  }
}
async function refreshStatus() {
  if (statusLoading) return; statusLoading = true;
  try { const next = await api('/api/status'); status = next; initializeProfile(next); renderStatus(); }
  catch (error) { $('connection-banner').hidden = false; text('connection-banner', error.message + ' 已有对话和输入仍保留。'); }
  finally { statusLoading = false; }
}

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
$('menu-toggle').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
$('sidebar-backdrop').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
$('new-chat').addEventListener('click', () => newConversation());
$('refresh-status').addEventListener('click', () => { void refreshStatus(); });
$('model-select').addEventListener('change', () => { selectedModel = $('model-select').value; if (active()) active().model = selectedModel; renderModels(); save(); });
$('chat-form').addEventListener('submit', send);
$('message-input').addEventListener('compositionstart', () => { composing = true; });
$('message-input').addEventListener('compositionend', () => { composing = false; });
$('message-input').addEventListener('keydown', event => { if (shouldSend(event, composing)) { event.preventDefault(); void send(); } });
$('message-input').addEventListener('input', () => { if (active()) active().draft = $('message-input').value; clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); });
window.addEventListener('beforeunload', () => { rememberConversation(); save(); });
$('messages').addEventListener('scroll', () => { if (currentPage === 'chat' && !$('page-chat').hidden) { rememberConversation(); scheduleSave(); } if (nearBottom($('messages'))) $('jump-latest').hidden = true; });
$('jump-latest').addEventListener('click', () => { $('messages').scrollTop = $('messages').scrollHeight; $('jump-latest').hidden = true; });
$('messages').addEventListener('click', event => { const button = event.target.closest('.copy-code'); if (button) void copyText(button.closest('.code-block').querySelector('code').textContent); });
$('delete-chat').addEventListener('click', async () => { if (!active()) return; if (active().messages.some(m => m.state === 'running')) { toast('当前回答还在进行，完成后再删除。'); return; } if (!await confirm('删除这个对话？', '将删除当前浏览器保存的此对话记录。钱包、余额和链上记录不受影响。', '删除')) return; conversations = conversations.filter(c => c.id !== activeId); if (conversations.length) selectConversation(conversations[0].id); else newConversation(); save(); });
$('deposit-form').addEventListener('submit', event => { event.preventDefault(); void transaction('deposit', $('deposit-amount').value.trim()); });
$('withdraw-form').addEventListener('submit', event => { event.preventDefault(); void transaction('withdraw-request', $('withdraw-amount').value.trim()); });
$('withdraw-cancel').addEventListener('click', () => { void transaction('withdraw-cancel'); });
$('withdraw-complete').addEventListener('click', () => { void transaction('withdraw-complete'); });
$('copy-address').addEventListener('click', () => { if (status?.buyer?.wallet) void copyText(status.buyer.wallet.address); });
$('agent-form').addEventListener('input', () => { agentDirty = true; });
$('agent-form').addEventListener('submit', async event => {
  event.preventDefault();
  const policy = { dailySpendToken: $('agent-daily').value.trim(), maxCallToken: $('agent-call').value.trim(), dailyDepositToken: $('agent-deposit').value.trim(), models: $('agent-models').value.split(',').map(x => x.trim()).filter(Boolean), allowedActions: Array.from(document.querySelectorAll('#agent-form input[name=action]:checked')).map(x => x.value) };
  if (!await confirm('保存 AI 规则？', 'AI 将按照这些权限和额度执行后续操作。已有操作继续等待结果，未知结果仍保留预算。', '保存规则')) return;
  try { await api('/api/policy', policy); agentDirty = false; toast('主人规则已保存。'); await refreshStatus(); } catch (error) { toast(error.message); }
});
$('agent-pause').addEventListener('click', async () => { try { const paused = !status.agent.policy.paused; await api('/api/policy', { paused }); toast(paused ? 'AI 后续自动操作已暂停。' : '已恢复原来授权的 AI 操作。'); await refreshStatus(); } catch (error) { toast(error.message); } });
$('start-buyer').addEventListener('click', async () => { $('start-buyer').disabled = true; text('start-buyer', '正在启动…'); try { await api('/api/buyer/start', {}); toast('买家已启动，正在发现卖家。'); await refreshStatus(); } catch (error) { toast(error.message); $('start-buyer').disabled = false; text('start-buyer', '重新启动买家'); } });
showPage(location.hash.slice(1)); void refreshStatus(); setInterval(() => { void refreshStatus(); }, 15000);
setInterval(() => { const c = active(); for (const m of c?.messages || []) if (m.state === 'running') renderMessage(m); }, 1000);
