import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SchedulerConfig, SchedulerMode } from '@clawmarket/shared';

const DEFAULT_CONFIG_FILE_PATH = path.join(os.homedir(), '.clawmarket', 'scheduler.json');
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export { type SchedulerConfig, type SchedulerMode } from '@clawmarket/shared';

export const DEFAULT_CONFIG: SchedulerConfig = {
  mode: 'legacy',
  killSwitch: false,
  rolloutPct: 0,
  enableHardFilter: true,
  enableSessionSticky: true,
  enableTopNPreselect: true,
  enableP2C: true,
  minSuccessRate: 0.95,
  minReputationScore: 60,
  minUptimeRate: 0.9,
  newSellerExplorationRate: 0.05,
  stickyMaxSize: 10_000,
  stickyTableCapacity: 10_000,
  stickyTTLMs: 600_000,
  stickyOverflowRatio: 0.9,
  stickyFailureIgnoreWindowMs: 60_000,
  topN: 3,
  priceWeightAlpha: 1.5,
  scoreTieThreshold: 0.05,
  logLevel: 'info',
  logRingBufferSize: 500,
};

type SchedulerConfigSubscriber = (oldCfg: SchedulerConfig, newCfg: SchedulerConfig) => void;

export class SchedulerConfigManager {
  private readonly configFilePath: string;
  private readonly pollIntervalMs: number;
  private current: SchedulerConfig;
  private overrideConfig: Partial<SchedulerConfig> = {};
  private watcher: NodeJS.Timeout | null = null;
  private lastKnownMtimeMs: number | null = null;
  private subscribers = new Set<SchedulerConfigSubscriber>();

  constructor(opts?: { configFilePath?: string; pollIntervalMs?: number }) {
    this.configFilePath = opts?.configFilePath ?? process.env.CLAW_SCHEDULER_CONFIG_PATH ?? DEFAULT_CONFIG_FILE_PATH;
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.current = this.loadInitialConfig();
  }

  get(): SchedulerConfig {
    return this.current;
  }

  startWatching(): void {
    if (this.watcher) {
      return;
    }

    void this.refreshFromSources();
    this.watcher = setInterval(() => {
      void this.refreshFromSources();
    }, this.pollIntervalMs);
  }

  stopWatching(): void {
    if (!this.watcher) {
      return;
    }
    clearInterval(this.watcher);
    this.watcher = null;
  }

  onChange(callback: SchedulerConfigSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  updateOverride(partial: Partial<SchedulerConfig>): void {
    this.overrideConfig = {
      ...this.overrideConfig,
      ...sanitizePartialConfig(partial),
    };
    this.applyConfig(this.buildConfigFromSources(this.readConfigFileSyncSafe()));
  }

  private loadInitialConfig(): SchedulerConfig {
    const fileConfig = this.readConfigFileSyncSafe();
    return this.buildConfigFromSources(fileConfig);
  }

  private buildConfigFromSources(fileConfig: Partial<SchedulerConfig>): SchedulerConfig {
    return sanitizeConfig({
      ...DEFAULT_CONFIG,
      ...readEnvConfig(process.env),
      ...fileConfig,
      ...this.overrideConfig,
    });
  }

  private async refreshFromSources(): Promise<void> {
    try {
      const info = await stat(this.configFilePath).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') {
          return null;
        }
        throw error;
      });

      const nextMtimeMs = info?.mtimeMs ?? null;
      if (nextMtimeMs === this.lastKnownMtimeMs) {
        return;
      }

