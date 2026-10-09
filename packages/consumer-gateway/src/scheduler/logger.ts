import type { SchedulerConfig, SchedulerMode } from '@clawmarket/shared';

import { hashSessionKey } from './session-key.js';

export interface SchedulerDecisionLog {
  requestId: string;
  model: string;
  ts: number;
  clientVersion: string;
  sessionKey?: string;
  sessionKeySource: 'explicit' | 'user' | 'prompt_prefix' | 'none';
  stickyHit: boolean;
  stickyReason?:
    | 'hit'
    | 'miss'
    | 'disabled'
    | 'no_session_key'
    | 'excluded'
    | 'recent_failure'
    | 'dropped_from_pool'
    | 'overloaded'
    | 'unhealthy'
    | 'expired';
  candidatesRaw: number;
  candidatesAfterFilter: number;
  filterReasons?: Record<string, number>;
  selectedPeerId?: string;
  selectedPrice?: number;
  selectionReason: 'sticky' | 'top_n' | 'legacy' | 'quote' | 'no_candidate';
  alternatives: string[];
  attempts: number;
  outcome: 'success' | 'failover' | 'error' | 'in_progress';
  errorKind?: string;
  quoteFallbackReason?: string;
  routeKind: 'scheduler' | 'aimm_quote';
  latencyMs?: { ttfb?: number; total?: number };
  schedulerMode: SchedulerMode;
  rolledOut: boolean;
}

export interface DecisionLogBuilder {
  setClientVersion(version: string): this;
  setSessionKey(
    key: string | undefined | null,
    source: SchedulerDecisionLog['sessionKeySource'],
  ): this;
  setStickyResult(hit: boolean, reason?: SchedulerDecisionLog['stickyReason']): this;
  setCandidates(raw: number, filtered: number, reasons?: Record<string, number>): this;
  setSelected(
    peerId: string | undefined | null,
    price: number | undefined,
    reason: SchedulerDecisionLog['selectionReason'],
    alts: string[],
  ): this;
  setRouteKind(kind: SchedulerDecisionLog['routeKind']): this;
  setOutcome(outcome: SchedulerDecisionLog['outcome'], errorKind?: string): this;
  setLatency(ttfb?: number, total?: number): this;
  setMode(mode: SchedulerMode, rolledOut: boolean): this;
  setQuoteFallback(reason: string | undefined): this;
  setAttempts(attempts: number): this;
  finalize(): void;
}

