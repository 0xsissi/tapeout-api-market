import type { SchedulerDecisionLog } from '@clawmarket/consumer-gateway';

export interface ScenarioAssertion {
  metric: string;
  operator: '>=' | '<=' | '<';
  target: number;
}

export interface ScenarioPhase {
  durationMs: number;
  concurrency: number;
  sessions?: number;
}

export interface ScenarioDefinition {
  name: string;
  description: string;
  preset: 'homogeneous' | 'mixed' | 'unreliable';
  sellerCount: number;
  phases: ScenarioPhase[];
  assertions: ScenarioAssertion[];
  schedulerOverrides?: Record<string, unknown>;
}

export interface ScenarioReport {
  scenario: string;
  totalRequests: number;
  successRate: number;
  stickyHitRate: number;
  failoverRate: number;
  topSellerShare: number;
  stickySessionRate: number;
  logs: SchedulerDecisionLog[];
  sellerSnapshot: Array<{
    id: string;
    peerId: string;
    crashed: boolean;
    inflight: number;
    requests: number;
    failures: number;
  }>;
}
