export interface ClockProbeResult {
  source: string;
  remoteTimeMs: number;
  midpointTimeMs: number;
  skewMs: number;
  absoluteSkewMs: number;
  roundTripMs: number;
}

export interface ClockCheckResult extends ClockProbeResult {
  reachable: true;
  warning: boolean;
  fatal: boolean;
}

export interface ClockCheckUnavailable {
  reachable: false;
  reason: string;
}

interface HeadersLike {
  get(name: string): string | null;
}

interface ResponseLike {
  headers: HeadersLike;
}

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  },
) => Promise<ResponseLike>;

export const DEFAULT_CLOCK_SKEW_URLS = [
  'https://www.google.com/generate_204',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://example.com/',
] as const;

export async function probeClockSkew(options: {
  url: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): Promise<ClockProbeResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) {
    throw new Error('fetch_unavailable');
  }

  const now = options.now ?? Date.now;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  const startedAt = now();
  try {
    const response = await fetchImpl(options.url, {
      method: 'HEAD',
      signal: controller?.signal,
      headers: {
        'cache-control': 'no-store',
      },
    });
    const finishedAt = now();
    const dateHeader = response.headers.get('date');
    if (!dateHeader) {
      throw new Error('missing_date_header');
    }
    const remoteTimeMs = new Date(dateHeader).getTime();
    if (!Number.isFinite(remoteTimeMs)) {
      throw new Error('invalid_date_header');
    }

    const midpointTimeMs = startedAt + (finishedAt - startedAt) / 2;
    const skewMs = remoteTimeMs - midpointTimeMs;
    return {
      source: options.url,
      remoteTimeMs,
      midpointTimeMs,
      skewMs,
      absoluteSkewMs: Math.abs(skewMs),
      roundTripMs: finishedAt - startedAt,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function checkClockSkew(options: {
  urls?: readonly string[];
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  warningMs?: number;
  fatalMs?: number;
} = {}): Promise<ClockCheckResult | ClockCheckUnavailable> {
  const urls = options.urls ?? DEFAULT_CLOCK_SKEW_URLS;
  const warningMs = options.warningMs ?? 30_000;
  const fatalMs = options.fatalMs ?? 300_000;

  let lastReason = 'no_probe_attempted';
  for (const url of urls) {
    try {
      const result = await probeClockSkew({
        url,
        fetchImpl: options.fetchImpl,
        now: options.now,
        timeoutMs: options.timeoutMs,
      });
      return {
        ...result,
        reachable: true,
        warning: result.absoluteSkewMs > warningMs,
        fatal: result.absoluteSkewMs > fatalMs,
      };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    reachable: false,
    reason: lastReason,
  };
}

export function formatClockSkewMs(skewMs: number): string {
  const sign = skewMs < 0 ? '-' : '+';
  return `${sign}${Math.round(Math.abs(skewMs))}ms`;
}