export class SchedulerLogger {
  private buffer: Array<SchedulerDecisionLog | undefined>;
  private config: SchedulerConfig;
  private nextIndex = 0;
  private count = 0;

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.buffer = new Array(Math.max(1, config.logRingBufferSize));
  }

  updateConfig(config: SchedulerConfig): void {
    this.config = config;
    const nextSize = Math.max(1, config.logRingBufferSize);
    if (nextSize === this.buffer.length) {
      return;
    }

    const preserved = this.getRecent(nextSize).reverse();
    this.buffer = new Array(nextSize);
    this.nextIndex = 0;
    this.count = 0;
    for (const entry of preserved) {
      this.buffer[this.nextIndex] = {
        ...entry,
        alternatives: [...entry.alternatives],
        filterReasons: entry.filterReasons ? { ...entry.filterReasons } : undefined,
        latencyMs: entry.latencyMs ? { ...entry.latencyMs } : undefined,
      };
      this.nextIndex = (this.nextIndex + 1) % this.buffer.length;
      this.count = Math.min(this.count + 1, this.buffer.length);
    }
  }

  startRequest(requestId: string, model: string, clientVersion: string = 'unknown'): DecisionLogBuilder {
    const logger = this;
    const state: SchedulerDecisionLog = {
      requestId,
      model,
      ts: Date.now(),
      clientVersion,
      sessionKeySource: 'none',
      stickyHit: false,
      candidatesRaw: 0,
      candidatesAfterFilter: 0,
      selectionReason: 'legacy',
      alternatives: [],
      attempts: 0,
      outcome: 'in_progress',
      routeKind: 'scheduler',
      schedulerMode: 'legacy',
      rolledOut: false,
    };
    let finalized = false;

    return {
      setClientVersion(version) {
        state.clientVersion = version;
        return this;
      },
      setSessionKey(key, source) {
        state.sessionKey = key
          ? (/^[0-9a-f]{64}$/i.test(key) ? key : hashSessionKey(key))
          : undefined;
        state.sessionKeySource = source;
        return this;
      },
      setStickyResult(hit, reason) {
        state.stickyHit = hit;
        state.stickyReason = reason;
        return this;
      },
      setCandidates(raw, filtered, reasons) {
        state.candidatesRaw = raw;
        state.candidatesAfterFilter = filtered;
        state.filterReasons = reasons && Object.keys(reasons).length > 0 ? { ...reasons } : undefined;
        return this;
      },
      setSelected(peerId, price, reason, alts) {
        state.selectedPeerId = peerId ?? undefined;
        state.selectedPrice = typeof price === 'number' ? price : undefined;
        state.selectionReason = reason;
        state.alternatives = [...alts];
        return this;
      },
      setRouteKind(kind) {
        state.routeKind = kind;
        return this;
      },
      setOutcome(outcome, errorKind) {
        state.outcome = outcome;
        state.errorKind = errorKind;
        return this;
      },
      setLatency(ttfb, total) {
        state.latencyMs = {
          ...(typeof ttfb === 'number' ? { ttfb } : {}),
          ...(typeof total === 'number' ? { total } : {}),
        };
        if (Object.keys(state.latencyMs).length === 0) {
          state.latencyMs = undefined;
        }
        return this;
      },
      setMode(mode, rolledOut) {
        state.schedulerMode = mode;
        state.rolledOut = rolledOut;
        return this;
      },
      setQuoteFallback(reason) {
        state.quoteFallbackReason = reason;
        return this;
      },
      setAttempts(attempts) {
        state.attempts = attempts;
        return this;
      },
      finalize() {
        if (finalized) {
          return;
        }
        finalized = true;
        try {
          logger.write(state);
        } catch {
          // never allow logging failures to escape
        }
      },
    };
  }

  getRecent(limit: number = this.buffer.length): SchedulerDecisionLog[] {
    const size = Math.min(Math.max(limit, 0), this.count);
    const entries: SchedulerDecisionLog[] = [];
    for (let offset = 1; offset <= size; offset++) {
      const index = (this.nextIndex - offset + this.buffer.length) % this.buffer.length;
      const entry = this.buffer[index];
      if (entry) {
        entries.push({ ...entry, alternatives: [...entry.alternatives] });
      }
    }
    return entries;
  }

  getSummary(windowMs: number = Number.POSITIVE_INFINITY): {
    total: number;
    stickyHitRate: number;
    successRate: number;
    avgCandidatesAfterFilter: number;
    topPeerDistribution: Record<string, number>;
    clientVersions: Record<string, number>;
  } {
    const cutoff = Number.isFinite(windowMs) ? Date.now() - windowMs : Number.NEGATIVE_INFINITY;
    const entries = this.getRecent(this.buffer.length).filter((entry) => entry.ts >= cutoff);
    const total = entries.length;
    const stickyHits = entries.filter((entry) => entry.stickyHit).length;
    const successes = entries.filter((entry) => entry.outcome === 'success' || entry.outcome === 'failover').length;
    const candidateTotal = entries.reduce((sum, entry) => sum + entry.candidatesAfterFilter, 0);
    const topPeerDistribution: Record<string, number> = {};
    const clientVersions: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.selectedPeerId) {
        topPeerDistribution[entry.selectedPeerId] =
          (topPeerDistribution[entry.selectedPeerId] ?? 0) + 1;
      }
      clientVersions[entry.clientVersion] = (clientVersions[entry.clientVersion] ?? 0) + 1;
    }

    return {
      total,
      stickyHitRate: total > 0 ? stickyHits / total : 0,
      successRate: total > 0 ? successes / total : 0,
      avgCandidatesAfterFilter: total > 0 ? candidateTotal / total : 0,
      topPeerDistribution,
      clientVersions,
    };
  }

  private write(entry: SchedulerDecisionLog): void {
    const frozen: SchedulerDecisionLog = {
      ...entry,
      alternatives: [...entry.alternatives],
      filterReasons: entry.filterReasons ? { ...entry.filterReasons } : undefined,
      latencyMs: entry.latencyMs ? { ...entry.latencyMs } : undefined,
    };
    this.buffer[this.nextIndex] = frozen;
    this.nextIndex = (this.nextIndex + 1) % this.buffer.length;
    this.count = Math.min(this.count + 1, this.buffer.length);
    console.log(`[SCHED] ${JSON.stringify(frozen)}`);
  }
}
