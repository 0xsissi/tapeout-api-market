// BSC testnet ONLY. Prepare by default; --broadcast sends the two reviewed deployments.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { ethers } = require('ethers');
const { compileBemContracts } = require('./lib/compile-bem-contracts.cjs');
const chainId = 97n;
const stateDir = process.env.TAM_BSC_TESTNET_STATE_DIR;
const rpcUrl = process.env.TAM_BSC_TESTNET_RPC_URL || 'https://bsc-testnet-dataseed.bnbchain.org';
const zero = ethers.ZeroAddress;
const currencyIndex = process.argv.indexOf('--payment-token');
const currency = currencyIndex < 0 ? 'BEM' : process.argv[currencyIndex + 1];
if (!['BEM', 'USDC'].includes(currency)) throw new Error('--payment-token requires BEM or USDC.');
const decimals = currency === 'BEM' ? 8 : 6;
const units = value => ethers.parseUnits(String(value), decimals);
const poolArgs = (token, treasury) => currency === 'BEM' ? [token, treasury] : [token, treasury, zero];

function write(name, value) {
  const file = path.join(stateDir, name), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function read(name) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertChain(provider) {
  if (BigInt(await provider.send('eth_chainId', [])) !== chainId) throw new Error('Refusing to use any network except BSC testnet chain 97.');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function simulate(artifacts) {
  const port = await freePort();
  const binary = process.env.ANVIL_BINARY || 'anvil';
  const child = spawn(binary, ['--silent', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '97', '--hardfork', 'cancun'], { stdio: 'ignore', windowsHide: true });
  let spawnError; child.on('error', error => { spawnError = error; });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 97, { staticNetwork: true }); provider.pollingInterval = 100;
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Local Anvil simulation exited.');
      try { await assertChain(provider); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!ready) throw new Error('Local Anvil startup timed out.');
    const signer = await provider.getSigner(0), seller = await provider.getSigner(1);
    const owner = await signer.getAddress();
    const token = await new ethers.ContractFactory(artifacts.token.abi, artifacts.token.evm.bytecode.object, signer).deploy();
    const tokenReceipt = await token.deploymentTransaction().wait();
    const pool = await new ethers.ContractFactory(artifacts.pool.abi, artifacts.pool.evm.bytecode.object, signer).deploy(...poolArgs(await token.getAddress(), owner));
    const poolReceipt = await pool.deploymentTransaction().wait();
    if (await token.decimals() !== BigInt(decimals) || await token.symbol() !== `t${currency}` || await token.owner() !== owner || await token.totalSupply() !== units(1000000) || await pool.usdc() !== await token.getAddress() || await pool.miningRewards() !== zero) throw new Error('Local deployment properties differ from the reviewed plan.');
    let unauthorizedMintRejected = false;
    try { await token.connect(seller).mint(owner, 1n); } catch (error) {
      unauthorizedMintRejected = token.interface.parseError(error.data)?.name === 'OwnableUnauthorizedAccount';
    }
    if (!unauthorizedMintRejected || await token.totalSupply() !== units(1000000)) throw new Error('The test faucet must only permit the owner to mint.');
    await (await token.mint(await seller.getAddress(), units(1))).wait();
    if (await token.balanceOf(await seller.getAddress()) !== units(1)) throw new Error('Owner test-token mint did not credit the intended account.');
    if (currency === 'USDC') {
      const deadline = (await provider.getBlock('latest')).timestamp + 600;
      const permitTypes = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
      const permit = ethers.Signature.from(await signer.signTypedData({ name: 'TAM Test USDC', version: '1', chainId: 97, verifyingContract: await token.getAddress() }, permitTypes, { owner, spender: await pool.getAddress(), value: units(20), nonce: await token.nonces(owner), deadline }));
      await (await token.permit(owner, await pool.getAddress(), units(20), deadline, permit.v, permit.r, permit.s)).wait();
    } else {
      await (await token.approve(await pool.getAddress(), units(20))).wait();
    }
    await (await pool.deposit(units(20))).wait();
    const block = await provider.getBlock('latest');
    const auth = { buyer: owner, seller: await seller.getAddress(), amount: units(5), nonce: 1n, expiresAt: block.timestamp + 600, poolId: await pool.POOL_ID(), nonceMode: 1 };
    const types = { Authorization: [{ name: 'buyer', type: 'address' }, { name: 'seller', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'expiresAt', type: 'uint256' }, { name: 'poolId', type: 'bytes32' }, { name: 'nonceMode', type: 'uint8' }] };
    const domain = { name: 'ClawEscrowPool', version: '1', chainId: 97, verifyingContract: await pool.getAddress() };
    const signature = await signer.signTypedData(domain, types, auth);
    await (await pool.connect(seller).claim([auth], [signature])).wait();
    if (await pool.getBalance(owner) !== units(15) || await token.balanceOf(auth.seller) !== units('5.95') || await pool.accruedProtocolFees() !== units('0.05')) throw new Error('Testnet settlement precision or fees are incorrect.');
    await (await pool.connect(seller).claim([auth], [signature])).wait();
    if (await pool.getBalance(owner) !== units(15)) throw new Error('Duplicate authorization debited twice.');
    await provider.send('anvil_setChainId', [56]);
    let mainnetRejected = false;
    try { await new ethers.ContractFactory(artifacts.token.abi, artifacts.token.evm.bytecode.object, signer).deploy(); } catch (error) {
      mainnetRejected = error.reason === `Test${currency} requires BSC testnet`;
    }
    if (!mainnetRejected) throw new Error('The test token must reject deployment on chain 56.');
    return { tokenGas: tokenReceipt.gasUsed.toString(), poolGas: poolReceipt.gasUsed.toString(), chain: 97, settlement: '20 deposit / 5 payment / 4.95 seller / 0.05 fees', duplicateNonce: 'skipped without second debit', mainnetTestTokenDeployment: 'rejected', testFaucet: 'owner-only mint verified' };
  } finally {
    provider.destroy();
    if (child.exitCode === null && !spawnError) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  }
}
async function verify(provider, plan) {
  await assertChain(provider);
  const token = new ethers.Contract(plan.tokenAddress, plan.tokenAbi, provider);
  const pool = new ethers.Contract(plan.poolAddress, plan.poolAbi, provider);
  const [tokenCode, poolCode, decimals, symbol, totalSupply, tokenOwner, settlementToken, owner, treasury, mining, fee] = await Promise.all([
    provider.getCode(plan.tokenAddress), provider.getCode(plan.poolAddress), token.decimals(), token.symbol(), token.totalSupply(), token.owner(), pool.usdc(), pool.owner(), pool.treasury(), pool.miningRewards(), pool.protocolFeeBps(),
  ]);
  const equal = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (tokenCode === '0x' || poolCode === '0x' || decimals !== BigInt(currency === 'BEM' ? 8 : 6) || symbol !== `t${currency}` || totalSupply !== units(1000000) || !equal(tokenOwner, plan.deployer) || !equal(owner, plan.deployer) || !equal(treasury, plan.treasury) || !equal(settlementToken, plan.tokenAddress) || mining !== zero || fee !== 100n) throw new Error('Deployed contracts do not match the approved testnet plan.');
  const result = { chainId: 97, rpcUrl, currency, deployer: plan.deployer, treasury: plan.treasury, testToken: plan.tokenAddress, testTokenSymbol: `t${currency}`, decimals: currency === 'BEM' ? 8 : 6, initialSupply: '1000000', escrowPool: plan.poolAddress, protocolFeeBps: 100, miningEnabled: false, verifiedAt: new Date().toISOString() };
  write('deployment.json', result); return result;
}
async function main() {
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('Set TAM_BSC_TESTNET_STATE_DIR to an owner-protected absolute directory outside the repository.');
  const root = path.resolve(__dirname, '..');
  const relativeStateDir = path.relative(root, path.resolve(stateDir));
  if (relativeStateDir !== '..' && !relativeStateDir.startsWith('..' + path.sep) && !path.isAbsolute(relativeStateDir)) throw new Error('Deployment wallet and journals must be outside the repository.');
  const saved = read('deployer-wallet.json');
  if (!saved || !saved.privateKey || new ethers.Wallet(saved.privateKey).address !== saved.address) throw new Error('Deployment wallet is missing or invalid.');
  const artifacts = compileBemContracts(currency);
  const provider = new ethers.JsonRpcProvider(rpcUrl, 97, { staticNetwork: true }); provider.pollingInterval = 1_000;
  try {
    await assertChain(provider);
    const wallet = new ethers.Wallet(saved.privateKey, provider);
    const treasury = process.env.TAM_TEST_TREASURY_ADDRESS || wallet.address;
    if (!ethers.isAddress(treasury) || treasury === zero) throw new Error('A controlled, nonzero test treasury is required.');
    let plan = read('plan.json');
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    if (plan && ((plan.currency ?? 'BEM') !== currency || plan.deployer !== wallet.address || plan.chainId !== 97 || plan.treasury !== treasury || plan.tokenBytecodeHash !== ethers.keccak256('0x' + artifacts.token.evm.bytecode.object) || plan.poolBytecodeHash !== ethers.keccak256('0x' + artifacts.pool.evm.bytecode.object))) throw new Error('Existing plan differs from the wallet or source. Keep its journal and review before using another plan.');
    if (!plan) {
      plan = { chainId: 97, currency, rpcUrl, deployer: wallet.address, treasury, nonce, tokenAddress: ethers.getCreateAddress({ from: wallet.address, nonce }), poolAddress: ethers.getCreateAddress({ from: wallet.address, nonce: nonce + 1 }), tokenBytecodeHash: ethers.keccak256('0x' + artifacts.token.evm.bytecode.object), poolBytecodeHash: ethers.keccak256('0x' + artifacts.pool.evm.bytecode.object), compiler: artifacts.compiler, tokenAbi: artifacts.token.abi, poolAbi: artifacts.pool.abi, preparedAt: new Date().toISOString() };
      write('plan.json', plan); write('standard-input.json', artifacts.input);
    }
    if (!process.argv.includes('--broadcast')) {
      const simulation = await simulate(artifacts);
      const [balance, price] = await Promise.all([provider.getBalance(wallet.address), provider.send('eth_gasPrice', [])]);
      const gasPrice = BigInt(price), gas = BigInt(simulation.tokenGas) + BigInt(simulation.poolGas);
      const gasBudget = gas * 150n / 100n;
      const status = { chainId: 97, deployer: wallet.address, balanceTbnb: ethers.formatEther(balance), gasPriceGwei: ethers.formatUnits(gasPrice, 9), simulation, estimatedDeploymentTbnb: ethers.formatEther(gas * gasPrice), deploymentBudgetTbnb: ethers.formatEther(gasBudget * gasPrice), recommendedFundingTbnb: '0.01', tokenGasLimit: (BigInt(simulation.tokenGas) * 150n / 100n).toString(), poolGasLimit: (BigInt(simulation.poolGas) * 150n / 100n).toString(), status: balance >= gasBudget * gasPrice ? 'ready for broadcast' : 'waiting for testnet gas', realTransactions: 0 };
      write('preflight.json', status); console.log(JSON.stringify(status)); return;
    }
    const preflight = read('preflight.json');
    if (!preflight) throw new Error('Run --prepare and review the simulation before broadcasting.');
    const journal = read('transactions.json') || { chainId: 97, deployer: wallet.address, entries: [] };
    if (journal.chainId !== 97 || journal.deployer !== wallet.address) throw new Error('Journal is from another deployment.');
    for (const name of ['token', 'pool']) {
      await assertChain(provider);
      let entry = journal.entries.find(item => item.name === name);
      const wantedNonce = plan.nonce + (name === 'token' ? 0 : 1);
      if (!entry) {
        if (await provider.getTransactionCount(wallet.address, 'pending') !== wantedNonce) throw new Error('Unexpected account nonce. Review existing transactions before continuing.');
        const factory = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].evm.bytecode.object, wallet);
        const tx = await factory.getDeployTransaction(...(name === 'pool' ? poolArgs(plan.tokenAddress, treasury) : []));
        const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
        if (gasPrice > ethers.parseUnits('1', 9)) throw new Error('Testnet gas price is above the 1 gwei budget cap; review before retrying.');
        const gasLimit = BigInt(preflight[`${name}GasLimit`]);
        if (await provider.getBalance(wallet.address) < gasPrice * gasLimit) throw new Error(`Insufficient tBNB: send BSC testnet gas to ${wallet.address}.`);
        const raw = await wallet.signTransaction({ ...tx, chainId, nonce: wantedNonce, gasPrice, gasLimit, type: 0, value: 0 });
        const parsed = ethers.Transaction.from(raw);
        if (parsed.chainId !== 97n || parsed.to !== null || parsed.value !== 0n) throw new Error('Signed transaction is outside the reviewed deployment scope.');
        entry = { name, nonce: wantedNonce, hash: ethers.keccak256(raw), raw, createdAt: new Date().toISOString(), status: 'signed' };
        journal.entries.push(entry); write('transactions.json', journal);
      }
      let receipt = await provider.getTransactionReceipt(entry.hash);
      if (!receipt) {
        if (!await provider.getTransaction(entry.hash)) {
          await assertChain(provider);
          const parsed = ethers.Transaction.from(entry.raw);
          const factory = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].evm.bytecode.object, wallet);
          const expected = await factory.getDeployTransaction(...(name === 'pool' ? poolArgs(plan.tokenAddress, treasury) : []));
          if (parsed.chainId !== 97n || parsed.to !== null || parsed.value !== 0n || parsed.nonce !== wantedNonce || parsed.from !== wallet.address || parsed.data !== expected.data || ethers.keccak256(entry.raw) !== entry.hash) throw new Error('Saved transaction does not match the reviewed deployment.');
          // Re-broadcasting identical raw bytes reuses the nonce and hash, never a new payment.
          await provider.broadcastTransaction(entry.raw);
          entry.status = 'broadcast'; write('transactions.json', journal);
        }
        receipt = await provider.waitForTransaction(entry.hash, 1, 60_000);
      }
      if (!receipt) throw new Error(`Deployment pending: ${entry.hash}. Preserve the journal; do not use another nonce.`);
      if (receipt.status !== 1) throw new Error(`Deployment reverted: ${entry.hash}`);
      const expectedAddress = name === 'token' ? plan.tokenAddress : plan.poolAddress;
      if (receipt.contractAddress?.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('Unexpected contract address.');
      entry.status = 'confirmed'; entry.contractAddress = receipt.contractAddress; entry.blockNumber = receipt.blockNumber; entry.gasUsed = receipt.gasUsed.toString(); write('transactions.json', journal);
      console.log(JSON.stringify({ name, chainId: 97, address: entry.contractAddress, transaction: entry.hash, status: 'confirmed' }));
    }
    console.log(JSON.stringify(await verify(provider, plan)));
  } finally { provider.destroy(); }
}
main().catch(error => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
