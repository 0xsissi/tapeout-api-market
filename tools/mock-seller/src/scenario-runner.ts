import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  P2PRouter,
  Scheduler,
  SchedulerConfigManager,
  SchedulerLogger,
  SessionStickyTable,
  type SchedulerDecisionLog,
} from '@clawmarket/consumer-gateway';
import { createNode, StreamHandler } from '@clawmarket/p2p-node';
import type { InferenceRequest, ProviderAnnouncement, SchedulerConfig, TokenUsage } from '@clawmarket/shared';

import { MockCluster } from './mock-cluster.js';
import { SCENARIOS } from './scenarios/index.js';
import type { ScenarioAssertion, ScenarioDefinition, ScenarioReport } from './scenario-types.js';

interface CatalogProvider {
  announcement: ProviderAnnouncement;
  modelPricing: ProviderAnnouncement['models'][number];
  score: number;
}

class StaticConsumerRouter {
  constructor(private readonly getProviders: () => CatalogProvider[]) {}

  async findProviders(model: string): Promise<CatalogProvider[]> {
    return this.getProviders()
      .filter((provider) => provider.modelPricing.model === model)
      .sort((left, right) => right.score - left.score);
  }
}

class ScenarioBuyerHarness {
  private readonly configManager: SchedulerConfigManager;
  private readonly logger: SchedulerLogger;
  private readonly stickyTable: SessionStickyTable;
  private readonly router: P2PRouter;
  private readonly scheduler: Scheduler;
  private readonly streamHandler: StreamHandler;
  private readonly maxAttempts = 3;

  constructor(
    private readonly node: Awaited<ReturnType<typeof createNode>>,
    private readonly getProviders: () => CatalogProvider[],
    schedulerOverrides: Partial<SchedulerConfig>,
  ) {
    this.configManager = new SchedulerConfigManager({
      configFilePath: path.join(tmpdir(), 'clawmarket-mock-scheduler.json'),
    });
    this.configManager.updateOverride(schedulerOverrides);
    const schedulerConfig = this.configManager.get();
    this.logger = new SchedulerLogger(this.configManager.get());
    this.stickyTable = new SessionStickyTable({
      capacity: schedulerConfig.stickyTableCapacity ?? schedulerConfig.stickyMaxSize ?? 10_000,
      ttlMs: schedulerConfig.stickyTTLMs ?? 600_000,
    });
    this.router = new P2PRouter(new StaticConsumerRouter(this.getProviders) as any);
    this.scheduler = new Scheduler(
      this.router,
      this.stickyTable,
      this.configManager,
      this.logger,
    );
    this.streamHandler = new StreamHandler(this.node.libp2p);
  }

  getLogs(limit = 10_000): SchedulerDecisionLog[] {
    return this.logger.getRecent(limit);
  }

