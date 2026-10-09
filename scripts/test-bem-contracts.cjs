/* Local Anvil EVM only. Dependency setup is documented in docs/bem-settlement.md. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const deps = createRequire(path.resolve(process.env.CLAWMARKET_CONTRACT_TEST_DEPS || root, 'package.json'));
const solc = deps('solc'), ethers = require('ethers');
const { spawn } = require('node:child_process');
const fixture = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract TestBEM is ERC20 {
    bool public taxed;
    uint8 private precision;
    constructor(uint8 value) ERC20("Fixture BEM", "BEM") { precision = value; }
    function decimals() public view override returns (uint8) { return precision; }
    function mint(address to, uint256 value) external { _mint(to, value); }
    function enableTax() external { taxed = true; }
    function _update(address from, address to, uint256 value) internal override {
        if (taxed && from != address(0) && to != address(0)) {
            super._update(from, address(0), value / 100);
            super._update(from, to, value - value / 100);
        } else super._update(from, to, value);
    }
}`;
const sources = { 'Fixture.sol': { content: fixture } };
for (const f of ['BEMEscrowPool.sol', 'EscrowPool.sol']) sources[f] = { content: fs.readFileSync(path.join(root, 'packages/contracts/src', f), 'utf8') };
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
  settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), {
  import: name => {
    const target = name.startsWith('@openzeppelin/contracts/') ? path.join(root, 'packages/contracts/lib/openzeppelin-contracts/contracts', name.slice('@openzeppelin/contracts/'.length)) : path.join(root, 'packages/contracts/src', name);
    try { return { contents: fs.readFileSync(target, 'utf8') }; } catch { return { error: 'Missing import: ' + name }; }
  },
}));
const errors = (output.errors || []).filter(e => e.severity === 'error');
assert.equal(errors.length, 0, errors.map(e => e.formattedMessage).join('\n'));

async function main() {
  const port = process.env.BEM_TEST_PORT || '18545';
  const fixturePhrase = 'test test test test test test test test test test test junk';
  const child = spawn(process.env.ANVIL_BINARY || 'anvil', ['--silent', '--host', '127.0.0.1', '--port', port, '--chain-id', '56', '--hardfork', 'cancun', '--mnemonic', fixturePhrase], { stdio: 'ignore', windowsHide: true });
  let startError; child.on('error', e => { startError = e; });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 56, { staticNetwork: true }); provider.pollingInterval = 50;
  const evm = { request: ({ method, params }) => provider.send(method, params) };
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (startError) throw startError;
      if (child.exitCode != null) throw new Error('Local Anvil failed to start');
      try { await provider.send('eth_chainId', []); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!ready) throw new Error('Local Anvil startup timed out');
    const buyer = await provider.getSigner(0), seller = await provider.getSigner(1), treasury = await provider.getSigner(2);
    const buyerAddress = await buyer.getAddress(), sellerAddress = await seller.getAddress(), treasuryAddress = await treasury.getAddress();
    const signer = ethers.Wallet.fromPhrase(fixturePhrase); // fixture only, never use for real funds
    assert.equal(signer.address, buyerAddress);
    async function deploy(file, name, args) {
      const artifact = output.contracts[file][name];
      const contract = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, buyer).deploy(...args);
      await contract.waitForDeployment(); return contract;
    }
    const token = await deploy('Fixture.sol', 'TestBEM', [8]);
    const pool = await deploy('BEMEscrowPool.sol', 'BEMEscrowPool', [await token.getAddress(), treasuryAddress]);
    const poolAddress = await pool.getAddress();
    await (await token.mint(buyerAddress, 1000_00000000n)).wait();
    await (await token.approve(poolAddress, 20_00000000n)).wait();
    await (await pool.deposit(20_00000000n)).wait();
    assert.equal(await pool.getBalance(buyerAddress), 20_00000000n);
    assert.equal(await pool.settlementToken(), await token.getAddress());
    const shared = await import('../packages/shared/dist/index.js');
    await shared.assertPaymentDeployment(poolAddress, `http://127.0.0.1:${port}`, 56, { ...shared.BEM_PAYMENT_TOKEN, address: await token.getAddress() });
    console.log('PASS: 8-decimal approve + deposit credits exactly 20 BEM');
    const domain = { name: 'ClawEscrowPool', version: '1', chainId: 56, verifyingContract: poolAddress };
    const types = { Authorization: [ { name: 'buyer', type: 'address' }, { name: 'seller', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'expiresAt', type: 'uint256' }, { name: 'poolId', type: 'bytes32' }, { name: 'nonceMode', type: 'uint8' } ] };
    const block = await provider.getBlock('latest');
    const auth = { buyer: buyerAddress, seller: sellerAddress, amount: 5_00000000n, nonce: 1n, expiresAt: block.timestamp + 1200, poolId: await pool.POOL_ID(), nonceMode: 1 };
    // A non-spendable initial commitment must not debit the buyer even if sent to claim().
    const intentSignature = await signer.signTypedData({ ...domain, name: 'ClawInferenceIntent' }, types, auth);
    await (await pool.connect(seller).claim([auth], [intentSignature])).wait();
    assert.equal(await pool.getBalance(buyerAddress), 20_00000000n);
    console.log('PASS: wrong-domain budget signature cannot collect payment');
    const signature = await signer.signTypedData(domain, types, auth);
    await (await pool.connect(seller).claim([auth], [signature])).wait();
    assert.equal(await pool.getBalance(buyerAddress), 15_00000000n);
    assert.equal(await token.balanceOf(sellerAddress), 4_95000000n);
    assert.equal(await pool.accruedProtocolFees(), 5_000_000n);
    console.log('PASS: final 5 BEM payment yields 4.95 BEM seller + 0.05 BEM fee');
    await (await pool.connect(seller).claim([auth], [signature])).wait();
    assert.equal(await token.balanceOf(sellerAddress), 4_95000000n);
    const second = { ...auth, nonce: 2n };
    await (await pool.connect(seller).claim([second], [await signer.signTypedData({ ...domain, chainId: 84532 }, types, second)])).wait();
    assert.equal(await pool.getBalance(buyerAddress), 15_00000000n);
    console.log('PASS: duplicate nonce and cross-chain signatures cannot collect twice');
    await assert.rejects(pool.setMiningRewards(sellerAddress));
    const wrongPrecision = await deploy('Fixture.sol', 'TestBEM', [6]);
    await assert.rejects(deploy('BEMEscrowPool.sol', 'BEMEscrowPool', [await wrongPrecision.getAddress(), treasuryAddress]));
    console.log('PASS: BEM pool rejects USDC precision and USDC mining rewards');
    await (await pool.requestWithdraw(15_00000000n)).wait();
    await assert.rejects(pool.completeWithdraw());
    await evm.request({ method: 'evm_increaseTime', params: [48 * 3600 + 1] });
    await evm.request({ method: 'evm_mine', params: [] });
    await (await pool.completeWithdraw({ gasLimit: 500000n })).wait();
    assert.equal(await pool.getBalance(buyerAddress), 0n);
    assert.equal(await token.balanceOf(buyerAddress), 995_00000000n);
    await (await pool.withdrawProtocolFees(5_000_000n)).wait();
    assert.equal(await token.balanceOf(treasuryAddress), 5_000_000n);
    console.log('PASS: delayed withdrawal and treasury fees retain BEM precision');
    await (await token.enableTax()).wait();
    await (await token.approve(poolAddress, 10_00000000n)).wait();
    await assert.rejects(pool.deposit(10_00000000n));
    assert.equal(await pool.getBalance(buyerAddress), 0n);
    console.log('PASS: fee-on-transfer deposits fail atomically without false credit');
    console.log('Solidity 0.8.26 compilation + 7 local EVM scenarios passed. No live RPC or real funds used.');
  } finally { provider.destroy(); child.kill(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
