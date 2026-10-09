import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { inspectAuthDir } from './auth-inspector.js';

describe('auth inspector', () => {
  it('recognizes Codex auth identity from token JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-inspect-'));
    const authDir = path.join(root, 'auths');
    await mkdir(authDir);
    await writeFile(path.join(authDir, 'codex-user@example.com-plus.json'), JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
    }), 'utf8');

    await expect(inspectAuthDir(authDir)).resolves.toMatchObject({
      upstream: 'codex',
      identity: 'user@example.com',
      fileCount: 1,
      hasAuth: true,
    });
  });

  it('recognizes Claude and Gemini auth shapes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-inspect-'));
    const claudeDir = path.join(root, 'claude');
    const geminiDir = path.join(root, 'gemini');
    await mkdir(claudeDir);
    await mkdir(geminiDir);
    await writeFile(path.join(claudeDir, 'claude-team@example.com.json'), JSON.stringify({
      type: 'claude',
      email: 'team@example.com',
    }), 'utf8');
    await writeFile(path.join(geminiDir, 'person@example.com-project.json'), JSON.stringify({
      type: 'gemini',
      email: 'person@example.com',
      project_id: 'project',
    }), 'utf8');

    await expect(inspectAuthDir(claudeDir)).resolves.toMatchObject({
      upstream: 'claude',
      identity: 'team@example.com',
    });
    await expect(inspectAuthDir(geminiDir)).resolves.toMatchObject({
      upstream: 'gemini',
      identity: 'person@example.com',
    });
  });

  it('does not fail on missing or unreadable auth dirs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-auth-inspect-'));

    await expect(inspectAuthDir(path.join(root, 'missing'))).resolves.toMatchObject({
      upstream: null,
      identity: null,
      hasAuth: false,
      fileCount: 0,
    });
  });
});
