import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, SchedulerConfigManager } from './config.js';
import { SchedulerLogger } from './logger.js';
import { Scheduler } from './scheduler.js';
import { hashSessionKey } from './session-key.js';
import { SessionStickyTable } from './session-sticky.js';
import type { ScoredProvider } from '../router.js';

function makeProvider(
  peerId: string,
  score: number,
  overrides: {
    successRate?: number;
    reputationScore?: number;
    totalTransactions?: number;
    inputPer1m?: number;
    outputPer1m?: number;
  } = {},
): ScoredProvider {
  return {
    announcement: {
      peerId,
      walletAddress: '0x0000000000000000000000000000000000000001',
      publicKey: 'pubkey',
      models: [],
      region: 'apac',
      maxConcurrent: 5,
      stakeAmount: 100n,
      reputation: {
        score: overrides.reputationScore ?? 90,
        totalTransactions: overrides.totalTransactions ?? 50,
        successRate: overrides.successRate ?? 0.99,
        avgLatencyMs: 100,
      },
      timestamp: Date.now(),
      signature: '0xsig',
    },
    modelPricing: {
      model: 'gpt-test',
      inputPer1m: overrides.inputPer1m ?? 1,
      outputPer1m: overrides.outputPer1m ?? 2,
    },
    score,
  };
}

function makeInput(logger: SchedulerLogger) {
  return {
    model: 'gpt-test',
    requestId: 'req-1',
    body: {
      model: 'gpt-test',
      messages: [
        { role: 'system' as const, content: 'sys' },
        { role: 'user' as const, content: 'hello' },
      ],
      user: 'user-a',
    },
    userMaxPrice: undefined as number | undefined,
    excludedPeerIds: new Set<string>(),
    logBuilder: logger.startRequest('req-1', 'gpt-test'),
  };
}

