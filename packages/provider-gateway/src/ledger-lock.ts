import * as fs from 'node:fs';

function createLock(lockPath: string): number {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
    throw error;
  }
}

/** Only a confirmed dead local owner may be recovered; active/unknown owners fail closed. */
export function acquireLedgerLock(lockPath: string): number {
  try { return createLock(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }

  // Serialize recovery so two restarts cannot remove each other's newly acquired lock.
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryFd = createLock(recoveryPath);
  try {
    let original: string;
    try { original = fs.readFileSync(lockPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createLock(lockPath);
      throw error;
    }
    const owner = JSON.parse(original) as { pid?: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) throw new Error('Ledger lock has no valid owner PID; manual verification is required.');
    try {
      process.kill(owner.pid!, 0);
      throw new Error(`Seller ledger is locked by active PID ${owner.pid}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    if (fs.readFileSync(lockPath, 'utf8') !== original) throw new Error('Ledger lock owner changed during recovery.');
    fs.unlinkSync(lockPath);
    return createLock(lockPath);
  } finally {
    fs.closeSync(recoveryFd);
    fs.unlinkSync(recoveryPath);
  }
}
