import type { AgentActionRequest } from '@clawmarket/shared';

/** Local management client for an AI agent. The credential is a scoped API token, never a wallet key. */
export class TAMAgentClient {
  private readonly url: string;
  constructor(private readonly config: { baseURL?: string; token: string }) {
    const url = new URL(config.baseURL ?? 'http://127.0.0.1:18787');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || !config.token) throw new Error('TAM Agent requires a local controller URL and management token');
    this.url = url.origin;
  }
  status() { return this.request('/v1/tam/status'); }
  tools() { return this.request('/v1/tam/tools'); }
  operations() { return this.request('/v1/tam/operations'); }
  execute(action: AgentActionRequest) { return this.request('/v1/tam/actions', action); }
  invoke(id: string, params: Record<string, unknown>, reason = '') { return this.execute({ id, action: 'invoke', params, reason }); }
  deposit(id: string, amountToken: string, reason = '') { return this.execute({ id, action: 'deposit', params: { amountToken }, reason }); }
  collect(id: string, reason = '') { return this.execute({ id, action: 'collect', params: {}, reason }); }
  price(id: string, model: string, p0: number, alpha?: number, reason = '') { return this.execute({ id, action: 'price', params: { model, p0, ...(alpha != null ? { alpha } : {}) }, reason }); }
  private async request(path: string, body?: AgentActionRequest): Promise<any> {
    const response = await fetch(`${this.url}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(190_000) });
    const result = await response.json();
    if (!response.ok) throw new Error((result as any).error?.message ?? `TAM management HTTP ${response.status}`);
    // Caller must inspect operation.status; uncertain operations must not be automatically retried.
    return result;
  }
}