describe('Scheduler', () => {
  it('falls back to legacy mode when config is legacy', async () => {
    const router = {
      selectBest: vi.fn().mockResolvedValue(makeProvider('peer-a', 10)),
      selectBestExcluding: vi.fn(),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(
      router as any,
      new SessionStickyTable({ capacity: 10, ttlMs: 10_000 }),
      manager,
      logger,
    );

    const result = await scheduler.select(makeInput(logger));

    expect(result.source).toBe('legacy');
    expect(result.provider?.announcement.peerId).toBe('peer-a');
    expect(router.selectBest).toHaveBeenCalledWith('gpt-test');
  });

  it('falls back to legacy when rollout is 0 even in new mode', async () => {
    const router = {
      selectBest: vi.fn().mockResolvedValue(makeProvider('peer-a', 10)),
      selectBestExcluding: vi.fn(),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 0 });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(
      router as any,
      new SessionStickyTable({ capacity: 10, ttlMs: 10_000 }),
      manager,
      logger,
    );

    const result = await scheduler.select(makeInput(logger));

    expect(result.source).toBe('legacy');
    expect(router.selectBest).toHaveBeenCalledWith('gpt-test');
  });

  it('falls back to legacy when kill switch is enabled', async () => {
    const router = {
      selectBest: vi.fn().mockResolvedValue(makeProvider('peer-a', 10)),
      selectBestExcluding: vi.fn(),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 100, killSwitch: true });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(
      router as any,
      new SessionStickyTable({ capacity: 10, ttlMs: 10_000 }),
      manager,
      logger,
    );

    const result = await scheduler.select(makeInput(logger));

    expect(result.source).toBe('legacy');
    expect(router.selectBest).toHaveBeenCalledWith('gpt-test');
  });

  it('uses sticky hits when the request is rolled out', async () => {
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    const sessionKeyHash = hashSessionKey('user-a:gpt-test');
    sticky.set(sessionKeyHash, 'peer-a');
    const router = {
      selectBest: vi.fn(),
      selectBestExcluding: vi.fn(),
      selectTopN: vi.fn(),
      findProviders: vi.fn().mockResolvedValue([makeProvider('peer-a', 10), makeProvider('peer-b', 9)]),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 100 });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(router as any, sticky, manager, logger);

    const result = await scheduler.select(makeInput(logger));

    expect(result.source).toBe('sticky');
    expect(result.provider?.announcement.peerId).toBe('peer-a');
    expect(result.alternatives.map((provider) => provider.announcement.peerId)).toEqual(['peer-b']);
  });

  it('keeps sticky hits outside top-n, filters sticky alternatives, and logs real candidate counts', async () => {
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    const sessionKeyHash = hashSessionKey('user-a:gpt-test');
    sticky.set(sessionKeyHash, 'peer-sticky');
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const input = makeInput(logger);
    input.userMaxPrice = 3;
    const router = {
      selectBest: vi.fn(),
      selectBestExcluding: vi.fn(),
      selectTopN: vi.fn(),
      findProviders: vi.fn().mockResolvedValue([
        makeProvider('peer-top-a', 10),
        makeProvider('peer-top-b', 9),
        makeProvider('peer-sticky', 1),
        makeProvider('peer-too-expensive', 8, { inputPer1m: 4, outputPer1m: 6 }),
      ]),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 100, topN: 2 });
    const scheduler = new Scheduler(router as any, sticky, manager, logger);

    const result = await scheduler.select(input);
    input.logBuilder.finalize();
    const log = logger.getRecent(1)[0];

    expect(result.source).toBe('sticky');
    expect(result.provider?.announcement.peerId).toBe('peer-sticky');
    expect(result.alternatives.map((provider) => provider.announcement.peerId)).toEqual([
      'peer-top-a',
    ]);
    expect(sticky.get(sessionKeyHash)?.peerId).toBe('peer-sticky');
    expect(log?.candidatesRaw).toBe(4);
    expect(log?.candidatesAfterFilter).toBe(3);
    expect(log?.filterReasons).toEqual({ price_cap: 1 });
  });

  it('uses hard-filtered top-n candidates when no sticky hit exists', async () => {
    const router = {
      selectBest: vi.fn(),
      selectBestExcluding: vi.fn(),
      selectTopN: vi.fn(),
      findProviders: vi.fn().mockResolvedValue([makeProvider('peer-a', 10), makeProvider('peer-b', 9)]),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 100, topN: 2 });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(
      router as any,
      new SessionStickyTable({ capacity: 10, ttlMs: 10_000 }),
      manager,
      logger,
    );

    const result = await scheduler.select(makeInput(logger));

    expect(result.source).toBe('top_n');
    expect(result.provider?.announcement.peerId).toBe('peer-a');
    expect(result.alternatives.map((provider) => provider.announcement.peerId)).toEqual(['peer-b']);
  });

  it('prefers the lower-load provider during P2C when top scores are close', async () => {
    const router = {
      selectBest: vi.fn(),
      selectBestExcluding: vi.fn(),
      findProviders: vi.fn().mockResolvedValue([
        makeProvider('peer-a', 10),
        makeProvider('peer-b', 9.8),
      ]),
      getProviderObservation: vi.fn((peerId: string) => (
        peerId === 'peer-a'
          ? { peerId, loadHint: 0.95, inflight: 5, lastUpdatedAt: Date.now() }
          : { peerId, loadHint: 0.2, inflight: 1, lastUpdatedAt: Date.now() }
      )),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({
      mode: 'new',
      rolloutPct: 100,
      enableSessionSticky: false,
      topN: 2,
      enableP2C: true,
      scoreTieThreshold: 0.05,
    });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(
      router as any,
      new SessionStickyTable({ capacity: 10, ttlMs: 10_000 }),
      manager,
      logger,
    );
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const result = await scheduler.select(makeInput(logger));
      expect(result.source).toBe('top_n');
      expect(result.provider?.announcement.peerId).toBe('peer-b');
      expect(result.alternatives.map((provider) => provider.announcement.peerId)).toEqual(['peer-a']);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('spreads concurrent buyer traffic instead of pinning all requests to the top provider', async () => {
    const providers = Array.from({ length: 10 }, (_, index) =>
      makeProvider(`peer-${index + 1}`, 100 - index, {
        inputPer1m: index + 1,
        outputPer1m: index + 1,
      }),
    );
    const inflight = new Map<string, number>();
    const router = {
      selectBest: vi.fn(),
      selectBestExcluding: vi.fn(),
      findProviders: vi.fn().mockResolvedValue(providers),
      getProviderObservation: vi.fn((peerId: string) => {
        const provider = providers.find((candidate) => candidate.announcement.peerId === peerId)!;
        const currentInflight = inflight.get(peerId) ?? 0;
        return {
          peerId,
          inflight: currentInflight,
          loadHint: Math.min(1, currentInflight / provider.announcement.maxConcurrent),
          lastUpdatedAt: Date.now(),
        };
      }),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({
      mode: 'new',
      rolloutPct: 100,
      enableSessionSticky: false,
      topN: 10,
      enableP2C: true,
      scoreTieThreshold: 0.2,
      priceWeightAlpha: 1.5,
    });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(
      router as any,
      new SessionStickyTable({ capacity: 10, ttlMs: 10_000 }),
      manager,
      logger,
    );
    const selectionCounts = new Map<string, number>();
    let randomSeed = 17;
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      randomSeed = (randomSeed * 48_271) % 2_147_483_647;
      return randomSeed / 2_147_483_647;
    });

    try {
      for (let index = 0; index < 1000; index++) {
        const requestId = `req-${index}`;
        const input = {
          ...makeInput(logger),
          requestId,
          excludedPeerIds: new Set<string>(),
          logBuilder: logger.startRequest(requestId, 'gpt-test'),
        };
        const result = await scheduler.select(input);
        const peerId = result.provider?.announcement.peerId;
        if (!peerId) {
          throw new Error('expected a selected provider');
        }
        selectionCounts.set(peerId, (selectionCounts.get(peerId) ?? 0) + 1);
        inflight.set(peerId, (inflight.get(peerId) ?? 0) + 1);
      }
    } finally {
      randomSpy.mockRestore();
    }

    expect((selectionCounts.get('peer-1') ?? 0) / 1000).toBeLessThanOrEqual(0.4);
  });

  it('falls back to legacy when the new path throws', async () => {
    const router = {
      selectBest: vi.fn().mockResolvedValue(makeProvider('peer-legacy', 10)),
      selectBestExcluding: vi.fn(),
      selectTopN: vi.fn(),
      findProviders: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 100 });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler(
      router as any,
      new SessionStickyTable({ capacity: 10, ttlMs: 10_000 }),
      manager,
      logger,
    );

    const result = await scheduler.select(makeInput(logger));

    expect(result.source).toBe('legacy');
    expect(result.provider?.announcement.peerId).toBe('peer-legacy');
  });

  it('rebinds sticky sessions to the successful peer', () => {
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler({} as any, sticky, manager, logger);

    sticky.set('session-hash', 'peer-a');

    scheduler.onSuccess('session-hash', 'peer-a');

    expect(sticky.get('session-hash')?.peerId).toBe('peer-a');
  });

  it('increments sticky failure count only for the bound peer', () => {
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const scheduler = new Scheduler({} as any, sticky, manager, logger);

    sticky.set('session-hash', 'peer-a');
    scheduler.onFailure('session-hash', 'peer-a', 'upstream_error');

    expect(sticky.get('session-hash')?.consecutiveFailures).toBe(1);
    scheduler.onFailure('session-hash', 'peer-b', 'upstream_error');
    expect(sticky.get('session-hash')?.consecutiveFailures).toBe(1);
  });

  it('records an excluded sticky entry as a non-hit and continues with top-n', async () => {
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    const sessionKeyHash = hashSessionKey('user-a:gpt-test');
    sticky.set(sessionKeyHash, 'peer-a');
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const input = makeInput(logger);
    input.excludedPeerIds.add('peer-a');
    const router = {
      selectBest: vi.fn(),
      selectBestExcluding: vi.fn(),
      findProviders: vi.fn().mockResolvedValue([makeProvider('peer-a', 10), makeProvider('peer-b', 9)]),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 100 });
    const scheduler = new Scheduler(router as any, sticky, manager, logger);

    const result = await scheduler.select(input);
    input.logBuilder.finalize();

    expect(result.source).toBe('top_n');
    expect(result.provider?.announcement.peerId).toBe('peer-b');
    expect(logger.getRecent(1)[0]?.stickyReason).toBe('excluded');
  });

  it('skips sticky routing during the recent failure ignore window', async () => {
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    const sessionKeyHash = hashSessionKey('user-a:gpt-test');
    sticky.set(sessionKeyHash, 'peer-a');
    sticky.markFailure(sessionKeyHash);
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const input = makeInput(logger);
    const router = {
      selectBest: vi.fn(),
      selectBestExcluding: vi.fn(),
      findProviders: vi.fn().mockResolvedValue([makeProvider('peer-a', 10), makeProvider('peer-b', 9)]),
    };
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    manager.updateOverride({ mode: 'new', rolloutPct: 100, stickyFailureIgnoreWindowMs: 60_000 });
    const scheduler = new Scheduler(router as any, sticky, manager, logger);

    const result = await scheduler.select(input);
    input.logBuilder.finalize();

    expect(result.source).toBe('top_n');
    expect(logger.getRecent(1)[0]?.stickyReason).toBe('recent_failure');
  });
});
