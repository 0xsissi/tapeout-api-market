import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { FaucetError } from './market-faucet.mjs';

const pools = { USDC: '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F', BEM: '0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e' };
const validId = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);
export function admissionMessage(record) {
  return `Tapeout API Market — buyer access application\nWebsite: ${record.origin}\nChain: BSC Testnet (97)\nBuyer: ${record.address}\nSeller: ${record.sellerAddress}\nCurrency: ${record.currency}\nNonce: ${record.id}\nExpires: ${new Date(record.expiresAt).toISOString()}\nThis signature proves wallet ownership and requests review only. It does not authorize a payment, approve token spending, or grant access. Approved wallet addresses are published in the pilot access list.`;
}
// No financial keys. Each application is separate; operator reviews never overwrite other requests.
export class MarketAdmission {
  constructor({ directory, origin, now = Date.now, sellers = [] }) {
    if (!path.isAbsolute(directory) || new URL(origin).origin !== origin) throw new Error('An absolute private admission directory and exact origin are required');
    this.directory = directory; this.origin = origin; this.now = now; this.sellers = sellers.map(ethers.getAddress); this.challenges = new Map(); this.attempts = new Map();
    fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
    const saltFile = path.join(directory, 'salt');
    try { fs.writeFileSync(saltFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.salt = fs.readFileSync(saltFile, 'utf8');
  }
  ipHash(ip) { return createHash('sha256').update(this.salt + ip).digest('hex'); }
  reviewState() { try { return JSON.parse(fs.readFileSync(path.join(this.directory, 'approved-buyers.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 1, reviews: {}, grants: [] }; throw e; } }
  records() { const reviews = this.reviewState().reviews ?? {}; return fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{48}\.json$/.test(name)).map(name => { const r = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')); return { ...r, ...reviews[r.id] }; }); }
  record(id) { if (!validId(id)) throw new FaucetError(400, 'invalid_id', '申请编号无效。'); try { const r = JSON.parse(fs.readFileSync(path.join(this.directory, id + '.json'), 'utf8')); return { ...r, ...(this.reviewState().reviews ?? {})[id] }; } catch (e) { if (e.code === 'ENOENT') throw new FaucetError(404, 'not_found', '申请尚未提交，请使用原编号查询或提交。'); throw e; } }
  publicRecord(r) { return { id: r.id, address: r.address, sellerAddress: r.sellerAddress, currency: r.currency, chainId: 97, status: r.status, createdAt: r.createdAt, reviewedAt: r.reviewedAt, accessExpiresAt: r.accessExpiresAt, nextAction: r.status === 'approved' && r.accessExpiresAt > this.now() ? 'Check test BNB and pool credit, then run one bounded test call.' : r.status === 'pending' ? 'Wait for seller review; test tokens do not grant access.' : 'Ask the seller to review access. Do not repeatedly create applications.', notice: 'Approval belongs to this seller, network and currency only. It is not model-provider identity certification.' }; }
  challenge(input, ip) {
    if (!ethers.isAddress(input.address) || !ethers.isAddress(input.sellerAddress) || !Object.hasOwn(pools, input.currency)) throw new FaucetError(400, 'invalid_request', '需要买家钱包、卖家钱包和 USDC/BEM。');
    const address = ethers.getAddress(input.address), sellerAddress = ethers.getAddress(input.sellerAddress), ipHash = this.ipHash(ip), now = this.now();
    if (!this.sellers.includes(sellerAddress)) throw new FaucetError(400, 'unsupported_seller', '此申请入口只受理本站内测卖家，其他卖家自行授权。');
    const records = this.records(), recent = records.filter(r => now - r.createdAt < 86_400_000);
    if (recent.some(r => r.address === address && r.sellerAddress === sellerAddress && r.currency === input.currency)) throw new FaucetError(429, 'application_exists', '今天已经提交过同一申请，请查询原编号。');
    if (records.length >= 20000 || recent.length >= 200 || recent.filter(r => r.ipHash === ipHash).length >= 5) throw new FaucetError(429, 'application_limit', '今日申请数量达到上限，请稍后再试。');
    for (const [id, r] of this.challenges) if (r.expiresAt < now) this.challenges.delete(id);
    for (const [key, r] of this.attempts) if (now - r.startedAt > 300000) this.attempts.delete(key);
    const attempts = this.attempts.get(ipHash) ?? { count: 0, startedAt: now }; this.attempts.set(ipHash, attempts);
    if (++attempts.count > 10 || this.challenges.size >= 500) throw new FaucetError(429, 'rate_limit', '请求过于频繁，请稍后再试。');
    const r = { version: 1, id: randomBytes(24).toString('hex'), origin: this.origin, address, sellerAddress, currency: input.currency, ipHash, expiresAt: now + 300000 };
    r.message = admissionMessage(r); this.challenges.set(r.id, r);
    return { id: r.id, message: r.message, expiresAt: r.expiresAt, chainId: 97, currency: r.currency, sellerAddress };
  }
  submit({ id, signature }, ip) {
    let existing = null; try { existing = this.record(id); } catch (e) { if (e.code !== 'not_found') throw e; }
    const r = existing ?? this.challenges.get(id);
    if (!r || (!existing && r.expiresAt < this.now()) || r.ipHash !== this.ipHash(ip)) throw new FaucetError(400, 'challenge_expired', '申请签名已过期或来源发生变化。');
    let signer; try { signer = ethers.verifyMessage(r.message, signature); } catch { throw new FaucetError(401, 'invalid_signature', '钱包签名无效。'); }
    if (signer !== r.address) throw new FaucetError(401, 'invalid_signature', '请由申请钱包签名。');
    if (existing) return this.publicRecord(existing);
    const recent = this.records().filter(v => this.now() - v.createdAt < 86400000);
    if (recent.some(v => v.address === r.address && v.sellerAddress === r.sellerAddress && v.currency === r.currency)) throw new FaucetError(429, 'application_exists', '同一申请已提交，请查询原编号。');
    if (recent.length >= 200 || recent.filter(v => v.ipHash === r.ipHash).length >= 5) throw new FaucetError(429, 'application_limit', '今日申请数量达到上限。');
    const record = { ...r, status: 'pending', createdAt: this.now() };
    fs.writeFileSync(path.join(this.directory, id + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); this.challenges.delete(id);
    return this.publicRecord(record);
  }
  approved() {
    try { const value = this.reviewState(); return { version: 1, grants: value.grants.filter(v => v.expiresAt > this.now()) }; }
    catch (e) { if (e.code === 'ENOENT') return { version: 1, grants: [] }; throw e; }
  }
  status(id) { const r = this.record(id); if (r.status === 'approved' && r.accessExpiresAt <= this.now()) r.status = 'expired'; else if (r.status === 'approved' && !this.approved().grants.some(g => g.address === r.address && g.sellerAddress === r.sellerAddress && g.currency === r.currency && g.expiresAt === r.accessExpiresAt)) r.status = 'pending'; return this.publicRecord(r); }
  review(id, decision, hours = 24) {
    if (!['approved', 'rejected'].includes(decision) || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('Review requires approved/rejected and 1–168 hours');
    const lock = path.join(this.directory, 'review.lock');
    fs.mkdirSync(lock); // Serialize operator reviews. Never steal a possibly live review lock.
    try {
    const r = this.record(id); r.status = decision; r.reviewedAt = this.now(); r.accessExpiresAt = decision === 'approved' ? this.now() + hours * 3600000 : 0;
    const reviews = { ...(this.reviewState().reviews ?? {}), [id]: { status: decision, reviewedAt: r.reviewedAt, accessExpiresAt: r.accessExpiresAt } };
    const grants = this.records().map(v => v.id === id ? r : v).filter(v => v.status === 'approved' && v.accessExpiresAt > this.now()).map(v => ({ address: v.address, sellerAddress: v.sellerAddress, currency: v.currency, chainId: 97, poolAddress: pools[v.currency], expiresAt: v.accessExpiresAt }));
    // One atomic authority file determines both reported status and effective grants.
    const file = path.join(this.directory, 'approved-buyers.json'); fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, reviews, grants }), { mode: 0o640 }); fs.renameSync(file + '.tmp', file); fs.chmodSync(file, 0o640);
    return this.publicRecord(r);
    } finally { fs.rmdirSync(lock); }
  }
}
