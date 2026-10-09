import { expect, it, vi } from 'vitest';
import { createStartupMonitor } from './startup-progress.js';

it('reports bounded matching stages across split chunks without forwarding arbitrary logs', () => {
  const report = vi.fn(); const consume = createStartupMonitor('buyer', report);
  consume('token=private-fixture\n[TAM_STARTUP] seller account\n[TAM_STARTUP] buyer net');
  consume('work\r\n[TAM_STARTUP] buyer ready\n[TAM_STARTUP] buyer private-fixture\n');
  expect(report.mock.calls).toEqual([['network'], ['ready']]);
});
