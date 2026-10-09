import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  spawn: vi.fn(),
}));
import { ensureGoToolchain, parseWindowsSystemProxy } from './embedded-cliproxy.mjs';

afterEach(() => vi.resetAllMocks());

describe('Go toolchain preflight', () => {
  it('recognizes an enabled Windows HTTP proxy without using a disabled or SOCKS-only setting', () => {
    expect(parseWindowsSystemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:7897')).toBe('http://127.0.0.1:7897');
    expect(parseWindowsSystemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:80;https=127.0.0.1:443')).toBe('http://127.0.0.1:443');
    expect(parseWindowsSystemProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ 127.0.0.1:7897')).toBe('');
    expect(parseWindowsSystemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ socks=127.0.0.1:1080')).toBe('');
  });

  it('uses the module directory so Go auto-selection can satisfy a newer required version', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'tam-go-module-'));
    await writeFile(path.join(source, 'go.mod'), 'module fixture\n\ngo 1.26.0\n');
    vi.mocked(spawn).mockImplementation((_command, _args, options: any) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stdout.write(`go version go${options.cwd === source ? '1.26.0' : '1.23.0'} windows/amd64\n`);
        child.emit('exit', 0);
      });
      return child as any;
    });
    await expect(ensureGoToolchain(source)).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith('go', ['version'], expect.objectContaining({ cwd: source, windowsHide: true }));
  });
});