  async runRequest(options: {
    model: string;
    sessionId?: string;
    user?: string;
    stream?: boolean;
  }): Promise<{ ok: boolean; selectedPeerId?: string }> {
    const body = {
      model: options.model,
      stream: options.stream ?? false,
      session_id: options.sessionId,
      user: options.user,
      messages: [
        { role: 'system' as const, content: 'mock system' },
        { role: 'user' as const, content: `hello ${options.sessionId ?? 'anon'}` },
      ],
    };
    const requestId = randomUUID();
    const startedAt = Date.now();
    const triedPeerIds = new Set<string>();
    const logBuilder = this.logger.startRequest(requestId, options.model);
    let sessionKeyHash: string | null = null;
    let alternatives: CatalogProvider[] = [];
    let lastErrorKind = 'generic';

    const finalize = (
      outcome: 'success' | 'failover' | 'error',
      attempts: number,
      errorKind?: string,
    ) => {
      logBuilder
        .setAttempts(attempts)
        .setLatency(undefined, Date.now() - startedAt)
        .setOutcome(outcome, errorKind)
        .finalize();
    };

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let provider: CatalogProvider | null = null;
      if (attempt === 0) {
        const selected = await this.scheduler.select({
          model: options.model,
          requestId,
          body,
          excludedPeerIds: triedPeerIds,
          logBuilder,
        });
        provider = selected.provider as CatalogProvider | null;
        sessionKeyHash = selected.sessionKeyHash;
        alternatives = [...(selected.alternatives as CatalogProvider[])];
      } else if (alternatives.length > 0) {
        provider = alternatives.shift() ?? null;
        if (provider) {
          logBuilder.setSelected(
            provider.announcement.peerId,
            averagePrice(provider),
            'top_n',
            alternatives.map((candidate) => candidate.announcement.peerId),
          );
        }
      } else {
        provider = (await this.router.selectBestExcluding(
          options.model,
          triedPeerIds,
        )) as CatalogProvider | null;
        if (provider) {
          logBuilder.setSelected(provider.announcement.peerId, averagePrice(provider), 'legacy', []);
        }
      }

      if (!provider) {
        break;
      }

      triedPeerIds.add(provider.announcement.peerId);

      try {
        await this.sendInferenceRequest({
          requestId,
          provider,
          model: options.model,
          stream: options.stream ?? false,
        });
        this.router.markSuccess(provider.announcement.peerId);
        this.scheduler.onSuccess(sessionKeyHash, provider.announcement.peerId);
        finalize(attempt === 0 ? 'success' : 'failover', attempt + 1);
        return { ok: true, selectedPeerId: provider.announcement.peerId };
      } catch (error) {
        lastErrorKind = classifyError(error);
        if (process.env.MOCK_SCENARIO_VERBOSE === '1') {
          const detail = error instanceof Error ? error.stack ?? error.message : String(error);
          console.warn(
            `[mock-scenario] request ${requestId} attempt ${attempt + 1} peer=${provider.announcement.peerId} failed: ${detail}`,
          );
        }
        this.router.markFailed(provider.announcement.peerId);
        this.scheduler.onFailure(sessionKeyHash, provider.announcement.peerId, lastErrorKind);
      }
    }

    finalize('error', triedPeerIds.size, lastErrorKind);
    return { ok: false };
  }

  private async sendInferenceRequest(input: {
    requestId: string;
    provider: CatalogProvider;
    model: string;
    stream: boolean;
  }): Promise<TokenUsage> {
    const request: InferenceRequest = {
      type: 'request',
      requestId: input.requestId,
      payload: JSON.stringify({
        model: input.model,
        stream: input.stream,
      }),
      buyerPublicKey: 'mock-buyer-public-key',
      buyerAddress: '0x00000000000000000000000000000000000000aa',
      model: input.model,
      authorization: {
        buyer: '0x00000000000000000000000000000000000000aa',
        seller: input.provider.announcement.walletAddress,
        amount: 10_000n,
        nonce: 1n,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        poolId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signature: '0xmock',
      },
      timestamp: Date.now(),
    };

    let usage: TokenUsage | null = null;
    let sawTerminal = false;
    const fallbackUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for await (const message of this.streamHandler.sendRequest(
      input.provider.announcement.peerId,
      request,
      { addresses: input.provider.announcement.multiaddrs },
    )) {
      if (message.type === 'error') {
        throw new Error(message.error ?? 'mock provider error');
      }
      if (message.type === 'response') {
        usage = extractUsage(message) ?? fallbackUsage;
        sawTerminal = true;
      }
      if (message.type === 'stream_end') {
        usage = extractUsage(message) ?? fallbackUsage;
        sawTerminal = true;
      }
    }

    if (!sawTerminal) {
      throw new Error('missing_terminal_message');
    }
    return usage ?? fallbackUsage;
  }
}

async function main(): Promise<void> {
  installScenarioLogFilter();
  const scenarioName = process.argv[2] ?? 'baseline';
  const scenario = applyScenarioOverrides(SCENARIOS[scenarioName as keyof typeof SCENARIOS]);
  if (!scenario) {
    throw new Error(`Unknown scenario "${scenarioName}"`);
  }

  const basePort = resolveBasePort();

  const cluster = MockCluster.create({
    count: scenario.sellerCount,
    preset: scenario.preset,
    basePort,
  });
  await cluster.start();

  const buyerNode = await createNode({
    listenHost: '127.0.0.1',
    listenPort: basePort + scenario.sellerCount * 2 + 100,
    bootstrapPeers: [],
  });
  await buyerNode.start();

  try {
    const providerCatalog = () =>
      cluster.getAnnouncements().map((announcement) => ({
        announcement,
        modelPricing: announcement.models[0]!,
        score: scoreAnnouncement(announcement),
      }));

    const buyer = new ScenarioBuyerHarness(
      buyerNode,
      providerCatalog,
      scenario.schedulerOverrides as Partial<SchedulerConfig>,
    );

    const report = await executeScenario(scenario, buyer, cluster);
    printReport(report, scenario);

    const failures = evaluateAssertions(report, scenario.assertions);
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`[scenario] assertion failed: ${failure}`);
      }
      process.exitCode = 1;
      return;
    }
  } finally {
    await buyerNode.stop();
    await cluster.stop();
  }
}

