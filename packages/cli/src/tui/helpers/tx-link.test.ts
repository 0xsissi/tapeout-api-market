import { afterEach, describe, expect, it, vi } from 'vitest';

const hash = '0xf33591d2317ac6fd949bc540a9643e2f1983c2539cbd0845b487cef3abc74de3';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('settlement transaction links', () => {
  it.each([
    ['USDC', 'bsc-testnet', 'https://testnet.bscscan.com'],
    ['BEM', 'bsc-testnet', 'https://testnet.bscscan.com'],
    ['USDC', 'default', 'https://sepolia.basescan.org'],
    ['BEM', 'default', 'https://bscscan.com'],
  ])('uses the selected chain explorer for %s on %s', async (symbol, network, explorer) => {
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', symbol);
    vi.stubEnv('CLAWMARKET_PAYMENT_NETWORK', network);
    vi.stubEnv('CLAW_DISABLE_OSC8', '1');
    vi.resetModules();
    const { formatTxUrl, formatTxLink } = await import('./tx-link.js');
    expect(formatTxUrl(hash)).toBe(`${explorer}/tx/${hash}`);
    expect(formatTxLink(hash)).toBe(`${explorer}/tx/${hash}`);
  });

  it('uses the same BSC testnet destination inside the terminal hyperlink', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'USDC');
    vi.stubEnv('CLAWMARKET_PAYMENT_NETWORK', 'bsc-testnet');
    vi.stubEnv('CLAW_DISABLE_OSC8', '0');
    vi.stubEnv('TERM', 'xterm');
    vi.stubEnv('TERM_PROGRAM', 'WezTerm');
    vi.resetModules();
    const { formatTxLink } = await import('./tx-link.js');
    const url = `https://testnet.bscscan.com/tx/${hash}`;
    expect(formatTxLink(hash, 'View')).toBe(`${url}  \u001B]8;;${url}\u0007View\u001B]8;;\u0007`);
  });
});
