import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function privateTermsFromEnv(env = process.env) {
  return (env.TAM_PRIVATE_TERMS || '').split(',').map(value => value.trim()).filter(Boolean);
}

/** Return categories only: diagnostics must never echo private content. */
export function privacyIssues(filename, bytes, privateTerms = []) {
  const issues = [];
  const text = bytes.toString('utf8'), lower = text.toLowerCase();
  if (privateTerms.some(term => lower.includes(term.toLowerCase()) || filename.toLowerCase().includes(term.toLowerCase()))) issues.push('private term');
  // Vendored audit PDFs/workflows may contain upstream authors' paths.
  // Explicit private terms still apply to every byte, including vendor files.
  if (!filename.startsWith('packages/contracts/lib/') && /(?:[a-z]:[\\/]+users[\\/]+|\/(?:users|home)\/)[a-z0-9_.-]+/i.test(text)) issues.push('absolute home path');
  if (/(?:^|\/)(?:api-token|tam-agent-token[^/]*|wallet\.json|\.env(?:\..*)?)$/i.test(filename) && !/\.example$/i.test(filename)) issues.push('private runtime file');
  if (/(?:^|\/)(?:\.clawmarket(?:-provider)?|auths|keystore)\//i.test(filename)) issues.push('private runtime directory');
  if (/(?:^|\/)(?:report|publication-backups)\//i.test(filename) || /\.(?:bundle|log)$/i.test(filename)) issues.push('private operational evidence');
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{48,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text)) issues.push('credential pattern');
  if (/(?:^|\/)(?:id_rsa|id_ed25519|deployer-wallet\.json|smoke-accounts\.json|faucet-wallet\.json|faucet-ledger\.json|transactions\.json)$/i.test(filename)) issues.push('private signing state');
  return issues;
}

export function auditTrackedPrivacy(root, { staged = false, privateTerms = privateTermsFromEnv() } = {}) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'];
  const files = execFileSync('git', args, { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  const failures = [];
  for (const filename of files) {
    const file = path.join(root, filename);
    if (!staged && !fs.existsSync(file)) continue;
    const bytes = staged ? execFileSync('git', ['show', ':' + filename], { cwd: root, maxBuffer: 32 * 1024 * 1024 }) : fs.readFileSync(file);
    const issues = privacyIssues(filename, bytes, privateTerms);
    if (issues.length) failures.push({ file: filename, issues });
  }
  if (failures.length) throw new Error('Privacy check failed: ' + JSON.stringify(failures));
  return { scannedFiles: files.length, privacyIssues: 0 };
}