async function executeScenario(
  scenario: ScenarioDefinition,
  buyer: ScenarioBuyerHarness,
  cluster: MockCluster,
): Promise<ScenarioReport> {
  const sessionCounts = new Map<string, number>();
  let totalRequests = 0;
  const results: Array<{ ok: boolean; selectedPeerId?: string }> = [];

  for (const phase of scenario.phases) {
    const deadline = Date.now() + phase.durationMs;
    const workers = Array.from({ length: phase.concurrency }, async (_, workerIndex) => {
      while (Date.now() < deadline) {
        const sessionId = phase.sessions
          ? `session-${workerIndex % phase.sessions}`
          : undefined;
        if (sessionId) {
          sessionCounts.set(sessionId, (sessionCounts.get(sessionId) ?? 0) + 1);
        }
        const result = await buyer.runRequest({
          model: 'mock-gpt-4',
          sessionId,
          user: sessionId ? `user:${sessionId}` : undefined,
          stream: workerIndex % 3 === 0,
        });
        results.push(result);
        totalRequests += 1;
        await sleep(20);
      }
    });
    await Promise.all(workers);
  }

  const logs = buyer.getLogs(20_000);
  const sellerSnapshot = cluster.snapshot();
  const summary = summarizeLogs(logs, sessionCounts);

  return {
    scenario: scenario.name,
    totalRequests,
    successRate: summary.successRate,
    stickyHitRate: summary.stickyHitRate,
    failoverRate: summary.failoverRate,
    topSellerShare: summary.topSellerShare,
    stickySessionRate: summary.stickySessionRate,
    logs,
    sellerSnapshot,
  };
}

function summarizeLogs(
  logs: SchedulerDecisionLog[],
  sessionCounts: Map<string, number>,
): Pick<
  ScenarioReport,
  'successRate' | 'stickyHitRate' | 'failoverRate' | 'topSellerShare' | 'stickySessionRate'
> {
  const total = logs.length;
  const successful = logs.filter((log) => log.outcome === 'success' || log.outcome === 'failover').length;
  const stickyHits = logs.filter((log) => log.selectionReason === 'sticky').length;
  const failovers = logs.filter((log) => log.outcome === 'failover').length;
  const peerCounts: Record<string, number> = {};
  for (const log of logs) {
    if (log.selectedPeerId) {
      peerCounts[log.selectedPeerId] = (peerCounts[log.selectedPeerId] ?? 0) + 1;
    }
  }
  const topSellerShare = total > 0 ? Math.max(0, ...Object.values(peerCounts)) / total : 0;

  const stickyEligible = Array.from(sessionCounts.values()).reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const stickySessionRate = stickyEligible > 0 ? stickyHits / stickyEligible : 0;

  return {
    successRate: total > 0 ? successful / total : 0,
    stickyHitRate: total > 0 ? stickyHits / total : 0,
    failoverRate: total > 0 ? failovers / total : 0,
    topSellerShare,
    stickySessionRate,
  };
}

function evaluateAssertions(
  report: ScenarioReport,
  assertions: ScenarioAssertion[],
): string[] {
  return assertions.flatMap((assertion) => {
    const actual = Number(report[assertion.metric as keyof ScenarioReport]);
    if (!Number.isFinite(actual)) {
      return [`${assertion.metric} is not numeric`];
    }
    switch (assertion.operator) {
      case '>=':
        return actual >= assertion.target ? [] : [`${assertion.metric}=${actual} < ${assertion.target}`];
      case '<=':
        return actual <= assertion.target ? [] : [`${assertion.metric}=${actual} > ${assertion.target}`];
      case '<':
        return actual < assertion.target ? [] : [`${assertion.metric}=${actual} >= ${assertion.target}`];
    }
  });
}

