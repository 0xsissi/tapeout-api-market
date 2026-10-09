import type { ModelPricing, ProviderAnnouncement, ReputationInfo } from '@clawmarket/shared';

export type MockClusterPreset = 'homogeneous' | 'mixed' | 'unreliable';
export type MockResponseMode = 'response' | 'stream';

export type MockSellerTimelineAction =
  | { type: 'increase_latency'; multiplier: number }
  | { type: 'set_latency'; multiplier: number }
  | { type: 'set_error_rate'; value: number }
  | { type: 'crash' }
  | { type: 'recover' };

export interface MockSellerTimelineEntry {
  atMs: number;
  action: MockSellerTimelineAction;
}

export interface MockSellerBehavior {
  responseMode: MockResponseMode;
  baseTTFTMs: number;
  baseTPS: number;
  ttftJitterMs: number;
  errorRate: number;
  streamChunks: number;
  timeline: MockSellerTimelineEntry[];
}

export interface MockSellerConfig {
  id: string;
  walletAddress: `0x${string}`;
  modelPricing: ModelPricing;
  reputation: ReputationInfo;
  maxConcurrent: number;
  listenHost: string;
  listenPort: number;
  behavior: MockSellerBehavior;
}

export interface MockSellerSeedRecord {
  announcement: ProviderAnnouncement;
  modelPricing: ModelPricing;
}

export function createMockSellerConfigs(options: {
  count: number;
  preset: MockClusterPreset;
  basePort?: number;
  listenHost?: string;
  model?: string;
}): MockSellerConfig[] {
  const count = Math.max(1, options.count);
  const basePort = options.basePort ?? 22000;
  const listenHost = options.listenHost ?? '127.0.0.1';
  const model = options.model ?? 'mock-gpt-4';

  return Array.from({ length: count }, (_, index) => {
    const baseLatency = 140 + (index % 7) * 45;
    const baseInputPrice = 1 + (index % 5) * 0.3;
    const baseOutputPrice = 2 + (index % 6) * 0.45;
    const reputation = buildReputation(index, options.preset);
    const behavior = buildBehavior(index, options.preset, baseLatency);

    return {
      id: `mock-seller-${String(index + 1).padStart(3, '0')}`,
      walletAddress: toWalletAddress(index + 1),
      modelPricing: {
        model,
        inputPer1m: round(baseInputPrice, 2),
        outputPer1m: round(baseOutputPrice, 2),
      },
      reputation,
      maxConcurrent:
        options.preset === 'unreliable'
          ? 4 + (index % 4)
          : options.preset === 'homogeneous'
            ? 64
            : 48 + (index % 12),
      listenHost,
      listenPort: basePort + index * 2,
      behavior,
    };
  });
}

function buildReputation(index: number, preset: MockClusterPreset): ReputationInfo {
  if (preset === 'homogeneous') {
    return {
      score: 85,
      totalTransactions: 500,
      successRate: 0.99,
      avgLatencyMs: 220,
    };
  }

  if (preset === 'unreliable') {
    return {
      score: 55 + (index % 20),
      totalTransactions: index % 7 === 0 ? 5 : 80 + index * 3,
      successRate: 0.9 + (index % 8) * 0.01,
      avgLatencyMs: 260 + (index % 9) * 70,
    };
  }

  return {
    score: 70 + (index % 25),
    totalTransactions: 120 + index * 4,
    successRate: 0.96 + (index % 4) * 0.01,
    avgLatencyMs: 180 + (index % 10) * 40,
  };
}

function buildBehavior(
  index: number,
  preset: MockClusterPreset,
  baseTTFTMs: number,
): MockSellerBehavior {
  if (preset === 'homogeneous') {
    return {
      responseMode: 'response',
      baseTTFTMs,
      baseTPS: 120,
      ttftJitterMs: 30,
      errorRate: 0,
      streamChunks: 3,
      timeline: [],
    };
  }

  if (preset === 'unreliable') {
    const unstable = index % 3 === 0;
    const crashWindow = 800 + (index % 4) * 300;
    const period = 1_200 + (index % 3) * 500;
    return {
      responseMode: index % 2 === 0 ? 'response' : 'stream',
      baseTTFTMs: baseTTFTMs + 80,
      baseTPS: 60 + (index % 5) * 12,
      ttftJitterMs: 70,
      errorRate: unstable ? 0.08 : 0.02,
      streamChunks: 4,
      timeline: unstable
        ? [
            { atMs: period, action: { type: 'crash' } },
            { atMs: period + crashWindow, action: { type: 'recover' } },
            { atMs: period * 2, action: { type: 'crash' } },
            { atMs: period * 2 + crashWindow, action: { type: 'recover' } },
          ]
        : [{ atMs: 1_000 + index * 40, action: { type: 'increase_latency', multiplier: 2 } }],
    };
  }

  return {
    responseMode: index % 3 === 0 ? 'stream' : 'response',
    baseTTFTMs,
    baseTPS: 80 + (index % 6) * 20,
    ttftJitterMs: 50,
    errorRate: 0.01,
    streamChunks: 4,
    timeline: [],
  };
}

export function toWalletAddress(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(40, '0')}` as `0x${string}`;
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}
