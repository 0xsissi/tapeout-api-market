import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const stringify = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bigint: v.toString() } : v);

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    // POSIX needs the directory entry flushed too; Windows cannot fsync directories.
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function readJsonSafely(file: string, fallback: unknown): unknown {
  if (!fs.existsSync(file)) return fallback;
  // Fail closed. A damaged ledger is evidence to recover, never an empty queue.
  return JSON.parse(fs.readFileSync(file, 'utf8'), (_, v) =>
    v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v);
}
