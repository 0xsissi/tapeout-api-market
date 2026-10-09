import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { copyToClipboard } from './clipboard.js';

afterEach(() => vi.clearAllMocks());
describe('clipboard helper', () => {
  it('passes credential text over stdin instead of exposing it in process arguments', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: ReturnType<typeof vi.fn> } };
    child.stdin = Object.assign(new EventEmitter(), { end: vi.fn(() => queueMicrotask(() => child.emit('exit', 0))) });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const value = 'fixture-only-api-key-01234567890123456789';
    await expect(copyToClipboard(value)).resolves.toBe(true);
    expect(child.stdin.end).toHaveBeenCalledWith(value);
    expect(JSON.stringify(vi.mocked(spawn).mock.calls[0])).not.toContain(value);
  });
  it('returns a readable failure result if the clipboard pipe closes early', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: ReturnType<typeof vi.fn> } };
    child.stdin = Object.assign(new EventEmitter(), { end: vi.fn(() => queueMicrotask(() => child.stdin.emit('error', new Error('Clipboard pipe closed')))) });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    await expect(copyToClipboard('fixture text')).resolves.toBe(false);
  });
});
