import { probeClaude } from './claude.js';
import { probeCodex } from './codex.js';
import { probeGemini } from './gemini.js';
import type { ProbeResult } from './types.js';

export type { ProbeResult } from './types.js';
export { probeClaude, probeCodex, probeGemini };

export async function probeAllAccounts(
  accounts: Array<{ authIndex: string; upstream: 'codex' | 'claude' | 'gemini'; authFile?: string }>,
  cliproxyUrl: string,
): Promise<Array<{ authIndex: string; result: ProbeResult }>> {
  return Promise.all(accounts.map(async (account) => {
    const result =
      account.upstream === 'codex'
        ? await probeCodex(account.authFile)
        : account.upstream === 'claude'
          ? await probeClaude(cliproxyUrl, account.authIndex)
          : await probeGemini(account.authFile);
    return { authIndex: account.authIndex, result };
  }));
}
