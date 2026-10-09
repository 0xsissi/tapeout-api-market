import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCliDefaults } from '../../../config/store.js';
import { agentStoreFor } from '../../../agent/controller.js';
import { setUiLanguage } from '../../../i18n/language.js';
import { AgentView } from './Agent.js';

afterEach(() => { cleanup(); setUiLanguage('zh'); });
describe('AI token location privacy', () => {
  it('shows a portable location in both languages without exposing the home path or creating a token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tam-agent-view-'));
    const config = getCliDefaults({ homeDir: root });
    const store = agentStoreFor(config);
    setUiLanguage('zh');
    const app = render(<AgentView config={config} isFocused={false} onOpenPrompt={vi.fn()} onPushEvent={vi.fn()} />);
    const display = '~/.clawmarket/' + path.basename(store.tokenPath);
    await vi.waitFor(() => expect(app.lastFrame()).toContain(display));
    expect(app.lastFrame()).not.toContain(root);
    expect(store.tokenPath).toBe(path.join(root, '.clawmarket', path.basename(store.tokenPath)));
    expect(store.tokenDisplayPath).toBe(display);
    expect(existsSync(store.tokenPath)).toBe(false);
    setUiLanguage('en');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('AI access token file:'));
    expect(app.lastFrame()).toContain(display);
    expect(app.lastFrame()).not.toContain(root);
  });
});
