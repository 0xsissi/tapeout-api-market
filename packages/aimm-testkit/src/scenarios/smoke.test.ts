import { describe, expect, it } from 'vitest';

import { Harness } from '../Harness.js';
import { InMemoryGossip } from '../InMemoryGossip.js';
import { MockUpstream } from '../MockUpstream.js';
import { TimeProvider } from '../TimeProvider.js';

describe('AIMM TestKit scenario smoke', () => {
  it('runs 5h of virtual time in less than 1 second', async () => {
    const started = Date.now();
    const result = await new Harness({
      makers: [{ id: 'A', p0: 2, alpha: 1, credits: 10_000, modelWeights: { sonnet: 1 } }],
      buyers: [{ id: 'B', model: 'sonnet', requestCount: 100, totalTokens: 100 }],
      routing: 'softmax',
      seed: 1,
    }).run(5 * 3600_000);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.completedRequests).toBe(100);
  });

  it('starts 10 Maker x 100 Buyer harness in less than 500ms', async () => {
    const started = Date.now();
    const harness = new Harness({
      makers: Array.from({ length: 10 }, (_, index) => ({
        id: `M${index}`,
        p0: 2,
        alpha: 1,
        credits: 100_000,
        modelWeights: { sonnet: 1 },
      })),
      buyers: Array.from({ length: 100 }, (_, index) => ({
        id: `B${index}`,
        model: 'sonnet',
        requestCount: 1,
        totalTokens: 100,
      })),
      routing: 'softmax',
      seed: 2,
    });

    await harness.run(1_000);

    expect(Date.now() - started).toBeLessThan(500);
  });

  it('accepts injected time, gossip, and upstream dependencies', async () => {
    const time = new TimeProvider();
    const gossip = new InMemoryGossip();
    const upstream = new MockUpstream([
      { id: 'A', credits: 100, modelWeights: { sonnet: 1 }, headers: { 'x-test': 'yes' }, latencyMs: 12 },
    ]);
    const ticks: unknown[] = [];
    gossip.subscribe('aimm-testkit:tick', (message) => ticks.push(message));

    const response = upstream.request({ accountId: 'A', model: 'sonnet', totalTokens: 1000 });
    expect(response.totalTokens).toBe(1000);
    expect(response.headers['x-test']).toBe('yes');
    expect(response.latencyMs).toBe(12);
    upstream.reset();

    await new Harness({
      makers: [{ id: 'A', p0: 2, alpha: 1, credits: 100, modelWeights: { sonnet: 1 } }],
      buyers: [{ id: 'B', model: 'sonnet', requestCount: 1, totalTokens: 1000 }],
      routing: 'greedy',
      time,
      gossip,
      upstream,
    }).run(1_000);

    expect(ticks).toHaveLength(1);
  });
});
