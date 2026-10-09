import * as http from 'node:http';

import type { SchedulerConfig } from '@clawmarket/shared';

import type { SchedulerConfigManager } from './config.js';
import type { SchedulerLogger } from './logger.js';
import type { SessionStickyTable } from './session-sticky.js';

export class SchedulerAdminServer {
  private server: http.Server | null = null;
  private readonly host: string;
  private readonly port: number;
  private actualPort: number | null = null;

  constructor(
    private readonly configManager: SchedulerConfigManager,
    private readonly logger: SchedulerLogger,
    private readonly sticky: SessionStickyTable,
    opts?: { host?: string; port?: number },
  ) {
    this.host = opts?.host ?? '127.0.0.1';
    this.port = opts?.port ?? Number(process.env.CLAW_SCHEDULER_ADMIN_PORT ?? 9457);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        console.warn(`[SCHED] Admin endpoint request failed: ${formatError(error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.once('error', (error: NodeJS.ErrnoException) => {
        console.warn(
          `[SCHED] Admin endpoint failed to start on ${this.host}:${this.port}: ${formatError(error)}`,
        );
        this.actualPort = null;
        this.server = null;
        resolve();
      });
      this.server!.listen(this.port, this.host, () => {
        const address = this.server?.address();
        this.actualPort = typeof address === 'object' && address ? address.port : this.port;
        console.log(`[SCHED] Admin endpoint listening on http://${this.host}:${this.actualPort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  get url(): string | null {
    return this.actualPort == null ? null : `http://${this.host}:${this.actualPort}`;
  }

  get listeningPort(): number | null {
    return this.actualPort;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    const method = req.method ?? 'GET';
    const basePort = this.actualPort ?? this.port;
    const url = new URL(req.url ?? '/', `http://${this.host}:${basePort}`);

    if (method === 'GET' && url.pathname === '/admin/scheduler/config') {
      return this.sendJson(res, this.configManager.get());
    }

    if (method === 'POST' && url.pathname === '/admin/scheduler/config') {
      const partial = await parseJsonBody<Partial<SchedulerConfig>>(req);
      this.configManager.updateOverride(partial);
      return this.sendJson(res, this.configManager.get());
    }

    if (method === 'POST' && url.pathname === '/admin/scheduler/kill') {
      this.configManager.updateOverride({ killSwitch: true });
      return this.sendJson(res, this.configManager.get());
    }

    if (method === 'POST' && url.pathname === '/admin/scheduler/revive') {
      this.configManager.updateOverride({ killSwitch: false });
      return this.sendJson(res, this.configManager.get());
    }

    if (method === 'GET' && url.pathname === '/admin/scheduler/logs') {
      const limit = Number(url.searchParams.get('limit') ?? '100');
      return this.sendJson(res, this.logger.getRecent(Number.isFinite(limit) ? limit : 100));
    }

    if (method === 'GET' && url.pathname === '/admin/scheduler/summary') {
      const windowMs = Number(url.searchParams.get('windowMs') ?? Number.POSITIVE_INFINITY);
      return this.sendJson(
        res,
        this.logger.getSummary(Number.isFinite(windowMs) ? windowMs : Number.POSITIVE_INFINITY),
      );
    }

    if (method === 'GET' && url.pathname === '/admin/scheduler/sticky') {
      return this.sendJson(res, this.sticky.snapshot());
    }

    if (method === 'GET' && url.pathname === '/admin/scheduler/sticky/stats') {
      return this.sendJson(res, this.sticky.stats());
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  private sendJson(res: http.ServerResponse, payload: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}

function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  const host = hostHeader.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost';
}

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text || '{}') as T;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
