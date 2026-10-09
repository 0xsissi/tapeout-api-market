import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { MarketFaucet, TEST_ASSETS } from './market-faucet.mjs';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function setup(options: Record<string, unknown> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-faucet-test-')); folders.push(directory);
  const wallet = ethers.Wallet.createRandom(), buyer = ethers.Wallet.createRandom();
  let now = Date.now(), network = 97, nonce = 0, confirm = true, failBroadcast = false, gasPrice = 100_000_000n;
  const broadcasts: string[] = [], receipts = new Map<string, { status: number }>();
  const chain = {
    async assertNetwork() { if (network !== 97) throw new Error('wrong network'); },
    async inventory() { return { gasTbnb: '0.005', balances: { USDC: '1000', BEM: '10000' } }; },
    async getNonce() { return nonce; }, async getGasPrice() { return gasPrice; }, async estimateGas() { return 50_000n; },
    async broadcast(raw: string) { broadcasts.push(raw); if (confirm) { receipts.set(ethers.keccak256(raw), { status: 1 }); nonce++; } if (failBroadcast) throw new Error('RPC timeout after accepting'); },
    async receipt(hash: string) { return receipts.get(hash) ?? null; },
  };
  const config = { directory, wallet, chain, origin: 'http://127.0.0.1:18400', now: () => now, ...options };
  let faucet = new MarketFaucet(config);
  const challenge = (currency = 'USDC', account = buyer, ip = '127.0.0.1') => faucet.challenge({ address: account.address, currency }, ip);
  const signed = async (value: { id: string; message: string }, account = buyer) => ({ id: value.id, signature: await account.signMessage(value.message) });
  return { directory, wallet, buyer, chain, broadcasts, receipts, challenge, signed, get faucet() { return faucet; },
    restart() { faucet = new MarketFaucet(config); }, setTime(value: number) { now = value; }, getTime() { return now; },
    setNetwork(value: number) { network = value; }, setConfirm(value: boolean) { confirm = value; }, setFailBroadcast(value: boolean) { failBroadcast = value; }, setGasPrice(value: bigint) { gasPrice = value; } };
}
describe('market test-token faucet', () => {
  it('signs only chain 97, the fixed token, fixed amount, and the signing recipient', async () => {
    const s = setup(); const challenge = s.faucet.challenge({ address: s.buyer.address, currency: 'USDC', amount: '999999', to: s.wallet.address }, '127.0.0.1');
    expect(challenge.message).toContain('Chain: BSC Testnet (97)'); expect(challenge.message).toContain('Amount: 20');
    const result = await s.faucet.claim({ ...await s.signed(challenge), amount: '999999', currency: 'BEM' }, '127.0.0.1');
    expect(result.status).toBe('confirmed'); expect(result).not.toHaveProperty('raw');
    const tx = ethers.Transaction.from(s.broadcasts[0]);
    expect(tx.chainId).toBe(97n); expect(tx.to).toBe(TEST_ASSETS.USDC.address); expect(tx.value).toBe(0n);
    const transfer = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', tx.data);
    expect(transfer[0]).toBe(s.buyer.address); expect(transfer[1]).toBe(20_000_000n);
  });
  it('rejects a different signing wallet and unknown currency', async () => {
    const s = setup(), challenge = s.challenge();
    await expect(s.faucet.claim(await s.signed(challenge, s.wallet), '127.0.0.1')).rejects.toMatchObject({ code: 'invalid_signature' });
    expect(() => s.challenge('__proto__')).toThrow(); expect(() => s.challenge('constructor')).toThrow(); expect(s.broadcasts).toHaveLength(0);
  });
  it('rejects expired challenges and a different source IP before transferring', async () => {
    const s = setup(), challenge = s.challenge(), input = await s.signed(challenge);
    await expect(s.faucet.claim(input, 'different-ip')).rejects.toMatchObject({ code: 'challenge_expired' });
    s.setTime(s.getTime() + 300_001);
    await expect(s.faucet.claim(input, '127.0.0.1')).rejects.toMatchObject({ code: 'challenge_expired' }); expect(s.broadcasts).toHaveLength(0);
  });
  it('refuses a wrong RPC network and high gas without sending anything', async () => {
    const s = setup(), input = await s.signed(s.challenge()); s.setNetwork(196);
    await expect(s.faucet.claim(input, '127.0.0.1')).rejects.toThrow('wrong network');
    s.setNetwork(97); s.setGasPrice(2_000_000_000n);
    await expect(s.faucet.claim(input, '127.0.0.1')).rejects.toMatchObject({ code: 'gas_limit' }); expect(s.broadcasts).toHaveLength(0);
  });
  it('persists cooldown and idempotent success across restart and challenge expiry', async () => {
    const s = setup(), input = await s.signed(s.challenge()); const first = await s.faucet.claim(input, '127.0.0.1');
    s.restart(); s.setTime(s.getTime() + 300_001);
    expect(await s.faucet.claim(input, '127.0.0.1')).toEqual(first); expect(s.broadcasts).toHaveLength(1);
    expect(() => s.challenge()).toThrow(/已经领取/); expect(s.challenge('BEM').amountToken).toBe('100');
    s.setTime(s.getTime() + 86_400_000); expect(s.challenge().amountToken).toBe('20');
  });
  it('serializes simultaneous claims so one wallet gets only one transfer per currency', async () => {
    const s = setup(); const inputs = await Promise.all([s.challenge(), s.challenge()].map(value => s.signed(value)));
    const results = await Promise.allSettled(inputs.map(input => s.faucet.claim(input, '127.0.0.1')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(s.broadcasts).toHaveLength(1);
  });
  it('records signed bytes before sending, keeps uncertain transfers reserved, and retries identical bytes', async () => {
    const s = setup(); s.setConfirm(false); s.setFailBroadcast(true);
    const originalBroadcast = s.chain.broadcast;
    s.chain.broadcast = async raw => { const ledger = JSON.parse(fs.readFileSync(path.join(s.directory, 'faucet-ledger.json'), 'utf8')); expect(ledger.claims[0].raw).toBe(raw); return originalBroadcast(raw); };
    const input = await s.signed(s.challenge()), first = await s.faucet.claim(input, '127.0.0.1'); expect(first.status).toBe('pending');
    s.restart(); const other = await s.signed(s.challenge('BEM'));
    await expect(s.faucet.claim(other, '127.0.0.1')).rejects.toMatchObject({ code: 'pending_transfer' });
    const second = await s.faucet.claim(input, '127.0.0.1'); expect(second.txHash).toBe(first.txHash); expect(s.broadcasts).toEqual([s.broadcasts[0], s.broadcasts[0]]);
    s.receipts.set(first.txHash, { status: 1 }); expect((await s.faucet.status(first.id)).status).toBe('confirmed');
    await s.faucet.claim(input, '127.0.0.1'); expect(s.broadcasts).toHaveLength(2);
  });
  it('counts global and IP limits after restart without treating reverted transactions as successful', async () => {
    const s = setup({ ipDailyLimit: 1, dailyLimit: 2 }); const first = await s.faucet.claim(await s.signed(s.challenge()), '127.0.0.1');
    s.restart(); expect(() => s.challenge('BEM')).toThrow(/名额/);
    s.setConfirm(false); const buyer = ethers.Wallet.createRandom(), second = await s.faucet.claim(await s.signed(s.challenge('BEM', buyer, 'ip-2'), buyer), 'ip-2');
    s.receipts.set(second.txHash, { status: 0 }); expect((await s.faucet.status(second.id)).status).toBe('reverted');
    expect(first.status).toBe('confirmed'); expect(() => s.challenge('USDC', ethers.Wallet.createRandom(), 'ip-3')).toThrow(/名额/);
  });
});
