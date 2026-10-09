import { randomUUID } from 'node:crypto';

import { createNode, ProviderRegistry, StreamHandler, StreamWriter, registerProviderDiscoveryHandler } from '@clawmarket/p2p-node';
import type { ClawMarketNode } from '@clawmarket/p2p-node';
import type { InferenceRequest, ProviderAnnouncement, TokenUsage } from '@clawmarket/shared';

import type { MockSellerConfig, MockSellerSeedRecord, MockSellerTimelineAction } from './mock-seller.config.js';

interface RuntimeState {
  crashed: boolean;
  latencyMultiplier: number;
  errorRate: number;
  inflight: number;
  startedAt: number;
  requests: number;
  failures: number;
}

export class MockSeller {
  private node: ClawMarketNode | null = null;
  private registry: ProviderRegistry | null = null;
  private streamHandler: StreamHandler | null = null;
  private announcement: ProviderAnnouncement | null = null;
  private timers: NodeJS.Timeout[] = [];
  private state: RuntimeState;

  constructor(private readonly config: MockSellerConfig) {
    this.state = {
      crashed: false,
      latencyMultiplier: 1,
      errorRate: this.config.behavior.errorRate,
      inflight: 0,
      startedAt: 0,
      requests: 0,
      failures: 0,
    };
  }

