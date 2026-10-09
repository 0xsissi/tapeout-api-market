// Explicit setup for the BSC testnet faucet. Preview by default; --broadcast funds it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { TEST_ASSETS, createFaucetChain } from './lib/market-faucet.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = process.env.TAM_FAUCET_STATE_DIR, ownerDirectory = process.env.TAM_BSC_TESTNET_STATE_DIR;
for (const folder of [directory, ownerDirectory]) {
  if (!folder || !path.isAbsolute(folder)) throw new Error('Provide protected TAM_FAUCET_STATE_DIR and TAM_BSC_TESTNET_STATE_DIR outside Git.');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(folder));
  if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error('Wallets and funding journal must stay outside Git.');
}
const write = (file, value) => { const temporary = file + '.tmp'; const fd = fs.openSync(temporary, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temporary, file); };
const file = path.join(directory, 'faucet-wallet.json');
if (!fs.existsSync(file)) { const wallet = ethers.Wallet.createRandom(); write(file, { address: wallet.address, privateKey: wallet.privateKey }); }
const saved = JSON.parse(fs.readFileSync(file, 'utf8')), wallet = new ethers.Wallet(saved.privateKey);
assert.equal(wallet.address, saved.address);
const ownerSaved = JSON.parse(fs.readFileSync(path.join(ownerDirectory, 'deployer-wallet.json'), 'utf8')), owner = new ethers.Wallet(ownerSaved.privateKey);
assert.equal(owner.address, ownerSaved.address); assert.notEqual(owner.address, wallet.address);
const chain = createFaucetChain(process.env.TAM_FAUCET_RPC_URL || 'https://bsc-testnet-dataseed.bnbchain.org');
let lock;
try {
  await chain.verifyAssets();
  const abi = new ethers.Interface(['function transfer(address,uint256) returns(bool)']);
  const planned = [
    { label: 'gas-0.005', to: wallet.address, value: ethers.parseEther('0.005'), data: '0x', amount: '0.005 tBNB' },
    ...Object.entries(TEST_ASSETS).map(([currency, asset]) => ({ label: 'initial-' + currency, to: asset.address, value: 0n,
      data: abi.encodeFunctionData('transfer', [wallet.address, ethers.parseUnits(currency === 'USDC' ? '1000' : '10000', asset.decimals)]), amount: currency === 'USDC' ? '1000 tUSDC' : '10000 tBEM' })),
  ];
  if (!process.argv.includes('--broadcast')) {
    console.log(JSON.stringify({ chainId: 97, from: owner.address, dedicatedFaucetWallet: wallet.address, transfers: planned.map(p => ({ label: p.label, amount: p.amount, to: p.to })), inventory: await chain.inventory(wallet.address), sendsTransactions: false }));
  } else {
    const proposedLock = path.join(directory, 'funding.lock'); fs.mkdirSync(proposedLock); lock = proposedLock;
    const journalFile = path.join(directory, 'funding-transactions.json');
    const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : { chainId: 97, owner: owner.address, recipient: wallet.address, entries: [] };
    assert.equal(journal.chainId, 97); assert.equal(journal.owner, owner.address); assert.equal(journal.recipient, wallet.address);
    for (const plannedTx of planned) {
      await chain.assertNetwork(); let record = journal.entries.find(r => r.label === plannedTx.label);
      if (!record) {
        const gasPrice = await chain.getGasPrice(); assert.ok(gasPrice <= 1_000_000_000n, 'Gas exceeds 1 gwei');
        const gasLimit = (await chain.estimateGas({ to: plannedTx.to, data: plannedTx.data, value: plannedTx.value, from: owner.address })) * 120n / 100n;
        assert.ok(gasLimit <= 100_000n);
        const raw = await owner.signTransaction({ to: plannedTx.to, data: plannedTx.data, value: plannedTx.value, chainId: 97, nonce: await chain.getNonce(owner.address), gasPrice, gasLimit, type: 0 });
        record = { label: plannedTx.label, hash: ethers.keccak256(raw), raw }; journal.entries.push(record); write(journalFile, journal);
      }
      const tx = ethers.Transaction.from(record.raw); assert.equal(tx.chainId, 97n); assert.equal(tx.from, owner.address);
      assert.equal(tx.to.toLowerCase(), plannedTx.to.toLowerCase()); assert.equal(tx.value, plannedTx.value); assert.equal(tx.data, plannedTx.data); assert.equal(ethers.keccak256(record.raw), record.hash);
      let receipt = await chain.receipt(record.hash);
      if (!receipt) {
        try { await chain.broadcast(record.raw); } catch { /* preserve bytes if RPC outcome is uncertain */ }
        const deadline = Date.now() + 60_000;
        while (!receipt && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1500)); receipt = await chain.receipt(record.hash); }
      }
      assert.equal(receipt?.status, 1, `Funding pending or reverted; resume with the same journal: ${record.hash}`);
      record.status = 'confirmed'; write(journalFile, journal);
      console.log(JSON.stringify({ label: record.label, hash: record.hash, status: record.status }));
    }
    console.log(JSON.stringify({ dedicatedFaucetWallet: wallet.address, inventory: await chain.inventory(wallet.address) }));
  }
} finally { chain.close(); if (lock) fs.rmdirSync(lock); }
