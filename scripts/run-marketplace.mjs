import './lib/bsc-testnet-only.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { MarketFaucet, createFaucetChain } from './lib/market-faucet.mjs';
import { catalogSnapshot, probeBootstrap, BOOTSTRAP_SOURCES } from './lib/market-catalog.mjs';
import { startMarketServer } from './lib/market-server.mjs';
import { MarketAdmission } from './lib/market-admission.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.TAM_MARKET_HOST || '127.0.0.1', port = Number(process.env.TAM_MARKET_PORT || 18400);
const origin = process.env.TAM_MARKET_ORIGIN || `http://127.0.0.1:${port}`;
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid website port');
if (host !== '127.0.0.1' && !process.env.TAM_MARKET_ORIGIN) throw new Error('Configure TAM_MARKET_ORIGIN before exposing the website');
const proxyMode = process.env.TAM_MARKET_TRUST_PROXY || '';
if (!['', 'loopback'].includes(proxyMode)) throw new Error('TAM_MARKET_TRUST_PROXY only supports loopback');
let faucet, chain, lock, observer, server, timer;
const directory = process.env.TAM_FAUCET_STATE_DIR;
async function cleanup() {
  clearInterval(timer); observer?.kill(); await server?.stop(); chain?.close();
  if (lock) { fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); lock = undefined; }
}
try {
if (directory) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(directory));
  const outside = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  if (!path.isAbsolute(directory) || !outside) throw new Error('Faucet wallet and ledger must be outside Git');
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'faucet-wallet.json'), 'utf8'));
  const wallet = new ethers.Wallet(saved.privateKey);
  if (wallet.address !== saved.address) throw new Error('Faucet signing wallet does not match');
  const proposedLock = path.join(directory, 'website.lock');
  fs.mkdirSync(proposedLock); lock = proposedLock; fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  chain = createFaucetChain(process.env.TAM_FAUCET_RPC_URL || 'https://bsc-testnet-dataseed.bnbchain.org');
  await chain.verifyAssets(); faucet = new MarketFaucet({ directory, wallet, chain, origin });
}
let sellers = [], observedAt = null, nodes = BOOTSTRAP_SOURCES.map(s => ({ id: s.id, name: s.name, host: s.host, role: 'bootstrap-relay', status: 'checking' }));
let checking = false;
async function refreshNodes() { if (checking) return; checking = true; try { nodes = await Promise.all(BOOTSTRAP_SOURCES.map(s => probeBootstrap(s))); } finally { checking = false; } }
observer = fork(fileURLToPath(new URL('./market-observer.mjs', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
observer.on('message', message => { if (message?.type === 'catalog' && Array.isArray(message.sellers)) { sellers = message.sellers; observedAt = message.observedAt; } });
observer.on('error', () => console.warn('Market discovery is temporarily unavailable'));
const admission = process.env.TAM_ADMISSION_STATE_DIR ? new MarketAdmission({ directory: process.env.TAM_ADMISSION_STATE_DIR, origin, sellers: (process.env.TAM_ADMISSION_SELLERS ?? '').split(',').map(seller => seller.trim()).filter(Boolean) }) : null;
if (admission) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(admission.directory));
  if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error('Admission records must be outside the installation/Git directory');
}
const getBootstrapPeers = () => nodes.filter(node => node.status === 'online').flatMap(node => {
  const source = BOOTSTRAP_SOURCES.find(source => source.id === node.id);
  if (!source || !node.peerId) return [];
  const hostProtocol = source.host.includes(':') ? 'ip6' : /^[\d.]+$/.test(source.host) ? 'ip4' : 'dns4';
  return [`/${hostProtocol}/${source.host}/tcp/9090/p2p/${node.peerId}`, `/${hostProtocol}/${source.host}/tcp/9091/ws/p2p/${node.peerId}`];
});
server = await startMarketServer({ host, port, origin, faucet, admission, distributionDirectory: process.env.TAM_DISTRIBUTION_DIR, trustLoopbackProxy: proxyMode === 'loopback', getBootstrapPeers, getCatalog: () => catalogSnapshot({ nodes, sellers, observedAt }) });
await refreshNodes(); timer = setInterval(refreshNodes, 30_000);
console.log(`TAM Market ready: ${origin} — faucet ${faucet ? 'enabled on chain 97' : 'disabled'}`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; await cleanup();
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) { await cleanup(); throw error; }
