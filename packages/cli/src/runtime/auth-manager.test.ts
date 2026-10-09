import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  backupAuthDir,
  cleanupLoggedOutAuthDirs,
  clearAuthDir,
  deleteBackup,
  listAuthBackups,
  logoutCurrent,
  restoreAuthDir,
  switchToBackup,
} from './auth-manager.js';

describe('auth manager', () => {
  it('backs up auth files and recreates an empty auth directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    await mkdir(authDir);
    await writeFile(path.join(authDir, 'token.json'), '{"ok":true}\n', 'utf8');

    const backupPath = await backupAuthDir(authDir, 'codex');

    expect(backupPath).toContain(`${authDir}.bak-codex-`);
    await expect(readdir(authDir)).resolves.toEqual([]);
    await expect(readFile(path.join(backupPath!, 'token.json'), 'utf8')).resolves.toBe('{"ok":true}\n');
  });

  it('returns null when there is no auth to back up', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    await mkdir(authDir);

    await expect(backupAuthDir(authDir, 'claude')).resolves.toBeNull();
  });

  it('backs up auth files inside nested directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    await mkdir(path.join(authDir, 'nested'), { recursive: true });
    await writeFile(path.join(authDir, 'nested', 'token.json'), '{"nested":true}\n', 'utf8');

    const backupPath = await backupAuthDir(authDir, 'gemini');

    expect(backupPath).toContain(`${authDir}.bak-gemini-`);
    await expect(readFile(path.join(backupPath!, 'nested', 'token.json'), 'utf8')).resolves.toBe('{"nested":true}\n');
  });

  it('restores a previous auth backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    const backupDir = path.join(root, 'auths.bak-codex-2026-04-21T00-00-00-000Z');
    await mkdir(authDir);
    await mkdir(backupDir);
    await writeFile(path.join(authDir, 'new.json'), '{"new":true}\n', 'utf8');
    await writeFile(path.join(backupDir, 'old.json'), '{"old":true}\n', 'utf8');

    await restoreAuthDir(authDir, backupDir);

    await expect(readFile(path.join(authDir, 'old.json'), 'utf8')).resolves.toBe('{"old":true}\n');
    await expect(readdir(root)).resolves.toEqual(['auths']);
  });

  it('clears partial auth files while keeping the auth directory available', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    await mkdir(authDir);
    await writeFile(path.join(authDir, 'partial.json'), '{"partial":true}\n', 'utf8');

    await clearAuthDir(authDir);

    await expect(readdir(authDir)).resolves.toEqual([]);
  });

  it('lists auth backups with inspected identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    const backupDir = path.join(root, 'auths.bak-claude-2026-04-21T00-00-00-000Z');
    await mkdir(authDir);
    await mkdir(backupDir);
    await writeFile(path.join(backupDir, 'claude-user@example.com.json'), JSON.stringify({
      type: 'claude',
      email: 'user@example.com',
    }), 'utf8');

    await expect(listAuthBackups(authDir)).resolves.toEqual([
      expect.objectContaining({
        path: backupDir,
        upstream: 'claude',
        identity: 'user@example.com',
        savedAt: '2026-04-21T00:00:00.000Z',
      }),
    ]);
  });

  it('switches to a backup and preserves current auth as a new backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    const backupDir = path.join(root, 'auths.bak-gemini-2026-04-21T00-00-00-000Z');
    await mkdir(authDir);
    await mkdir(backupDir);
    await writeFile(path.join(authDir, 'codex.json'), '{"type":"codex"}\n', 'utf8');
    await writeFile(path.join(backupDir, 'gemini.json'), '{"type":"gemini"}\n', 'utf8');

    const currentBackup = await switchToBackup({ authDir, backupPath: backupDir, currentUpstream: 'codex' });

    expect(currentBackup).toContain(`${authDir}.bak-codex-`);
    await expect(readFile(path.join(authDir, 'gemini.json'), 'utf8')).resolves.toBe('{"type":"gemini"}\n');
    await expect(readFile(path.join(currentBackup!, 'codex.json'), 'utf8')).resolves.toBe('{"type":"codex"}\n');
  });

  it('logs out current auth without deleting it permanently', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    await mkdir(authDir);
    await writeFile(path.join(authDir, 'codex.json'), '{"type":"codex"}\n', 'utf8');

    const logoutPath = await logoutCurrent(authDir);

    expect(logoutPath).toContain(`${authDir}.loggedout-`);
    await expect(readdir(authDir)).resolves.toEqual([]);
    await expect(readFile(path.join(logoutPath!, 'codex.json'), 'utf8')).resolves.toBe('{"type":"codex"}\n');
  });

  it('deletes backups and cleans old logged-out dirs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-'));
    const authDir = path.join(root, 'auths');
    const backupDir = path.join(root, 'auths.bak-codex-2026-04-21T00-00-00-000Z');
    const oldLogoutDir = path.join(root, 'auths.loggedout-2020-01-01T00-00-00-000Z');
    await mkdir(authDir);
    await mkdir(backupDir);
    await mkdir(oldLogoutDir);

    await deleteBackup(backupDir);
    const removed = await cleanupLoggedOutAuthDirs(authDir);

    await expect(readdir(root)).resolves.toEqual(['auths']);
    expect(removed).toEqual([oldLogoutDir]);
  });
});