      const fileConfig = await this.readConfigFileSafe();
      this.lastKnownMtimeMs = nextMtimeMs;
      this.applyConfig(this.buildConfigFromSources(fileConfig));
    } catch (error) {
      console.warn(
        `[SCHED] Failed to refresh scheduler config from ${this.configFilePath}: ${formatError(error)}`,
      );
    }
  }

  private async readConfigFileSafe(): Promise<Partial<SchedulerConfig>> {
    try {
      const raw = await readFile(this.configFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SchedulerConfig>;
      return sanitizePartialConfig(parsed);
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      console.warn(
        `[SCHED] Failed to read scheduler config file ${this.configFilePath}: ${formatError(error)}`,
      );
      return {};
    }
  }

  private readConfigFileSyncSafe(): Partial<SchedulerConfig> {
    try {
      const raw = requireTextFile(this.configFilePath);
      if (raw == null) {
        return {};
      }
      const parsed = JSON.parse(raw) as Partial<SchedulerConfig>;
      return sanitizePartialConfig(parsed);
    } catch (error) {
      console.warn(
        `[SCHED] Failed to read scheduler config file ${this.configFilePath}: ${formatError(error)}`,
      );
      return {};
    }
  }

  private applyConfig(nextConfig: SchedulerConfig): void {
    if (configsEqual(this.current, nextConfig)) {
      return;
    }

    const previous = this.current;
    this.current = nextConfig;
    console.warn(
      `[SCHED] Scheduler config updated: ${JSON.stringify({
        mode: nextConfig.mode,
        killSwitch: nextConfig.killSwitch,
        rolloutPct: nextConfig.rolloutPct,
        enableHardFilter: nextConfig.enableHardFilter,
        enableSessionSticky: nextConfig.enableSessionSticky,
        enableTopNPreselect: nextConfig.enableTopNPreselect,
        enableP2C: nextConfig.enableP2C,
        topN: nextConfig.topN,
      })}`,
    );
    for (const subscriber of this.subscribers) {
      try {
        subscriber(previous, nextConfig);
      } catch (error) {
        console.warn(`[SCHED] Scheduler config subscriber failed: ${formatError(error)}`);
      }
    }
  }
}

function readEnvConfig(env: NodeJS.ProcessEnv): Partial<SchedulerConfig> {
  const stickyMaxSize =
    parseNumber(env.CLAW_SCHEDULER_STICKY_MAX_SIZE) ??
    parseNumber(env.CLAW_SCHEDULER_STICKY_CAPACITY);

  return sanitizePartialConfig({
    mode: parseMode(env.CLAW_SCHEDULER_MODE),
    killSwitch: parseBoolean(env.CLAW_SCHEDULER_KILL),
    rolloutPct: parseNumber(env.CLAW_SCHEDULER_ROLLOUT_PCT),
    enableHardFilter: parseBoolean(env.CLAW_SCHEDULER_ENABLE_HARD_FILTER),
    enableSessionSticky: parseBoolean(env.CLAW_SCHEDULER_ENABLE_STICKY),
    enableTopNPreselect: parseBoolean(env.CLAW_SCHEDULER_ENABLE_TOP_N),
    enableP2C: parseBoolean(env.CLAW_SCHEDULER_ENABLE_P2C),
    minSuccessRate: parseNumber(env.CLAW_SCHEDULER_MIN_SUCCESS_RATE),
    minReputationScore: parseNumber(env.CLAW_SCHEDULER_MIN_REPUTATION_SCORE),
    minUptimeRate: parseNumber(env.CLAW_SCHEDULER_MIN_UPTIME_RATE),
    newSellerExplorationRate: parseNumber(env.CLAW_SCHEDULER_NEW_SELLER_EXPLORATION_RATE),
    stickyMaxSize,
    stickyTableCapacity: stickyMaxSize,
    stickyTTLMs: parseNumber(env.CLAW_SCHEDULER_STICKY_TTL_MS),
    stickyOverflowRatio: parseNumber(env.CLAW_SCHEDULER_STICKY_OVERFLOW_RATIO),
    stickyFailureIgnoreWindowMs: parseNumber(
      env.CLAW_SCHEDULER_STICKY_FAILURE_IGNORE_WINDOW_MS,
    ),
    topN: parseNumber(env.CLAW_SCHEDULER_TOP_N),
    priceWeightAlpha: parseNumber(env.CLAW_SCHEDULER_PRICE_WEIGHT_ALPHA),
    scoreTieThreshold: parseNumber(env.CLAW_SCHEDULER_SCORE_TIE_THRESHOLD),
    logLevel: parseLogLevel(env.CLAW_SCHEDULER_LOG_LEVEL),
    logRingBufferSize: parseNumber(env.CLAW_SCHEDULER_LOG_RING_BUFFER_SIZE),
  });
}

