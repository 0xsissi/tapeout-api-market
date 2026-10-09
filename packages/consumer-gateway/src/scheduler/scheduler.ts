import { createHash } from 'node:crypto';

import type { ChatCompletionRequest, SchedulerConfig } from '@clawmarket/shared';

import type { P2PRouter, ProviderObservation, ScoredProvider } from '../router.js';
import type { SchedulerConfigManager } from './config.js';
import type { DecisionLogBuilder, SchedulerLogger } from './logger.js';
import { deriveSessionKey } from './session-key.js';
import type { SessionStickyTable } from './session-sticky.js';
import { applyHardFilter } from './hard-filter.js';

export interface SelectInput {
  model: string;
  requestId: string;
  body: ChatCompletionRequest;
  userMaxPrice?: number;
  excludedPeerIds: Set<string>;
  logBuilder: DecisionLogBuilder;
}

export interface SelectOutput {
  provider: ScoredProvider | null;
  alternatives: ScoredProvider[];
  source: 'sticky' | 'top_n' | 'legacy' | 'no_candidate';
  sessionKeyHash: string | null;
  rolledOut: boolean;
}

export class Scheduler {
  constructor(
    private readonly router: P2PRouter,
    private readonly sticky: SessionStickyTable,
    private readonly config: SchedulerConfigManager,
    private readonly logger: SchedulerLogger,
  ) {}

  async select(input: SelectInput): Promise<SelectOutput> {
    const cfg = this.config.get();
    const rolledOut = !cfg.killSwitch && cfg.mode === 'new' && requestIsRolledOut(input.requestId, cfg.rolloutPct);
    input.logBuilder.setMode(cfg.mode, rolledOut);

    if (!rolledOut) {
      return this.legacySelect(input);
    }

    try {
      return await this.newSelect(input);
    } catch (error) {
      console.warn(
        `[SCHED] New scheduler path failed for ${input.requestId}, falling back to legacy: ${formatError(error)}`,
      );
      return this.legacySelect(input);
    }
  }

  onSuccess(sessionKeyHash: string | null, peerId: string): void {
    if (!sessionKeyHash) {
      return;
    }
    this.sticky.markSuccess(sessionKeyHash);
  }

  onFailure(sessionKeyHash: string | null, peerId: string, _errorKind: string): void {
    if (!sessionKeyHash) {
      return;
    }
    const entry = this.sticky.get(sessionKeyHash);
    if (entry?.peerId === peerId) {
      this.sticky.markFailure(sessionKeyHash);
    }
  }

  private async newSelect(input: SelectInput): Promise<SelectOutput> {
    const cfg = this.config.get();
    const sessionKey = deriveSessionKey(input.body);
    const sessionKeyHash = sessionKey.key;
    input.logBuilder.setSessionKey(sessionKeyHash, sessionKey.source);
    let candidatePool:
      | {
          rawProviders: ScoredProvider[];
          candidates: ScoredProvider[];
          filterReasons: Record<string, number> | undefined;
        }
      | undefined;

    const getCandidatePool = async () => {
      if (candidatePool) {
        return candidatePool;
      }

      const rawProviders = await this.router.findProviders(input.model);
      let candidates = rawProviders.filter(
        (provider) => !input.excludedPeerIds.has(provider.announcement.peerId),
      );
      let filterReasons: Record<string, number> | undefined;

      if (cfg.enableHardFilter) {
        const filtered = applyHardFilter(
          {
            providers: rawProviders,
            model: input.model,
            userMaxPrice: input.userMaxPrice,
            excludedPeerIds: input.excludedPeerIds,
          },
          cfg,
        );
        candidates = [...filtered.candidates, ...filtered.explorationCandidates].sort(
          (left, right) => right.score - left.score,
        );
        filterReasons = filtered.reasons;
      }

      candidatePool = { rawProviders, candidates, filterReasons };
      return candidatePool;
    };

    if (!cfg.enableSessionSticky) {
      input.logBuilder.setStickyResult(false, 'disabled');
    } else if (!sessionKeyHash) {
      input.logBuilder.setStickyResult(false, 'no_session_key');
    } else {
      const stickyEntry = this.sticky.get(sessionKeyHash);
      if (!stickyEntry) {
        input.logBuilder.setStickyResult(false, 'miss');
      } else if (input.excludedPeerIds.has(stickyEntry.peerId)) {
        input.logBuilder.setStickyResult(false, 'excluded');
      } else {
        if (
          !stickyEntry.lastFailureAt ||
          Date.now() - stickyEntry.lastFailureAt > cfg.stickyFailureIgnoreWindowMs
        ) {
          const pool = await getCandidatePool();
          const hit = pool.candidates.find(
            (provider) => provider.announcement.peerId === stickyEntry.peerId,
          );
          if (hit) {
            const alternatives = pool.candidates
              .filter(
                (provider) => provider.announcement.peerId !== stickyEntry.peerId,
              )
              .slice(0, Math.max(0, cfg.enableTopNPreselect ? cfg.topN - 1 : 0));
            input.logBuilder
              .setStickyResult(true, 'hit')
              .setCandidates(
                pool.rawProviders.length,
                pool.candidates.length,
                pool.filterReasons,
              )
              .setSelected(
                hit.announcement.peerId,
                averagePrice(hit),
                'sticky',
                alternatives.map((provider) => provider.announcement.peerId),
              );
            return {
              provider: hit,
              alternatives,
              source: 'sticky',
              sessionKeyHash,
              rolledOut: true,
            };
          }
          input.logBuilder.setStickyResult(false, 'dropped_from_pool');
        } else {
          input.logBuilder.setStickyResult(false, 'recent_failure');
        }
      }
    }

    const pool = await getCandidatePool();

    input.logBuilder.setCandidates(pool.rawProviders.length, pool.candidates.length, pool.filterReasons);
    if (pool.candidates.length === 0) {
      input.logBuilder.setSelected(undefined, undefined, 'no_candidate', []);
      return {
        provider: null,
        alternatives: [],
        source: 'no_candidate',
        sessionKeyHash,
        rolledOut: true,
      };
    }

    const topProviders = cfg.enableTopNPreselect
      ? pool.candidates.slice(0, cfg.topN)
      : pool.candidates.slice(0, 1);
    const { provider, alternatives } = selectTopProviders(topProviders, cfg, this.router);

    if (provider) {
      input.logBuilder.setSelected(
        provider.announcement.peerId,
        averagePrice(provider),
        'top_n',
        alternatives.map((candidate) => candidate.announcement.peerId),
      );
      if (cfg.enableSessionSticky && sessionKeyHash) {
        this.sticky.set(sessionKeyHash, provider.announcement.peerId);
      }
    }

    return {
      provider,
      alternatives,
      source: provider ? 'top_n' : 'no_candidate',
      sessionKeyHash,
      rolledOut: true,
    };
  }

