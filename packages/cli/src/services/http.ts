import { readLocalApiToken } from './local-api-token.js';

import type { JsonValue, ServiceStatus } from '../types.js';
import { formatRequestError } from '../utils.js';

const HEALTH_FETCH_TIMEOUT_MS = 2_000;
const JSON_FETCH_TIMEOUT_MS = 15_000;

export interface ClientUpgradeRequiredPayload {
  type: 'client_upgrade_required';
  message: string;
  minClientVersion?: string;
  recommendedVersion?: string;
  upgradeUrl?: string;
  upgradeCommand?: string;
}

interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class ClientUpgradeRequiredError extends Error {
  readonly details: ClientUpgradeRequiredPayload;

  constructor(details: ClientUpgradeRequiredPayload) {
    super(details.message);
    this.name = 'ClientUpgradeRequiredError';
    this.details = details;
  }
}

export class HttpResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number, readonly details?: { type?: string; code?: string }) {
    super(message);
    this.name = 'HttpResponseError';
    this.status = status;
  }
}

export async function checkEndpoint(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetchWithTimeout(url, undefined, HEALTH_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` };
    }

    return { ok: true, message: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, message: formatRequestError(url, error) };
  }
}

export async function getServiceStatus(url: string, kind: 'buyer' | 'seller'): Promise<ServiceStatus> {
  try {
    const response = await fetchWithTimeout(url, undefined, HEALTH_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      return {
        online: false,
        message: `${kind} returned HTTP ${response.status}`,
      };
    }
    return {
      online: true,
      message: 'online',
    };
  } catch (error) {
    return {
      online: false,
      message: formatRequestError(url, error, kind),
    };
  }
}

export async function fetchJson<T>(url: string, options?: HttpRequestOptions): Promise<T> {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        accept: 'application/json',
        ...(options?.headers ?? {}),
      },
    }, options?.timeoutMs ?? JSON_FETCH_TIMEOUT_MS);
    return await parseResponse<T>(response);
  } catch (error) {
    if (error instanceof ClientUpgradeRequiredError) {
      throw error;
    }
    if (error instanceof HttpResponseError) {
      throw error;
    }
    throw new Error(formatRequestError(url, error));
  }
}

export async function postJson<T>(
  url: string,
  body: JsonValue,
  options?: HttpRequestOptions,
): Promise<T> {
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify(body),
    }, options?.timeoutMs ?? JSON_FETCH_TIMEOUT_MS);
    return await parseResponse<T>(response);
  } catch (error) {
    if (error instanceof ClientUpgradeRequiredError) {
      throw error;
    }
    if (error instanceof HttpResponseError) {
      throw error;
    }
    throw new Error(formatRequestError(url, error));
  }
}

export async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const upgradeError = extractUpgradeError(payload);
    if (upgradeError) {
      throw new ClientUpgradeRequiredError(upgradeError);
    }
    const message = extractErrorMessage(payload) ?? `HTTP ${response.status}`;
    const details = payload && typeof payload === 'object' ? (payload as { error?: { type?: string; code?: string } }).error : undefined;
    throw new HttpResponseError(message, response.status, details);
  }

  return payload as T;
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof record.message === 'string') {
    return record.message;
  }
  return null;
}

export function extractUpgradeError(payload: unknown): ClientUpgradeRequiredPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (!error || typeof error !== 'object') {
    return null;
  }
  const errorRecord = error as Record<string, unknown>;

  if (errorRecord.type !== 'client_upgrade_required' || typeof errorRecord.message !== 'string') {
    return null;
  }

  return {
    type: 'client_upgrade_required',
    message: errorRecord.message,
    ...(typeof errorRecord.minClientVersion === 'string'
      ? { minClientVersion: errorRecord.minClientVersion }
      : {}),
    ...(typeof errorRecord.recommendedVersion === 'string'
      ? { recommendedVersion: errorRecord.recommendedVersion }
      : {}),
    ...(typeof errorRecord.upgradeUrl === 'string'
      ? { upgradeUrl: errorRecord.upgradeUrl }
      : {}),
    ...(typeof errorRecord.upgradeCommand === 'string'
      ? { upgradeCommand: errorRecord.upgradeCommand }
      : {}),
  };
}

export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = JSON_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let signal = controller.signal;
  if (init?.signal) {
    if (typeof AbortSignal.any === 'function') signal = AbortSignal.any([signal, init.signal]);
    else { const external = init.signal; if (external.aborted) controller.abort(external.reason); else external.addEventListener('abort', () => controller.abort(external.reason), { once: true }); }
  }
  try {
    return await fetch(url, {
      ...init,
      headers: { ...localApiHeaders(url), ...Object.fromEntries(new Headers(init?.headers).entries()) },
      signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function localApiHeaders(url: string): Record<string, string> {
  const token = readLocalApiToken(url);
  return token ? { authorization: `Bearer ${token}` } : {};
}