  async start(): Promise<void> {
    if (this.node) {
      return;
    }

    this.node = await createNode({
      listenHost: this.config.listenHost,
      listenPort: this.config.listenPort,
      bootstrapPeers: [],
    });
    await this.node.start();

    this.registry = new ProviderRegistry(this.node.libp2p);
    this.streamHandler = new StreamHandler(this.node.libp2p);
    this.streamHandler.handleIncoming(async (request: InferenceRequest, writer: StreamWriter) => {
      if (this.state.crashed) {
        await writer.sendError(request.requestId, 'mock seller unavailable');
        return;
      }

      if (this.state.inflight >= this.config.maxConcurrent) {
        this.state.failures += 1;
        await writer.sendError(request.requestId, 'concurrency_limit');
        return;
      }

      this.state.inflight += 1;
      this.state.requests += 1;
      try {
        const usage = buildUsage();
        const ttft = nextTtftMs(this.config, this.state.latencyMultiplier);
        if (Math.random() < this.state.errorRate) {
          await sleep(ttft);
          this.state.failures += 1;
          await writer.sendError(request.requestId, 'mock upstream error');
          return;
        }

        if (this.config.behavior.responseMode === 'stream') {
          await writer.sendStreamStart(request.requestId);
          await sleep(ttft);
          const chunks = this.config.behavior.streamChunks;
          for (let index = 0; index < chunks; index++) {
            await writer.sendStreamChunk(
              request.requestId,
              JSON.stringify({
                choices: [{ delta: { content: `mock-${this.config.id}-${index}` } }],
              }),
            );
            await sleep(chunkDelayMs(this.config));
          }
          await writer.sendStreamEnd(request.requestId, usage, {
            requestId: randomUUID(),
            model: request.model,
            timestamp: new Date().toISOString(),
            usage,
          });
          return;
        }

        await sleep(ttft + chunkDelayMs(this.config) * this.config.behavior.streamChunks);
        await writer.sendResponse(
          request.requestId,
          JSON.stringify({
            id: request.requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: `mock-response:${this.config.id}`,
                },
                finish_reason: 'stop',
              },
            ],
            usage,
          }),
          usage,
        );
      } finally {
        this.state.inflight = Math.max(0, this.state.inflight - 1);
      }
    });

    this.state.startedAt = Date.now();
    this.announcement = this.buildAnnouncement();
    registerProviderDiscoveryHandler(this.node.libp2p, () => this.announcement);
    await this.registry.announce(this.announcement);
    this.registry.startHeartbeat(10_000);
    this.scheduleTimeline();
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];

    this.streamHandler?.unhandle();
    this.registry?.stopHeartbeat();
    if (this.node) {
      await this.node.stop();
    }

    this.node = null;
    this.registry = null;
    this.streamHandler = null;
    this.announcement = null;
    this.state.crashed = false;
    this.state.latencyMultiplier = 1;
    this.state.errorRate = this.config.behavior.errorRate;
    this.state.inflight = 0;
  }

  async crash(): Promise<void> {
    if (!this.node || this.state.crashed) {
      return;
    }
    this.state.crashed = true;
    this.registry?.stopHeartbeat();
    await this.node.stop();
  }

  async recover(): Promise<void> {
    if (!this.node || !this.state.crashed) {
      return;
    }
    await this.node.start();
    this.state.crashed = false;
    this.announcement = this.buildAnnouncement();
    await this.registry?.announce(this.announcement);
    this.registry?.startHeartbeat(10_000);
  }

  getAnnouncement(): ProviderAnnouncement {
    if (!this.announcement) {
      throw new Error(`Mock seller ${this.config.id} has not started yet`);
    }
    return {
      ...this.announcement,
      models: [...this.announcement.models],
      reputation: { ...this.announcement.reputation },
      multiaddrs: [...(this.announcement.multiaddrs ?? [])],
    };
  }

  toSeedRecord(): MockSellerSeedRecord {
    const announcement = this.getAnnouncement();
    return {
      announcement,
      modelPricing: announcement.models[0]!,
    };
  }

  snapshot(): {
    id: string;
    peerId: string;
    crashed: boolean;
    inflight: number;
    requests: number;
    failures: number;
  } {
    return {
      id: this.config.id,
      peerId: this.announcement?.peerId ?? 'unknown',
      crashed: this.state.crashed,
      inflight: this.state.inflight,
      requests: this.state.requests,
      failures: this.state.failures,
    };
  }

  private buildAnnouncement(): ProviderAnnouncement {
    if (!this.node) {
      throw new Error(`Mock seller ${this.config.id} has not started yet`);
    }
    return {
      peerId: this.node.peerId.toString(),
      walletAddress: this.config.walletAddress,
      publicKey: `mock-public-key:${this.config.id}`,
      multiaddrs: normalizeMultiaddrs(this.node.getMultiaddrs(), this.config.listenHost),
      models: [{ ...this.config.modelPricing }],
      region: 'mock-local',
      maxConcurrent: this.config.maxConcurrent,
      stakeAmount: 100_000_000n,
      reputation: { ...this.config.reputation },
      timestamp: Date.now(),
      signature: '0xmock',
    };
  }

  private scheduleTimeline(): void {
    for (const step of this.config.behavior.timeline) {
      const timer = setTimeout(() => {
        void this.applyAction(step.action);
      }, step.atMs);
      this.timers.push(timer);
    }
  }

  private async applyAction(action: MockSellerTimelineAction): Promise<void> {
    switch (action.type) {
      case 'increase_latency':
        this.state.latencyMultiplier *= Math.max(1, action.multiplier);
        return;
      case 'set_latency':
        this.state.latencyMultiplier = Math.max(0.1, action.multiplier);
        return;
      case 'set_error_rate':
        this.state.errorRate = Math.max(0, Math.min(1, action.value));
        return;
      case 'crash':
        await this.crash();
        return;
      case 'recover':
        await this.recover();
        return;
    }
  }
}

function nextTtftMs(config: MockSellerConfig, latencyMultiplier: number): number {
  const base = config.behavior.baseTTFTMs * latencyMultiplier;
  const jitter = config.behavior.ttftJitterMs > 0
    ? (Math.random() * config.behavior.ttftJitterMs * 2) - config.behavior.ttftJitterMs
    : 0;
  return Math.max(5, Math.round(base + jitter));
}

function chunkDelayMs(config: MockSellerConfig): number {
  return Math.max(5, Math.round(1000 / Math.max(1, config.behavior.baseTPS / 10)));
}

function buildUsage(): TokenUsage {
  return {
    prompt_tokens: 32,
    completion_tokens: 48,
    total_tokens: 80,
  };
}

function normalizeMultiaddrs(addresses: string[], listenHost: string): string[] {
  return addresses.map((address) => address.replace('/ip4/0.0.0.0/', `/ip4/${listenHost}/`));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
