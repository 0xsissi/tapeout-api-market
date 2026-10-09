import { cucPrice } from '@clawmarket/shared';

import { MockUpstream } from './MockUpstream.js';
import { RandProvider } from './RandProvider.js';
import { TimeProvider } from './TimeProvider.js';
import { InMemoryGossip } from './InMemoryGossip.js';

export interface MakerConfig {
  id: string;
  p0: number;
  alpha: number;
  credits: number;
  modelWeights: Record<string, number>;
  defaultWeight?: number;
}

export interface BuyerConfig {
  id: string;
  model: string;
  requestCount: number;
  totalTokens: number;
}

export interface HarnessOptions {
  makers: MakerConfig[];
  buyers: BuyerConfig[];
  routing: 'greedy' | 'softmax';
  beta?: number;
  seed?: number;
  time?: TimeProvider;
  gossip?: InMemoryGossip;
  upstream?: MockUpstream;
}

export interface RunResult {
  priceTimeline: Array<{ t: number; makerId: string; price: number; u: number }>;
  routingHits: Record<string, number>;
  receipts: Array<{ requestId: string; buyerId: string; makerId: string; price: number; t: number }>;
  upstream429Count: number;
  rejectWithQuoteCount: number;
  completedRequests: number;
}

export class Harness {
  private readonly rand: RandProvider;
  private readonly time: TimeProvider;
  private readonly upstream: MockUpstream;
  private readonly gossip: InMemoryGossip;

  constructor(private readonly options: HarnessOptions) {
    this.rand = new RandProvider(options.seed ?? 1);
    this.time = options.time ?? new TimeProvider();
    this.gossip = options.gossip ?? new InMemoryGossip();
    this.upstream = options.upstream ?? new MockUpstream(options.makers.map((maker) => ({
      id: maker.id,
      credits: maker.credits,
      modelWeights: maker.modelWeights,
      defaultWeight: maker.defaultWeight,
    })));
  }

  async run(durationVirtualMs: number): Promise<RunResult> {
    const result: RunResult = {
      priceTimeline: [],
      routingHits: Object.fromEntries(this.options.makers.map((maker) => [maker.id, 0])),
      receipts: [],
      upstream429Count: 0,
      rejectWithQuoteCount: 0,
      completedRequests: 0,
    };

    const totalRequests = this.options.buyers.reduce((sum, buyer) => sum + buyer.requestCount, 0);
    const stepMs = totalRequests > 0 ? Math.max(1, Math.floor(durationVirtualMs / totalRequests)) : durationVirtualMs;

    for (const buyer of this.options.buyers) {
      for (let i = 0; i < buyer.requestCount; i += 1) {
        const maker = this.pickMaker(buyer.model);
        const response = this.upstream.request({
          accountId: maker.id,
          model: buyer.model,
          totalTokens: buyer.totalTokens,
        });
        if (response.ok) {
          result.completedRequests += 1;
          result.routingHits[maker.id] = (result.routingHits[maker.id] ?? 0) + 1;
          result.receipts.push({
            requestId: `${buyer.id}-${i}`,
            buyerId: buyer.id,
            makerId: maker.id,
            price: cucPrice(maker.p0, this.upstream.utilization(maker.id), maker.alpha),
            t: this.time.now(),
          });
        } else {
          result.upstream429Count += 1;
          result.rejectWithQuoteCount += 1;
        }
        this.recordPrices(result);
        this.gossip.publish('aimm-testkit:tick', { t: this.time.now(), makerId: maker.id });
        this.time.advance(stepMs);
      }
    }

    return result;
  }

  private pickMaker(model: string): MakerConfig {
    const priced = this.options.makers.map((maker) => {
      const u = this.upstream.utilization(maker.id);
      return {
        maker,
        price: cucPrice(maker.p0, u, maker.alpha),
        weight: Math.pow(1 / Math.max(cucPrice(maker.p0, u, maker.alpha), 1e-9), this.options.beta ?? 3),
      };
    });

    if (this.options.routing === 'greedy') {
      return priced.reduce((best, item) => item.price < best.price ? item : best).maker;
    }

    const index = this.rand.weightedIndex(priced.map((item) => item.weight));
    return priced[index]?.maker ?? this.options.makers[0]!;
  }

  private recordPrices(result: RunResult): void {
    for (const maker of this.options.makers) {
      const u = this.upstream.utilization(maker.id);
      result.priceTimeline.push({
        t: this.time.now(),
        makerId: maker.id,
        u,
        price: cucPrice(maker.p0, u, maker.alpha),
      });
    }
  }
}
