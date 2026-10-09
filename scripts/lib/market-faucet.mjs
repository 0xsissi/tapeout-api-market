import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ethers } from 'ethers';

export const TEST_ASSETS = Object.freeze({
  USDC: { symbol: 'tUSDC', address: '0xFcc26b50731525a4452D0ED428cdf11058723B89', decimals: 6, amount: '20' },
  BEM: { symbol: 'tBEM', address: '0x6DD0Be28736F638844499B019DBaacc5897dAAC2', decimals: 8, amount: '100' },
});
const tokenAbi = new ethers.Interface(['function transfer(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);
export class FaucetError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function faucetMessage({ origin, address, currency, amount, nonce, expiresAt }) {
  return `Tapeout API Market — test-token request\nWebsite: ${origin}\nChain: BSC Testnet (97)\nWallet: ${address}\nToken: ${TEST_ASSETS[currency].symbol}\nAmount: ${amount}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature only requests test tokens. It does not approve spending or a payment.`;
}
export function createFaucetChain(rpcUrl) {
  const request = new ethers.FetchRequest(rpcUrl); request.timeout = 10_000;
  const provider = new ethers.JsonRpcProvider(request, 97, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 1000;
  return {
    async assertNetwork() {
      if (BigInt(await provider.send('eth_chainId', [])) !== 97n) throw new FaucetError(503, 'wrong_network', '领币服务暂不可用：网络配置不匹配。');
    },
    async verifyAssets() {
      await this.assertNetwork();
      for (const asset of Object.values(TEST_ASSETS)) {
        if (await provider.getCode(asset.address) === '0x') throw new Error('Test token is not deployed');
        const token = new ethers.Contract(asset.address, tokenAbi, provider);
        if (await token.decimals() !== BigInt(asset.decimals)) throw new Error('Test token precision mismatch');
      }
    },
    async inventory(address) {
      await this.assertNetwork();
      const balances = {};
      for (const [key, asset] of Object.entries(TEST_ASSETS)) balances[key] = ethers.formatUnits(await new ethers.Contract(asset.address, tokenAbi, provider).balanceOf(address), asset.decimals);
      return { gasTbnb: ethers.formatEther(await provider.getBalance(address)), balances };
    },
    getNonce: address => provider.getTransactionCount(address, 'pending'),
    getGasPrice: async () => BigInt(await provider.send('eth_gasPrice', [])),
    estimateGas: tx => provider.estimateGas(tx),
    broadcast: raw => provider.broadcastTransaction(raw),
    receipt: hash => provider.getTransactionReceipt(hash),
    close: () => provider.destroy(),
  };
}

// A dedicated, pre-funded transfer wallet; this process never holds the token administrator key.
export class MarketFaucet {
  constructor({ directory, wallet, chain, origin, now = Date.now, cooldownMs = 86_400_000, dailyLimit = 100, ipDailyLimit = 4 }) {
    if (!path.isAbsolute(directory)) throw new Error('An absolute private faucet directory is required');
    if (new URL(origin).origin !== origin) throw new Error('Provide the exact public website origin');
    this.directory = directory; this.wallet = wallet; this.chain = chain; this.origin = origin; this.now = now;
    this.cooldownMs = cooldownMs; this.dailyLimit = dailyLimit; this.ipDailyLimit = ipDailyLimit;
    this.challenges = new Map(); this.attempts = new Map(); this.queue = Promise.resolve();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'faucet-ledger.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, address: wallet.address, salt: randomBytes(32).toString('hex'), claims: [] };
    if (this.state.version !== 1 || this.state.address !== wallet.address || !Array.isArray(this.state.claims)) throw new Error('Faucet ledger or signing wallet changed; keep the existing ledger');
    this.save();
  }
  save() {
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  ipHash(ip) { return createHash('sha256').update(this.state.salt + ip).digest('hex'); }
  checkLimits(address, currency, ip) {
    const now = this.now(), recent = this.state.claims.filter(c => now - c.createdAt < this.cooldownMs);
    const previous = recent.find(c => c.address === address && c.currency === currency);
    if (previous) throw new FaucetError(429, 'wallet_cooldown', `这个钱包已经领取过 ${TEST_ASSETS[currency].symbol}，请在 ${new Date(previous.createdAt + this.cooldownMs).toISOString()} 后再试。`);
    if (recent.length >= this.dailyLimit || recent.filter(c => c.ipHash === this.ipHash(ip)).length >= this.ipDailyLimit) throw new FaucetError(429, 'daily_limit', '今日领取名额已用完，请稍后再试。');
  }
  challenge({ address, currency }, ip) {
    if (!ethers.isAddress(address) || !Object.hasOwn(TEST_ASSETS, currency)) throw new FaucetError(400, 'invalid_request', '请选择测试币并提供有效钱包地址。');
    address = ethers.getAddress(address);
    this.checkLimits(address, currency, ip);
    for (const [id, value] of this.challenges) if (value.expiresAt < this.now()) this.challenges.delete(id);
    for (const [key, value] of this.attempts) if (this.now() - value.started > 300_000) this.attempts.delete(key);
    const hash = this.ipHash(ip), attempts = this.attempts.get(hash) ?? { started: this.now(), count: 0 };
    if (++attempts.count > 10 || this.challenges.size >= 500) throw new FaucetError(429, 'rate_limit', '请求过于频繁，请稍后再试。');
    this.attempts.set(hash, attempts);
    const value = { origin: this.origin, address, currency, amount: TEST_ASSETS[currency].amount, nonce: randomBytes(24).toString('hex'), expiresAt: this.now() + 300_000, ipHash: hash };
    value.message = faucetMessage(value); this.challenges.set(value.nonce, value);
    return { id: value.nonce, message: value.message, expiresAt: value.expiresAt, currency, amountToken: value.amount, chainId: 97 };
  }
  publicClaim(record) {
    return { id: record.id, address: record.address, currency: record.currency, amountToken: record.amount, status: record.status, txHash: record.hash, explorerUrl: `https://testnet.bscscan.com/tx/${record.hash}` };
  }
  async reconcile(record) {
    const receipt = await this.chain.receipt(record.hash);
    if (receipt) { record.status = receipt.status === 1 ? 'confirmed' : 'reverted'; this.save(); }
    return this.publicClaim(record);
  }
  async status(id) {
    const record = this.state.claims.find(c => c.id === id);
    if (!record) throw new FaucetError(404, 'not_found', '找不到该领取记录。');
    if (!['confirmed', 'reverted'].includes(record.status)) await this.chain.assertNetwork();
    return ['confirmed', 'reverted'].includes(record.status) ? this.publicClaim(record) : this.reconcile(record);
  }
  async claim(input, ip) {
    const operation = this.queue.then(() => this.performClaim(input, ip));
    this.queue = operation.catch(() => {}); return operation;
  }
  async performClaim({ id, signature }, ip) {
    const existing = this.state.claims.find(c => c.id === id);
    const challenge = existing ?? this.challenges.get(id);
    if (!challenge || (challenge.expiresAt < this.now() && !existing) || challenge.ipHash !== this.ipHash(ip)) throw new FaucetError(400, 'challenge_expired', '领取验证已过期，请重新开始。');
    let signer;
    try { signer = ethers.verifyMessage(challenge.message, signature); } catch { throw new FaucetError(401, 'invalid_signature', '钱包签名无效。'); }
    if (signer !== challenge.address) throw new FaucetError(401, 'invalid_signature', '请使用领取地址对应的钱包签名。');
    await this.chain.assertNetwork();
    if (existing) {
      if (!['confirmed', 'reverted'].includes(existing.status)) {
        if (!await this.chain.receipt(existing.hash)) {
          try { await this.chain.broadcast(existing.raw); } catch { /* same hash stays reserved until a receipt is known */ }
        }
        return this.reconcile(existing);
      }
      return this.publicClaim(existing);
    }
    this.checkLimits(challenge.address, challenge.currency, ip);
    // Never advance the nonce while an earlier submission is uncertain.
    for (const previous of this.state.claims.filter(c => !['confirmed', 'reverted'].includes(c.status))) {
      const receipt = await this.chain.receipt(previous.hash);
      if (!receipt) throw new FaucetError(503, 'pending_transfer', '前一笔领币交易仍在确认，稍后再试。');
      previous.status = receipt.status === 1 ? 'confirmed' : 'reverted'; this.save();
    }
    const asset = TEST_ASSETS[challenge.currency], inventory = await this.chain.inventory(this.wallet.address);
    if (ethers.parseEther(inventory.gasTbnb) < ethers.parseEther('0.0002') || ethers.parseUnits(inventory.balances[challenge.currency], asset.decimals) < ethers.parseUnits(asset.amount, asset.decimals)) throw new FaucetError(503, 'faucet_empty', '测试币暂时发完或 Gas 不足，请联系项目方补充。');
    const gasPrice = await this.chain.getGasPrice();
    if (gasPrice > ethers.parseUnits('1', 9)) throw new FaucetError(503, 'gas_limit', '测试网手续费升高，请稍后领取。');
    const tx = { to: asset.address, value: 0n, data: tokenAbi.encodeFunctionData('transfer', [challenge.address, ethers.parseUnits(asset.amount, asset.decimals)]) };
    const gasLimit = (await this.chain.estimateGas({ ...tx, from: this.wallet.address })) * 120n / 100n;
    if (gasLimit > 100_000n) throw new FaucetError(503, 'gas_limit', '交易手续费超过领取上限。');
    const raw = await this.wallet.signTransaction({ ...tx, gasLimit, gasPrice, chainId: 97, nonce: await this.chain.getNonce(this.wallet.address), type: 0 });
    const record = { ...challenge, id, createdAt: this.now(), raw, hash: ethers.keccak256(raw), status: 'pending' };
    this.state.claims.push(record); this.save(); this.challenges.delete(id);
    try { await this.chain.broadcast(raw); } catch { /* unknown outcome: return its persisted hash; retries use identical bytes */ }
    return this.reconcile(record);
  }
}
