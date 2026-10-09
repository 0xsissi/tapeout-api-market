const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
// Git may check out CRLF on Windows; use LF so Solidity metadata stays reproducible.
const readSource = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function compileBemContracts(currency = 'BEM') {
  if (!['BEM', 'USDC'].includes(currency)) throw new Error('Currency must be BEM or USDC.');
  const deps = createRequire(path.resolve(process.env.CLAWMARKET_CONTRACT_TEST_DEPS || root, 'package.json'));
  const solc = deps('solc');
  if (!solc.version().startsWith('0.8.26+')) throw new Error('Use pinned solc-js 0.8.26.');
  const sources = {};
  const tokenName = currency === 'BEM' ? 'TestBEM' : 'TestUSDC';
  const poolName = currency === 'BEM' ? 'BEMEscrowPool' : 'EscrowPool';
  for (const name of currency === 'BEM' ? ['TestBEM.sol', 'BEMEscrowPool.sol', 'EscrowPool.sol'] : ['TestUSDC.sol', 'EscrowPool.sol']) sources[name] = { content: readSource(path.join(root, 'packages/contracts/src', name)) };
  const input = { language: 'Solidity', sources, settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } };
  const imports = {};
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: name => {
    const target = name.startsWith('@openzeppelin/contracts/') ? path.join(root, 'packages/contracts/lib/openzeppelin-contracts/contracts', name.slice('@openzeppelin/contracts/'.length)) : path.join(root, 'packages/contracts/src', name);
    try { const content = readSource(target); imports[name] = { content }; return { contents: content }; } catch { return { error: 'Missing import: ' + name }; }
  } }));
  const errors = (output.errors || []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  return { token: output.contracts[`${tokenName}.sol`][tokenName], pool: output.contracts[`${poolName}.sol`][poolName],
    compiler: solc.version(), input: { ...input, sources: { ...sources, ...imports } } };
}
module.exports = { compileBemContracts };
