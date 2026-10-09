import { execFile, spawn } from 'node:child_process';

import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function spawnManagedProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
}

export async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    // Killing only Node leaves `go run` and the proxy holding seller ports on Windows.
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && child.exitCode == null && child.signalCode == null) reject(error);
        else resolve();
      });
    });
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      sendProcessSignal(child, 'SIGKILL');
    }, 5_000);

    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };

    child.once('exit', finish);
    child.once('error', finish);
    sendProcessSignal(child, 'SIGINT');
  });
}

function sendProcessSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }

  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}