  private async legacySelect(input: SelectInput): Promise<SelectOutput> {
    const provider =
      input.excludedPeerIds.size === 0
        ? await this.router.selectBest(input.model)
        : await this.router.selectBestExcluding(input.model, input.excludedPeerIds);
    let alternatives: ScoredProvider[] = [];
    if (provider) {
      try {
        alternatives = (await this.router.findProviders(input.model))
          .filter((candidate) =>
            candidate.announcement.peerId !== provider.announcement.peerId &&
            !input.excludedPeerIds.has(candidate.announcement.peerId),
          )
          .slice(0, 2);
      } catch {
        alternatives = [];
      }
    }
    input.logBuilder.setSelected(
      provider?.announcement.peerId,
      provider ? averagePrice(provider) : undefined,
      provider ? 'legacy' : 'no_candidate',
      alternatives.map((candidate) => candidate.announcement.peerId),
    );
    return {
      provider,
      alternatives,
      source: provider ? 'legacy' : 'no_candidate',
      sessionKeyHash: null,
      rolledOut: false,
    };
  }
}

export function requestIsRolledOut(requestId: string, pct: number): boolean {
  if (pct >= 100) {
    return true;
  }
  if (pct <= 0) {
    return false;
  }
  const digest = createHash('sha256').update(requestId).digest();
  const value = digest.readUInt32BE(0);
  return value % 100 < pct;
}

