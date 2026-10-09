import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../helpers/clipboard.js', () => ({ copyToClipboard: vi.fn(async () => true) }));
import { copyToClipboard } from '../../helpers/clipboard.js';
import { getCliDefaults } from '../../../config/store.js';
import { setUiLanguage } from '../../../i18n/language.js';
import type { ConsoleSnapshot } from '../types.js';
import { UsageView } from './Usage.js';

const token = 'fixture-console-api-key-012345678901234567890123456789';
beforeEach(() => { vi.stubEnv('CLAWMARKET_API_TOKEN', undefined); setUiLanguage('zh'); vi.mocked(copyToClipboard).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs(); setUiLanguage('zh'); });
async function fixture(withToken = true) {
  const home = await mkdtemp(path.join(tmpdir(), 'tam-api-view-'));
  if (withToken) { await mkdir(path.join(home, '.clawmarket')); await writeFile(path.join(home, '.clawmarket', 'api-token'), token); }
  const config = getCliDefaults({ homeDir: home }); config.buyer.url = 'http://127.0.0.1:18380';
  const snapshot: ConsoleSnapshot = { buyerService: { online: true, message: 'online' }, sellerService: { online: false, message: 'offline' }, buyerSummary: null, sellerSummary: null, networkSummary: null, selectedModel: 'gpt-6-luna', sellerQuotaWarning: false, sellerQuotaMessage: null };
  const onPushEvent = vi.fn();
  return { config, snapshot, onPushEvent, isFocused: true };
}

describe('API connection credentials', () => {
  it('displays the full key and copies key, URL and model without putting the key in activity messages', async () => {
    const props = await fixture(); const app = render(<UsageView {...props} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain(token));
    app.stdin.write('k'); await vi.waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith(token));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('已复制 API Key。'));
    app.stdin.write('u'); await vi.waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('http://127.0.0.1:18380/v1'));
    app.stdin.write('m'); await vi.waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('gpt-6-luna'));
    expect(props.onPushEvent.mock.calls.flat().join(' ')).not.toContain(token);
    setUiLanguage('en'); await vi.waitFor(() => expect(app.lastFrame()).toContain('[K] Copy API Key'));
    expect(app.lastFrame()).toContain(token);
  });
  it('refreshes a missing key after the buyer starts', async () => {
    const props = await fixture(false); props.snapshot.buyerService.online = false;
    const app = render(<UsageView {...props} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('买家启动后会自动显示'));
    await mkdir(path.join(props.config.paths.homeDir, '.clawmarket')); await writeFile(path.join(props.config.paths.homeDir, '.clawmarket', 'api-token'), token);
    app.rerender(<UsageView {...props} snapshot={{ ...props.snapshot, buyerService: { online: true, message: 'online' } }} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain(token));
  });
  it('keeps navigation focus from triggering copy and supports Enter once focused', async () => {
    const props = await fixture(); const app = render(<UsageView {...props} isFocused={false} />);
    app.stdin.write('k'); expect(copyToClipboard).not.toHaveBeenCalled();
    app.rerender(<UsageView {...props} />); await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ [K]'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(token));
  });
  it('shows remote setup instructions and never displays or copies the local key for a remote buyer', async () => {
    const props = await fixture(); const app = render(<UsageView {...props} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain(token));
    app.rerender(<UsageView {...props} config={{ ...props.config, buyer: { ...props.config.buyer, url: 'https://buyer.example.com' } }} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('当前连接的是远程买家'));
    expect(app.lastFrame()).not.toContain(token);
    app.stdin.write('k'); expect(copyToClipboard).not.toHaveBeenCalled();
  });
  it('reports clipboard failure while leaving the visible key available for manual copy', async () => {
    const props = await fixture(); vi.mocked(copyToClipboard).mockResolvedValue(false);
    const app = render(<UsageView {...props} />); app.stdin.write('k');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('复制失败'));
    expect(app.lastFrame()).toContain(token);
  });
});
