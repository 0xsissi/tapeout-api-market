import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ClientVersionPolicy } from './types/index.js';
import { PRODUCT_REPOSITORY } from './brand.js';
import { UNKNOWN_CLIENT_VERSION, normalizeVersion } from './version.js';

const DEFAULT_POLICY_FILE_PATH = path.join(os.homedir(), '.clawmarket', 'client-policy.json');
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export const DEFAULT_CLIENT_POLICY: ClientVersionPolicy = {
  minClientVersion: UNKNOWN_CLIENT_VERSION,
  recommendedVersion: UNKNOWN_CLIENT_VERSION,
  upgradeUrl: `${PRODUCT_REPOSITORY}/releases/latest`,
  bannedVersions: [],
};

type ClientPolicySubscriber = (
  oldPolicy: ClientVersionPolicy,
  newPolicy: ClientVersionPolicy,
) => void;

export class ClientPolicyManager {
  private readonly policyFilePath: string;
  private readonly pollIntervalMs: number;
  private current: ClientVersionPolicy;
  private overridePolicy: Partial<ClientVersionPolicy> = {};
  private watcher: NodeJS.Timeout | null = null;
  private lastKnownMtimeMs: number | null = null;
  private subscribers = new Set<ClientPolicySubscriber>();

  constructor(opts?: { policyFilePath?: string; pollIntervalMs?: number }) {
    this.policyFilePath = opts?.policyFilePath ?? DEFAULT_POLICY_FILE_PATH;
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.current = this.loadInitialPolicy();
  }

  get(): ClientVersionPolicy {
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

  onChange(callback: ClientPolicySubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  updateOverride(partial: Partial<ClientVersionPolicy>): void {
    this.overridePolicy = {
      ...this.overridePolicy,
      ...sanitizePartialPolicy(partial),
    };
    this.applyPolicy(this.buildPolicyFromSources(this.readPolicyFileSyncSafe()));
  }

  private loadInitialPolicy(): ClientVersionPolicy {
    const filePolicy = this.readPolicyFileSyncSafe();
    return this.buildPolicyFromSources(filePolicy);
  }

  private buildPolicyFromSources(filePolicy: Partial<ClientVersionPolicy>): ClientVersionPolicy {
    return sanitizePolicy({
      ...DEFAULT_CLIENT_POLICY,
      ...filePolicy,
      ...readEnvPolicy(process.env),
      ...this.overridePolicy,
    });
  }

  private async refreshFromSources(): Promise<void> {
    try {
      const info = await stat(this.policyFilePath).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') {
          return null;
        }
        throw error;
      });

      const nextMtimeMs = info?.mtimeMs ?? null;
      if (nextMtimeMs === this.lastKnownMtimeMs) {
        return;
      }

      const filePolicy = await this.readPolicyFileSafe();
      this.lastKnownMtimeMs = nextMtimeMs;
      this.applyPolicy(this.buildPolicyFromSources(filePolicy));
    } catch (error) {
      console.warn(
        `[client-policy] Failed to refresh policy from ${this.policyFilePath}: ${formatError(error)}`,
      );
    }
  }

  private async readPolicyFileSafe(): Promise<Partial<ClientVersionPolicy>> {
    try {
      const raw = await readFile(this.policyFilePath, 'utf8');
      return sanitizePartialPolicy(JSON.parse(raw) as Partial<ClientVersionPolicy>);
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      console.warn(
        `[client-policy] Failed to read policy file ${this.policyFilePath}: ${formatError(error)}`,
      );
      return {};
    }
  }

  private readPolicyFileSyncSafe(): Partial<ClientVersionPolicy> {
    try {
      const raw = readTextFile(this.policyFilePath);
      if (raw == null) {
        return {};
      }
      return sanitizePartialPolicy(JSON.parse(raw) as Partial<ClientVersionPolicy>);
    } catch (error) {
      console.warn(
        `[client-policy] Failed to read policy file ${this.policyFilePath}: ${formatError(error)}`,
      );
      return {};
    }
  }

  private applyPolicy(nextPolicy: ClientVersionPolicy): void {
    if (policiesEqual(this.current, nextPolicy)) {
      return;
    }

    const previous = this.current;
    this.current = nextPolicy;
    console.warn(
      `[client-policy] Policy updated: ${JSON.stringify({
        minClientVersion: nextPolicy.minClientVersion,
        recommendedVersion: nextPolicy.recommendedVersion,
        bannedVersions: nextPolicy.bannedVersions ?? [],
      })}`,
    );
    for (const subscriber of this.subscribers) {
      try {
        subscriber(previous, nextPolicy);
      } catch (error) {
        console.warn(`[client-policy] Subscriber failed: ${formatError(error)}`);
      }
    }
  }
}

function readEnvPolicy(env: NodeJS.ProcessEnv): Partial<ClientVersionPolicy> {
  return sanitizePartialPolicy({
    minClientVersion: env.CLAW_MIN_CLIENT_VERSION,
    recommendedVersion: env.CLAW_RECOMMENDED_VERSION,
    upgradeUrl: env.CLAW_CLIENT_UPGRADE_URL,
    upgradeMessage: env.CLAW_CLIENT_UPGRADE_MESSAGE,
  });
}

function sanitizePolicy(input: ClientVersionPolicy): ClientVersionPolicy {
  const minClientVersion = normalizeVersion(input.minClientVersion);
  const recommendedVersionRaw = input.recommendedVersion || minClientVersion;
  const recommendedVersion = normalizeVersion(recommendedVersionRaw);
  return {
    minClientVersion,
    recommendedVersion,
    upgradeUrl: typeof input.upgradeUrl === 'string' && input.upgradeUrl.trim()
      ? input.upgradeUrl.trim()
      : DEFAULT_CLIENT_POLICY.upgradeUrl,
    bannedVersions: dedupeStrings((input.bannedVersions ?? []).map(normalizeVersion)),
    upgradeMessage: typeof input.upgradeMessage === 'string' && input.upgradeMessage.trim()
      ? input.upgradeMessage.trim()
      : undefined,
  };
}

function sanitizePartialPolicy(input: Partial<ClientVersionPolicy>): Partial<ClientVersionPolicy> {
  return {
    ...(typeof input.minClientVersion === 'string'
      ? { minClientVersion: normalizeVersion(input.minClientVersion) }
      : {}),
    ...(typeof input.recommendedVersion === 'string'
      ? { recommendedVersion: normalizeVersion(input.recommendedVersion) }
      : {}),
    ...(typeof input.upgradeUrl === 'string' && input.upgradeUrl.trim()
      ? { upgradeUrl: input.upgradeUrl.trim() }
      : {}),
    ...(Array.isArray(input.bannedVersions)
      ? { bannedVersions: dedupeStrings(input.bannedVersions.map(normalizeVersion)) }
      : {}),
    ...(typeof input.upgradeMessage === 'string' && input.upgradeMessage.trim()
      ? { upgradeMessage: input.upgradeMessage.trim() }
      : {}),
  };
}

function policiesEqual(a: ClientVersionPolicy, b: ClientVersionPolicy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
