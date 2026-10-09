import { describe, expect, it } from 'vitest';
import { privacyIssues } from './privacy-check.mjs';

const issues = (filename: string, content: string, terms: string[] = []) => privacyIssues(filename, Buffer.from(content), terms);
describe('publication privacy guard', () => {
  it('rejects Windows, macOS and Linux home paths, including escaped separators', () => {
    for (const home of ['C:' + '\\'.repeat(2) + 'Users' + '\\'.repeat(2) + 'private-account', '/' + 'Users/private-account', '/' + 'home/private-account']) {
      expect(issues('docs/example.md', home)).toEqual(['absolute home path']);
    }
  });
  it('accepts portable paths and synthetic workspace fixtures', () => {
    expect(issues('docs/example.md', '~/.clawmarket/api-token ../../report/example.md /fixture/client')).toEqual([]);
  });
  it('rejects operational evidence, signing state and credential-shaped values without echoing them', () => {
    for (const file of ['report/screenshot.png', 'backup.bundle', 'runtime/faucet-ledger.json', 'data/deployer-wallet.json', 'id_ed25519']) expect(issues(file, 'fixture').length).toBeGreaterThan(0);
    expect(issues('src/example.ts', 'gh' + 'p_' + 'A'.repeat(36))).toEqual(['credential pattern']);
    expect(issues('src/example.ts', '-----BEGIN ' + 'PRIVATE KEY-----')).toEqual(['credential pattern']);
  });
  it('checks case-insensitive private terms in content, binary metadata and filenames without echoing the term', () => {
    expect(issues('docs/example.md', '\0PRIVATE-ACCOUNT\0', ['private-account'])).toEqual(['private term']);
    expect(issues('private-account/report.md', 'example', ['private-account'])).toEqual(['private term']);
  });
  it('rejects credential files and directories while preserving source and example configurations', () => {
    for (const file of ['wallet.json', 'api-token', 'tmp/tam-agent-token-usdc-bsc-testnet', '.env.production', 'data/auths/account.json', '.clawmarket/config.json']) expect(issues(file, 'example').length).toBeGreaterThan(0);
    for (const file of ['packages/cli/src/wallet/store.ts', 'deploy/env/buyer.env.example', '.env.example']) expect(issues(file, 'example')).toEqual([]);
  });
  it('preserves vendor paths while checking explicit private terms there', () => {
    const file = 'packages/contracts/lib/vendor/audit.pdf', content = '/' + 'home/upstream-account';
    expect(issues(file, content)).toEqual([]);
    expect(issues(file, content, ['upstream-account'])).toEqual(['private term']);
  });
});
