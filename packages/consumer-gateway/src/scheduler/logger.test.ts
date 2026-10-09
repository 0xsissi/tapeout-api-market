import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from './config.js';
import { SchedulerLogger } from './logger.js';

describe('SchedulerLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('supports chained builder calls', () => {
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    logger
      .startRequest('req-1', 'gpt-test', '0.2.0')
      .setMode('new', true)
      .setRouteKind('aimm_quote')
      .setSessionKey('session-1', 'explicit')
      .setStickyResult(true, 'hit')
      .setCandidates(10, 3, { low_reputation: 7 })
      .setSelected('peer-a', 1.5, 'quote', ['peer-b'])
      .setAttempts(1)
      .setOutcome('success')
      .setLatency(100, 200)
      .finalize();

    expect(logger.getRecent(1)).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        model: 'gpt-test',
        clientVersion: '0.2.0',
        stickyHit: true,
        selectedPeerId: 'peer-a',
        routeKind: 'aimm_quote',
        selectionReason: 'quote',
        attempts: 1,
        outcome: 'success',
      }),
    ]);
  });

  it('enforces ring buffer capacity', () => {
    const logger = new SchedulerLogger({ ...DEFAULT_CONFIG, logRingBufferSize: 2 });
    logger.startRequest('req-1', 'gpt-test').finalize();
    logger.startRequest('req-2', 'gpt-test').finalize();
    logger.startRequest('req-3', 'gpt-test').finalize();

    expect(logger.getRecent()).toHaveLength(2);
    expect(logger.getRecent().map((entry) => entry.requestId)).toEqual(['req-3', 'req-2']);
  });

  it('resizes the ring buffer when config changes', () => {
    const logger = new SchedulerLogger({ ...DEFAULT_CONFIG, logRingBufferSize: 3 });
    logger.startRequest('req-1', 'gpt-test').finalize();
    logger.startRequest('req-2', 'gpt-test').finalize();
    logger.startRequest('req-3', 'gpt-test').finalize();

    logger.updateConfig({ ...DEFAULT_CONFIG, logRingBufferSize: 2 });

    expect(logger.getRecent().map((entry) => entry.requestId)).toEqual(['req-3', 'req-2']);
  });

  it('swallows finalize write errors', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('write failed');
    });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);

    expect(() => logger.startRequest('req-1', 'gpt-test').finalize()).not.toThrow();
  });

  it('computes summary metrics from recent logs', () => {
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    logger
      .startRequest('req-1', 'gpt-test', '0.2.0')
      .setStickyResult(true, 'hit')
      .setCandidates(4, 2)
      .setSelected('peer-a', 1, 'sticky', [])
      .setOutcome('success')
      .finalize();
    vi.advanceTimersByTime(1_000);
    logger
      .startRequest('req-2', 'gpt-test', '0.2.3')
      .setCandidates(5, 1)
      .setSelected('peer-b', 1, 'legacy', [])
      .setOutcome('error')
      .finalize();

    expect(logger.getSummary(5_000)).toEqual({
      total: 2,
      stickyHitRate: 0.5,
      successRate: 0.5,
      avgCandidatesAfterFilter: 1.5,
      topPeerDistribution: {
        'peer-a': 1,
        'peer-b': 1,
      },
      clientVersions: {
        '0.2.0': 1,
        '0.2.3': 1,
      },
    });
  });
});
