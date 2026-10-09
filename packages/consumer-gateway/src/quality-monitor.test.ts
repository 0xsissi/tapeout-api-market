import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signTypedData } = vi.hoisted(() => ({
  signTypedData: vi.fn(),
}));

vi.mock('viem/accounts', () => ({
  signTypedData,
  privateKeyToAccount: vi.fn(() => ({
    address: '0x0000000000000000000000000000000000000001',
  })),
}));

describe('QualityMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));
    signTypedData.mockReset();
    signTypedData.mockResolvedValue('0xattestation');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes provider stats from completed requests', async () => {
    const { QualityMonitor } = await import('./quality-monitor.js');
    const monitor = new QualityMonitor();

    monitor.startRequest('provider-a', 'req-1');
    vi.advanceTimersByTime(100);
    monitor.recordFirstToken('req-1');
    vi.advanceTimersByTime(400);
    monitor.endRequest('req-1', true, 50);

    const stats = monitor.getProviderStats('provider-a');

    expect(stats).toMatchObject({
      providerId: 'provider-a',
      avgTtftMs: 100,
      avgTotalLatencyMs: 500,
      successRate: 1,
      totalRequests: 1,
    });
    expect(stats?.avgTokensPerSecond).toBe(100);
  });

  it('handles missing first-token and token counts gracefully', async () => {
    const { QualityMonitor } = await import('./quality-monitor.js');
    const monitor = new QualityMonitor();

    monitor.startRequest('provider-a', 'req-1');
    vi.advanceTimersByTime(250);
    monitor.endRequest('req-1', false);

    const stats = monitor.getProviderStats('provider-a');

    expect(stats).toMatchObject({
      avgTtftMs: 0,
      avgTotalLatencyMs: 250,
      successRate: 0,
      avgTokensPerSecond: 0,
      totalRequests: 1,
    });
  });

  it('keeps only the most recent 100 completed requests', async () => {
    const { QualityMonitor } = await import('./quality-monitor.js');
    const monitor = new QualityMonitor();

    for (let i = 0; i < 101; i++) {
      monitor.startRequest('provider-a', `req-${i}`);
      vi.advanceTimersByTime(1);
      monitor.endRequest(`req-${i}`, true, 1);
    }

    const stats = monitor.getProviderStats('provider-a');

    expect(stats?.totalRequests).toBe(100);
  });

  it('returns null when generating an attestation for an unknown request', async () => {
    const { QualityMonitor } = await import('./quality-monitor.js');
    const monitor = new QualityMonitor();

    await expect(
      monitor.generateAttestation(
        'provider-a',
        'missing',
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      ),
    ).resolves.toBeNull();
  });

  it('generates a signed attestation for a completed request', async () => {
    const { QualityMonitor } = await import('./quality-monitor.js');
    const monitor = new QualityMonitor();

    monitor.startRequest('provider-a', 'req-1');
    vi.advanceTimersByTime(120);
    monitor.recordFirstToken('req-1');
    vi.advanceTimersByTime(380);
    monitor.endRequest('req-1', true, 250);

    const attestation = await monitor.generateAttestation(
      'provider-a',
      'req-1',
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    );

    expect(attestation).toMatchObject({
      providerId: 'provider-a',
      requestId: 'req-1',
      ttftMs: 120,
      totalLatencyMs: 500,
      tokensPerSecond: 500,
      success: true,
      buyerSignature: '0xattestation',
    });
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
});