function sanitizeConfig(input: SchedulerConfig): SchedulerConfig {
  const stickyMaxSize = clampNumber(
    input.stickyMaxSize ?? input.stickyTableCapacity ?? DEFAULT_CONFIG.stickyMaxSize,
    1,
    Number.MAX_SAFE_INTEGER,
    DEFAULT_CONFIG.stickyMaxSize,
  );

  return {
    ...DEFAULT_CONFIG,
    ...sanitizePartialConfig(input),
    mode: parseMode(input.mode) ?? DEFAULT_CONFIG.mode,
    killSwitch: Boolean(input.killSwitch),
    rolloutPct: clampNumber(input.rolloutPct, 0, 100, DEFAULT_CONFIG.rolloutPct),
    enableP2C: typeof input.enableP2C === 'boolean' ? input.enableP2C : DEFAULT_CONFIG.enableP2C,
    minSuccessRate: clampNumber(input.minSuccessRate, 0, 1, DEFAULT_CONFIG.minSuccessRate),
    minReputationScore: clampNumber(
      input.minReputationScore,
      0,
      100,
      DEFAULT_CONFIG.minReputationScore,
    ),
    minUptimeRate: clampNumber(input.minUptimeRate, 0, 1, DEFAULT_CONFIG.minUptimeRate),
    newSellerExplorationRate: clampNumber(
      input.newSellerExplorationRate,
      0,
      1,
      DEFAULT_CONFIG.newSellerExplorationRate,
    ),
    stickyMaxSize,
    stickyTableCapacity: stickyMaxSize,
    stickyTTLMs: clampNumber(input.stickyTTLMs, 1, Number.MAX_SAFE_INTEGER, DEFAULT_CONFIG.stickyTTLMs),
    stickyOverflowRatio: clampNumber(
      input.stickyOverflowRatio,
      0,
      1,
      DEFAULT_CONFIG.stickyOverflowRatio,
    ),
    stickyFailureIgnoreWindowMs: clampNumber(
      input.stickyFailureIgnoreWindowMs,
      0,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_CONFIG.stickyFailureIgnoreWindowMs,
    ),
    topN: clampNumber(input.topN, 1, 20, DEFAULT_CONFIG.topN),
    priceWeightAlpha: clampNumber(
      input.priceWeightAlpha,
      0.1,
      10,
      DEFAULT_CONFIG.priceWeightAlpha,
    ),
    scoreTieThreshold: clampNumber(
      input.scoreTieThreshold,
      0,
      1,
      DEFAULT_CONFIG.scoreTieThreshold,
    ),
    logLevel: parseLogLevel(input.logLevel) ?? DEFAULT_CONFIG.logLevel,
    logRingBufferSize: clampNumber(
      input.logRingBufferSize,
      1,
      10_000,
      DEFAULT_CONFIG.logRingBufferSize,
    ),
  };
}

function sanitizePartialConfig(input: Partial<SchedulerConfig>): Partial<SchedulerConfig> {
  const next: Partial<SchedulerConfig> = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof SchedulerConfig, unknown]>) {
    if (typeof value === 'undefined') {
      continue;
    }
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function configsEqual(left: SchedulerConfig, right: SchedulerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseBoolean(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function parseNumber(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMode(value: unknown): SchedulerMode | undefined {
  return value === 'legacy' || value === 'new' ? value : undefined;
}

function parseLogLevel(
  value: unknown,
): SchedulerConfig['logLevel'] | undefined {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : undefined;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'ENOENT');
}

function requireTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
