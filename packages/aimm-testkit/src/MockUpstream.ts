export interface MockUpstreamAccount {
  id: string;
  credits: number;
  modelWeights: Record<string, number>;
  defaultWeight?: number;
  headers?: Record<string, string>;
  latencyMs?: number;
}

export interface MockUpstreamRequest {
  accountId: string;
  model: string;
  totalTokens: number;
}

export interface MockUpstreamResponse {
  ok: boolean;
  status: 200 | 429;
  usedCredits: number;
  remainingCredits: number;
  totalTokens: number;
  headers: Record<string, string>;
  latencyMs: number;
}

export class MockUpstream {
  private readonly accounts = new Map<string, MockUpstreamAccount>();
  private readonly usedCredits = new Map<string, number>();

  constructor(accounts: MockUpstreamAccount[]) {
    for (const account of accounts) {
      this.accounts.set(account.id, account);
      this.usedCredits.set(account.id, 0);
    }
  }

  request(input: MockUpstreamRequest): MockUpstreamResponse {
    const account = this.accounts.get(input.accountId);
    if (!account) throw new Error(`Unknown mock upstream account: ${input.accountId}`);
    const credit = this.creditsFor(account, input.model, input.totalTokens);
    const used = this.usedCredits.get(account.id) ?? 0;
    if (used + credit > account.credits) {
      return {
        ok: false,
        status: 429,
        usedCredits: used,
        remainingCredits: Math.max(0, account.credits - used),
        totalTokens: input.totalTokens,
        headers: this.headersFor(account, used),
        latencyMs: account.latencyMs ?? 0,
      };
    }
    this.usedCredits.set(account.id, used + credit);
    return {
      ok: true,
      status: 200,
      usedCredits: used + credit,
      remainingCredits: account.credits - used - credit,
      totalTokens: input.totalTokens,
      headers: this.headersFor(account, used + credit),
      latencyMs: account.latencyMs ?? 0,
    };
  }

  utilization(accountId: string): number {
    const account = this.accounts.get(accountId);
    if (!account) return 0;
    return Math.min((this.usedCredits.get(accountId) ?? 0) / account.credits, 0.999);
  }

  reset(): void {
    for (const accountId of this.accounts.keys()) {
      this.usedCredits.set(accountId, 0);
    }
  }

  private creditsFor(account: MockUpstreamAccount, model: string, totalTokens: number): number {
    const weight = account.modelWeights[model] ?? account.defaultWeight ?? 1;
    return (weight * totalTokens) / 1000;
  }

  private headersFor(account: MockUpstreamAccount, usedCredits: number): Record<string, string> {
    return {
      'anthropic-ratelimit-unified-tokens-limit': String(account.credits),
      'anthropic-ratelimit-unified-tokens-remaining': String(Math.max(0, account.credits - usedCredits)),
      ...account.headers,
    };
  }
}
