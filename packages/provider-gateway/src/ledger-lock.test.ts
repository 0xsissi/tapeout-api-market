import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLedgerLock } from './ledger-lock.js';

let directory: string;
let lockPath: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-ledger-recovery-')); lockPath = path.join(directory, 'ledger.lock'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('seller ledger lock recovery', () => {
  it('recovers a confirmed dead PID without changing the payment ledger', () => {
    const queue = path.join(directory, 'claim-queue.json');
    fs.writeFileSync(queue, '[{"amount":"25","nonce":"1"}]');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 14672, startedAt: '2026-10-08T08:40:42Z' }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    const fd = acquireLedgerLock(lockPath);
    try {
      expect(kill).toHaveBeenCalledWith(14672, 0);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
      expect(fs.readFileSync(queue, 'utf8')).toBe('[{"amount":"25","nonce":"1"}]');
      expect(fs.existsSync(`${lockPath}.recovery`)).toBe(false);
    } finally { fs.closeSync(fd); }
  });

  it.each(['alive', 'permission-denied'])('never removes a lock with an %s owner', kind => {
    const original = JSON.stringify({ pid: 12345 }); fs.writeFileSync(lockPath, original);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (kind === 'permission-denied') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return true;
    });
    expect(() => acquireLedgerLock(lockPath)).toThrow();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(original);
    expect(fs.existsSync(`${lockPath}.recovery`)).toBe(false);
  });

  it.each(['{broken', '{"pid":0}', '{}'])('preserves an unknown/corrupt lock: %s', original => {
    fs.writeFileSync(lockPath, original);
    const kill = vi.spyOn(process, 'kill');
    expect(() => acquireLedgerLock(lockPath)).toThrow();
    expect(kill).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(original);
  });

  it('does not touch the original lock while another recovery is in progress', () => {
    fs.writeFileSync(lockPath, '{"pid":14672}'); fs.writeFileSync(`${lockPath}.recovery`, '{"pid":12345}');
    const kill = vi.spyOn(process, 'kill');
    expect(() => acquireLedgerLock(lockPath)).toThrow();
    expect(kill).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('{"pid":14672}');
  });
});
