import { describe, expect, it } from 'vitest';

import {
  Harness,
  InMemoryGossip,
  MockCliproxy,
  MockUpstream,
  RandProvider,
  TimeProvider,
  gini,
  maxDeviationPercent,
  runAllExperiments,
} from './index.js';

describe('AIMM TestKit', () => {
  it('runs deterministic harness simulations with the same seed', async () => {
    const makeHarness = () => new Harness({
      seed: 123,
      routing: 'softmax',
      makers: [
        { id: 'A', p0: 2, alpha: 1, credits: 100, modelWeights: { sonnet: 1 } },
        { id: 'B', p0: 2.2, alpha: 1, credits: 100, modelWeights: { sonnet: 1 } },
      ],
      buyers: [{ id: 'buyer', model: 'sonnet', requestCount: 25, totalTokens: 100 }],
    });

    expect(await makeHarness().run(1_000)).toEqual(await makeHarness().run(1_000));
  });

  it('tracks mock upstream credits and returns 429 after quota exhaustion', () => {
    const upstream = new MockUpstream([{ id: 'A', credits: 5, modelWeights: { opus: 5 } }]);

    expect(upstream.request({ accountId: 'A', model: 'opus', totalTokens: 1000 }).ok).toBe(true);
    expect(upstream.request({ accountId: 'A', model: 'opus', totalTokens: 1000 }).status).toBe(429);
    expect(upstream.utilization('A')).toBe(0.999);
  });

  it('provides fake time, deterministic random, in-memory gossip, and gini metrics', () => {
    const time = new TimeProvider(10);
    expect(time.advance(5)).toBe(15);

    const randA = new RandProvider(9);
    const randB = new RandProvider(9);
    expect(randA.random()).toBe(randB.random());

    const gossip = new InMemoryGossip();
    const received: string[] = [];
    const unsubscribe = gossip.subscribe<string>('topic', (message) => received.push(message));
    gossip.publish('topic', 'hello');
    unsubscribe();
    gossip.publish('topic', 'ignored');
    expect(received).toEqual(['hello']);

    expect(gini([10, 10, 10])).toBe(0);
    expect(maxDeviationPercent([2, 4, 9], [2, 4, 10])).toBeCloseTo(0.1, 6);
  });

  it('filters and clears mock cliproxy usage records', async () => {
    const cliproxy = new MockCliproxy();
    cliproxy.record({
      timestamp: 100,
      authIndex: 'A',
      model: 'sonnet',
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      failed: false,
    });
    cliproxy.record({
      timestamp: 200,
      authIndex: 'A',
      model: 'sonnet',
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      failed: true,
    });

    expect(await cliproxy.fetchRecentRecords(150)).toHaveLength(1);
    cliproxy.clear();
    expect(await cliproxy.fetchRecentRecords(0)).toEqual([]);
  });

  it('runs A-F mechanism experiments and reports pass/fail results', async () => {
    const results = await runAllExperiments();

    expect(results.map((result) => result.name)).toEqual([
      'exp-A-cuc-curve',
      'exp-B-herd-dispersion',
      'exp-C-ban-protection',
      'exp-D-thundering-herd',
      'exp-E-price-discovery',
      'exp-F-model-weight',
    ]);
    expect(results.every((result) => typeof result.pass === 'boolean')).toBe(true);
  });
});