function averagePrice(provider: ScoredProvider): number {
  return (provider.modelPricing.inputPer1m + provider.modelPricing.outputPer1m) / 2;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectTopProviders(
  candidates: ScoredProvider[],
  cfg: SchedulerConfig,
  router: P2PRouter,
): {
  provider: ScoredProvider | null;
  alternatives: ScoredProvider[];
} {
  if (candidates.length === 0) {
    return { provider: null, alternatives: [] };
  }

  const seededProvider = selectPriceAwareCandidate(candidates, cfg);
  if (!seededProvider) {
    return { provider: null, alternatives: [] };
  }

  if (!cfg.enableP2C || candidates.length < 2) {
    return {
      provider: seededProvider,
      alternatives: candidates.filter(
        (candidate) => candidate.announcement.peerId !== seededProvider.announcement.peerId,
      ),
    };
  }

  const pair = selectP2CPair(candidates);
  if (pair.length < 2) {
    return {
      provider: seededProvider,
      alternatives: candidates.filter(
        (candidate) => candidate.announcement.peerId !== seededProvider.announcement.peerId,
      ),
    };
  }

  const [left, right] = pair;
  const winner = pickObservedWinner(left, right, cfg, router);
  const preferredAlternatives = [left, right].filter(
    (candidate, index, all) =>
      candidate.announcement.peerId !== winner.announcement.peerId &&
      all.findIndex((other) => other.announcement.peerId === candidate.announcement.peerId) ===
        index,
  );
  const remainingAlternatives = candidates.filter(
    (candidate) =>
      candidate.announcement.peerId !== winner.announcement.peerId &&
      !preferredAlternatives.some(
        (preferred) => preferred.announcement.peerId === candidate.announcement.peerId,
      ),
  );

  return {
    provider: winner,
    alternatives: [...preferredAlternatives, ...remainingAlternatives],
  };
}

function getTiePool(candidates: ScoredProvider[], threshold: number): ScoredProvider[] {
  const best = candidates[0];
  if (!best) {
    return [];
  }

  return candidates.filter((candidate) => scoreGapRatio(best.score, candidate.score) <= threshold);
}

function pickObservedWinner(
  left: ScoredProvider,
  right: ScoredProvider,
  cfg: SchedulerConfig,
  router: P2PRouter,
): ScoredProvider {
  const leftPressure = computeObservedPressure(left, readProviderObservation(router, left.announcement.peerId));
  const rightPressure = computeObservedPressure(right, readProviderObservation(router, right.announcement.peerId));

  if (Math.abs(leftPressure - rightPressure) > 1) {
    return leftPressure < rightPressure ? left : right;
  }

  if (scoreGapRatio(left.score, right.score) <= cfg.scoreTieThreshold) {
    return selectWeightedByPrice([left, right], cfg.priceWeightAlpha) ?? left;
  }

  return left.score >= right.score ? left : right;
}

function computeObservedPressure(
  provider: ScoredProvider,
  observation: ProviderObservation | null,
): number {
  const loadHint =
    observation?.loadHint ??
    (typeof observation?.inflight === 'number'
      ? Math.min(1, observation.inflight / Math.max(provider.announcement.maxConcurrent, 1))
      : 0.5);
  const queueDepth = observation?.queueDepth ?? 0;
  const latencyMs =
    observation?.observedLatencyMs ??
    provider.announcement.reputation.avgLatencyMs ??
    1_000;

  return loadHint * 10_000 + queueDepth * 250 + latencyMs;
}

function selectWeightedByPrice(
  candidates: ScoredProvider[],
  alpha: number,
): ScoredProvider | null {
  if (candidates.length === 0) {
    return null;
  }

  const weights = candidates.map((candidate) => 1 / Math.pow(Math.max(averagePrice(candidate), 0.000_001), alpha));
  return selectWeighted(candidates, weights);
}

function selectPriceAwareCandidate(
  candidates: ScoredProvider[],
  cfg: SchedulerConfig,
): ScoredProvider | null {
  return selectWeighted(candidates, getCandidateSelectionWeights(candidates, cfg));
}

function selectP2CPair(
  candidates: ScoredProvider[],
): ScoredProvider[] {
  const first = selectUniform(candidates);
  if (!first) {
    return [];
  }

  const remaining = candidates.filter(
    (candidate) => candidate.announcement.peerId !== first.announcement.peerId,
  );
  if (remaining.length === 0) {
    return [first];
  }

  const second = selectUniform(remaining);
  return second ? [first, second] : [first];
}

function selectWeighted<T>(candidates: T[], weights: number[]): T | null {
  if (candidates.length === 0 || candidates.length !== weights.length) {
    return null;
  }

  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (!(total > 0)) {
    return candidates[0] ?? null;
  }

  let target = Math.random() * total;
  for (let index = 0; index < candidates.length; index++) {
    target -= Math.max(0, weights[index] ?? 0);
    if (target <= 0) {
      return candidates[index] ?? null;
    }
  }

  return candidates[candidates.length - 1] ?? null;
}

function scoreGapRatio(bestScore: number, candidateScore: number): number {
  return Math.abs(bestScore - candidateScore) / Math.max(Math.abs(bestScore), 1);
}

function selectUniform<T>(candidates: T[]): T | null {
  if (candidates.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index] ?? null;
}

function getCandidateSelectionWeights(
  candidates: ScoredProvider[],
  cfg: SchedulerConfig,
): number[] {
  const bestScore = candidates[0]?.score ?? 0;
  return candidates.map((candidate) => (
    scoreGapRatio(bestScore, candidate.score) <= cfg.scoreTieThreshold
      ? 1 / Math.pow(Math.max(averagePrice(candidate), 0.000_001), cfg.priceWeightAlpha)
      : 1
  ));
}

function readProviderObservation(
  router: P2PRouter,
  peerId: string,
): ProviderObservation | null {
  const getter = (router as any).getProviderObservation;
  if (typeof getter !== 'function') {
    return null;
  }
  return getter.call(router, peerId) as ProviderObservation | null;
}
