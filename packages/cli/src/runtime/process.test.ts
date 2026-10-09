import { EventEmitter } from 'node:events';
import { execFile, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  execFile: vi.fn(),
}));
import { stopProcessTree } from './process.js';

afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFile).mockReset(); });

describe('managed Windows process shutdown', () => {
  it('stops the entire owned Node/Go/proxy tree without opening a window', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null }) as unknown as ChildProcess;
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      child.exitCode = 0;
      child.emit('exit', 0);
      args.at(-1)(null);
      return child;
    });
    await stopProcessTree(child);
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/PID', '12345', '/T', '/F'], { windowsHide: true }, expect.any(Function));
  });

  it('does not send a kill command after the child exits', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: 1 }) as unknown as ChildProcess;
    await stopProcessTree(child);
    expect(execFile).not.toHaveBeenCalled();
  });
});