function printReport(report: ScenarioReport, scenario: ScenarioDefinition): void {
  console.log(JSON.stringify({
    scenario: scenario.name,
    description: scenario.description,
    totalRequests: report.totalRequests,
    successRate: round(report.successRate),
    stickyHitRate: round(report.stickyHitRate),
    failoverRate: round(report.failoverRate),
    topSellerShare: round(report.topSellerShare),
    stickySessionRate: round(report.stickySessionRate),
    crashedSellers: report.sellerSnapshot.filter((seller) => seller.crashed).length,
  }, null, 2));
}

function applyScenarioOverrides(scenario: ScenarioDefinition | undefined): ScenarioDefinition | undefined {
  if (!scenario) {
    return scenario;
  }

  const sellerCount = Number(process.env.MOCK_SCENARIO_SELLERS ?? scenario.sellerCount);
  const durationMs = process.env.MOCK_SCENARIO_DURATION_MS
    ? Number(process.env.MOCK_SCENARIO_DURATION_MS)
    : undefined;
  const concurrency = process.env.MOCK_SCENARIO_CONCURRENCY
    ? Number(process.env.MOCK_SCENARIO_CONCURRENCY)
    : undefined;

  return {
    ...scenario,
    sellerCount: Number.isFinite(sellerCount) ? sellerCount : scenario.sellerCount,
    phases: scenario.phases.map((phase) => ({
      ...phase,
      durationMs: Number.isFinite(durationMs) && durationMs != null ? durationMs : phase.durationMs,
      concurrency: Number.isFinite(concurrency) && concurrency != null ? concurrency : phase.concurrency,
    })),
  };
}

function resolveBasePort(): number {
  const envBasePort = Number(process.env.MOCK_SCENARIO_BASE_PORT);
  if (Number.isFinite(envBasePort) && envBasePort >= 10_000) {
    return Math.floor(envBasePort);
  }

  const workerOffset = Number(process.env.MOCK_SCENARIO_PORT_OFFSET ?? 0);
  if (Number.isFinite(workerOffset) && workerOffset !== 0) {
    return 22000 + Math.floor(workerOffset) * 200;
  }

  return 22000 + Math.floor(Math.random() * 100) * 200;
}

function scoreAnnouncement(announcement: ProviderAnnouncement): number {
  const model = announcement.models[0];
  if (!model) {
    return 0;
  }
  const price = (model.inputPer1m + model.outputPer1m) / 2;
  const reputation = announcement.reputation.score * 0.6 + announcement.reputation.successRate * 100 * 0.4;
  const latency = Math.max(0, 100 - announcement.reputation.avgLatencyMs / 20);
  return reputation * 0.5 + latency * 0.3 + Math.max(0, 100 - price * 10) * 0.2;
}

function classifyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('concurrency_limit')) {
    return 'concurrency_limit';
  }
  if (text.includes('missing_terminal_message')) {
    return 'missing_terminal_message';
  }
  return 'generic';
}

function extractUsage(message: unknown): TokenUsage | null {
  if (!message || typeof message !== 'object' || !('usage' in message)) {
    return null;
  }
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  if (
    'prompt_tokens' in usage &&
    'completion_tokens' in usage &&
    'total_tokens' in usage &&
    typeof (usage as any).prompt_tokens === 'number' &&
    typeof (usage as any).completion_tokens === 'number' &&
    typeof (usage as any).total_tokens === 'number'
  ) {
    return usage as TokenUsage;
  }
  return null;
}

function averagePrice(provider: CatalogProvider): number {
  return (provider.modelPricing.inputPer1m + provider.modelPricing.outputPer1m) / 2;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function installScenarioLogFilter(): void {
  if (process.env.MOCK_SCENARIO_VERBOSE === '1') {
    return;
  }
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const suppressedPrefixes = [
    '[P2P]',
    '[StreamHandler]',
    '[ProviderRegistry]',
    '[ConsumerGateway] P2PRouter',
    '[SCHED]',
  ];

  console.log = (...args: unknown[]) => {
    const firstArg = args[0];
    if (typeof firstArg === 'string' && suppressedPrefixes.some((prefix) => firstArg.startsWith(prefix))) {
      return;
    }
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    const firstArg = args[0];
    if (typeof firstArg === 'string' && suppressedPrefixes.some((prefix) => firstArg.startsWith(prefix))) {
      return;
    }
    originalWarn(...args);
  };
}

if (typeof process.argv[1] === 'string' && /scenario-runner(\.js)?$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
