import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { Box, Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/buyer-runtime.js', async () => ({
  ...await vi.importActual<typeof import('../../runtime/buyer-runtime.js')>('../../runtime/buyer-runtime.js'),
  startBuyerRuntime: vi.fn(async () => {}),
  stopBuyerRuntime: vi.fn(async () => false),
  cancelBuyerStartup: vi.fn(async () => {}),
}));
vi.mock('../../services/http.js', () => ({
  getServiceStatus: vi.fn(async () => ({ online: false, message: '尚未启动' })),
}));
vi.mock('../../wallet/store.js', async () => ({
  ...await vi.importActual<typeof import('../../wallet/store.js')>('../../wallet/store.js'),
  ensureStoredWallet: vi.fn(async () => ({ created: false, wallet: { address: '0x1111111111111111111111111111111111111111' } })),
  importStoredWallet: vi.fn(),
}));
vi.mock('../../services/buyer.js', async () => ({
  ...await vi.importActual<typeof import('../../services/buyer.js')>('../../services/buyer.js'),
  requestChatStream: vi.fn(),
}));

import { getCliDefaults } from '../../config/store.js';
import { requestChatStream } from '../../services/buyer.js';
import { ConsoleApp } from './index.js';
import { ConsoleFrame } from './components/ConsoleFrame.js';
import { FocusedSelectInput } from './components/FocusedSelectInput.js';
import { ScrollViewport } from './components/ScrollViewport.js';
import { PromptModal } from './components/PromptModal.js';
import { CommandPalette } from './components/CommandPalette.js';
import { consoleNavItems } from './lib.js';
import { setUiLanguage } from '../../i18n/language.js';
import { translateUiText } from '@clawmarket/shared';

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.mocked(requestChatStream).mockReset(); setUiLanguage('zh'); });

const header = <Box borderStyle="single" width="100%"><Text wrap="truncate-end">Tapeout API Market (TAM)</Text></Box>;
const frameLines = (frame: string | undefined) => (frame ?? '').split('\n');
const anchors = (frame: string | undefined) => {
  const lines = frameLines(frame);
  return [lines.findIndex(line => line.includes('Tapeout API Market')), lines.findIndex(line => line.includes('最近活动')), lines.findIndex(line => line.includes('FOOTER'))];
};

describe('fixed terminal frame', () => {
  it.each([[100, 32], [100, 24], [60, 24], [80, 18]])('keeps the header, activity and footer in place at %i columns / %i rows', async (columns, rows) => {
    const tree = (content: React.ReactNode, modal = false) => <ConsoleFrame
      columns={columns} rows={rows} header={header} status={'long status '.repeat(30)}
      currentView="wallet" navFocused title="余额与充值"
      events={Array.from({ length: 20 }, (_, i) => ({ time: '08:02:08', scope: '系统', message: `event ${i}\n${'长日志'.repeat(100)}` }))}
      footer="FOOTER · Tab 菜单 · PgUp/PgDn 翻页"
      modal={modal ? { title: '充值确认', content } : undefined}
    >{content}</ConsoleFrame>;
    const app = render(tree(<Text>short page</Text>));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('FOOTER'));
    const original = anchors(app.lastFrame());
    const mainTop = rows >= 28 || columns >= 80 && rows >= 24 ? 4 : 5;
    expect(frameLines(app.lastFrame())[mainTop]?.trimEnd().endsWith('┐')).toBe(true);
    for (const modal of [false, true]) {
      app.rerender(tree(<Text>{Array.from({ length: 100 }, (_, i) => `line ${i}: ${'long answer '.repeat(10)}`).join('\n')}</Text>, modal));
      await vi.waitFor(() => expect(app.lastFrame()).toContain('PgUp/PgDn'));
      expect(anchors(app.lastFrame())).toEqual(original);
      expect(frameLines(app.lastFrame())).toHaveLength(rows - 1);
      expect(frameLines(app.lastFrame())[mainTop]?.trimEnd().endsWith('┐')).toBe(true);
      expect(app.lastFrame()).toContain('event 19');
      expect(app.lastFrame()).not.toContain('event 0');
    }
  });

  it('keeps the selected action visible and allows paging without selecting or submitting it', async () => {
    const onSelect = vi.fn();
    const app = render(<ScrollViewport height={9}>
      <Text>{Array.from({ length: 20 }, (_, i) => `explanation ${i}`).join('\n')}</Text>
      <FocusedSelectInput isFocused items={Array.from({ length: 12 }, (_, i) => ({ label: `action ${i}`, value: i }))} onSelect={onSelect} />
    </ScrollViewport>);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ action 0'));
    for (let i = 1; i <= 11; i++) {
      app.stdin.write('\u001B[B');
      await vi.waitFor(() => expect(app.lastFrame()).toContain(`▶ action ${i}`));
      expect(frameLines(app.lastFrame()).length).toBeLessThanOrEqual(9);
    }
    app.stdin.write('\u001B[5~');
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('▶ action 11'));
    expect(onSelect).not.toHaveBeenCalled();
    app.stdin.write('\u001B[6~');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ action 11'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 11 })));
  });

  it('keeps a prompt input visible below a long explanation', async () => {
    const app = render(<ScrollViewport height={9}><PromptModal
      title="充值金额" description={'说明\n'.repeat(30)} initialValue="" placeholder="输入金额" onSubmit={() => {}}
    /></ScrollViewport>);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('输入金额'));
    app.stdin.write('0.25');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('0.25'));
    expect(frameLines(app.lastFrame()).length).toBeLessThanOrEqual(9);
  });

  it('reveals the selected command in a small command palette without running it', async () => {
    const onRun = vi.fn();
    const tree = (selectedIndex: number) => <ScrollViewport height={7}><CommandPalette
      query="" selectedIndex={selectedIndex} onChange={() => {}} onRun={onRun}
      commands={Array.from({ length: 8 }, (_, i) => ({ id: `command-${i}`, label: `command ${i}`, keywords: [] }))}
    /></ScrollViewport>;
    const app = render(tree(0));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('› 1. command 0'));
    app.rerender(tree(7));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('› 8. command 7'));
    expect(onRun).not.toHaveBeenCalled();
    expect(frameLines(app.lastFrame()).length).toBeLessThanOrEqual(7);
  });

  it('follows a growing answer at the bottom and preserves the reading position after paging up', async () => {
    const answer = (count: number) => <ScrollViewport height={8} followOutput><Text>{Array.from({ length: count }, (_, i) => `answer line ${i}`).join('\n')}</Text></ScrollViewport>;
    const app = render(answer(3));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('answer line 2'));
    app.rerender(answer(40));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('answer line 39'));
    app.stdin.write('\u001B[5~');
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('answer line 39'));
    const before = app.lastFrame()?.split('\n')[0];
    app.rerender(answer(60));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('/ 60 行'));
    expect(app.lastFrame()?.split('\n')[0]).toBe(before);
  });
});

describe('real console navigation and streaming', () => {
  it.each(['zh', 'en'] as const)('shows chat connection failures, releases the menu and excludes failed turns from the next request (%s)', async language => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tam-console-chat-error-'));
    const config = getCliDefaults({ homeDir: root, cwd: process.cwd() });
    config.settlement = { ...config.settlement!, escrowPoolAddress: '0x1111111111111111111111111111111111111111', maxRequestCostToken: 0.01, maxUnconfirmedCreditToken: 0.01, dailyLimitToken: 1 };
    setUiLanguage(language);
    const app = render(<ConsoleApp config={config} />);
    Object.defineProperty(app.stdout, 'rows', { value: 36, configurable: true }); app.stdout.emit('resize');
    app.stdin.write('\t'); app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '▶ 调用体验' : '▶ Chat'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '▶ 发送消息' : '▶ Send message'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '输入问题' : 'Type a question'));
    app.stdin.write('first'); await vi.waitFor(() => expect(app.lastFrame()).toContain('first'));
    const hint = `当前没有可用卖家提供 ${config.buyer.selectedModel}。请到“服务市场”选择其他模型，或等待卖家上线后重试。`;
    vi.mocked(requestChatStream).mockRejectedValueOnce(new Error(hint));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '当前没有可用卖家提供' : 'No seller is currently available'));
    expect(app.lastFrame()).not.toContain('助手: ...'); expect(app.lastFrame()).not.toContain('Assistant: ...');
    app.stdin.write('\u001B'); await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '▶ 调用体验' : '▶ Chat'));
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '▶ 服务市场' : '▶ API market'));
    app.stdin.write('\u001B[A'); await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '▶ 调用体验' : '▶ Chat'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '▶ 发送消息' : '▶ Send message'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '输入问题' : 'Type a question'));
    app.stdin.write('second'); await vi.waitFor(() => expect(app.lastFrame()).toContain('second'));
    vi.mocked(requestChatStream).mockResolvedValueOnce({ id: 'success', object: 'chat.completion', created: 0, model: config.buyer.selectedModel, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'okay' } }] });
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain(language === 'zh' ? '助手: okay' : 'Assistant: okay'));
    expect(vi.mocked(requestChatStream).mock.calls[1]?.[0].messages).toEqual([{ role: 'user', content: 'second' }]);
  });

  it('renders all English menus, saves L switching, preserves the frame and never translates model responses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tam-console-language-'));
    const config = getCliDefaults({ homeDir: root, cwd: process.cwd() });
    config.settlement = { ...config.settlement!, escrowPoolAddress: '0x1111111111111111111111111111111111111111', maxRequestCostToken: 0.01, maxUnconfirmedCreditToken: 0.01, dailyLimitToken: 1 };
    setUiLanguage('en');
    const app = render(<ConsoleApp config={config} />);
    Object.defineProperty(app.stdout, 'rows', { value: 32, configurable: true }); app.stdout.emit('resize');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Recent activity'));
    await vi.waitFor(() => expect(frameLines(app.lastFrame())).toHaveLength(31));
    const activityRow = frameLines(app.lastFrame()).findIndex(line => /^\s*│ Recent activity\s*│\s*$/.test(line));
    for (let i = 1; i <= consoleNavItems.length; i++) {
      app.stdin.write('\t');
      await vi.waitFor(() => expect(app.lastFrame()).toContain(`▶ ${translateUiText(consoleNavItems[i % consoleNavItems.length]!.label, 'en')}`));
      expect(frameLines(app.lastFrame())).toHaveLength(31);
      expect(frameLines(app.lastFrame()).findIndex(line => /^\s*│ Recent activity\s*│\s*$/.test(line))).toBe(activityRow);
    }
    app.stdin.write('\t'); app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ Chat'));
    app.stdin.write('l'); await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 调用体验'));
    app.stdin.write('l'); await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ Chat'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ Send message'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain('Type a question'));
    app.stdin.write('hello');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('hello'));
    vi.mocked(requestChatStream).mockResolvedValueOnce({ id: 'language', object: 'chat.completion', created: 0, model: config.buyer.selectedModel,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '余额与充值' } }] });
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain('Assistant: 余额与充值'));
    app.stdin.write('l'); await vi.waitFor(() => expect(app.lastFrame()).toContain('助手: 余额与充值'));
    expect(vi.mocked(requestChatStream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestChatStream).mock.calls[0]?.[0].promptText).toBe('hello');
    expect(frameLines(app.lastFrame())).toHaveLength(31);
    expect(frameLines(app.lastFrame()).findIndex(line => line.includes('最近活动'))).toBe(activityRow);
  });

  it('switches through all ten menus and a long streamed response without moving the bottom panels', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tam-console-layout-'));
    const config = getCliDefaults({ homeDir: root, cwd: process.cwd() });
    config.settlement = { ...config.settlement!, escrowPoolAddress: '0x1111111111111111111111111111111111111111', maxRequestCostToken: 0.01, maxUnconfirmedCreditToken: 0.01, dailyLimitToken: 1 };
    const app = render(<ConsoleApp config={config} />);
    Object.defineProperty(app.stdout, 'rows', { value: 32, configurable: true });
    app.stdout.emit('resize');
    await vi.waitFor(() => expect(frameLines(app.lastFrame())).toHaveLength(31));
    const activityRow = frameLines(app.lastFrame()).findIndex(line => line.includes('最近活动'));
    for (let i = 1; i <= consoleNavItems.length; i++) {
      app.stdin.write('\t');
      await vi.waitFor(() => expect(app.lastFrame()).toContain(`▶ ${consoleNavItems[i % consoleNavItems.length]!.label}`));
      expect(frameLines(app.lastFrame())).toHaveLength(31);
      expect(frameLines(app.lastFrame()).findIndex(line => line.includes('最近活动'))).toBe(activityRow);
    }
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 余额与充值'));
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 调用体验'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 发送消息'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('输入问题'));
    app.stdin.write('hello');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('hello'));
    let finish!: (value: Awaited<ReturnType<typeof requestChatStream>>) => void;
    vi.mocked(requestChatStream).mockImplementationOnce(async (_request, handlers) => {
      handlers?.onDelta?.(Array.from({ length: 80 }, (_, i) => `stream line ${i}`).join('\n'));
      return new Promise(resolve => { finish = resolve; });
    });
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('stream line 79'));
    expect(frameLines(app.lastFrame())).toHaveLength(31);
    expect(frameLines(app.lastFrame()).findIndex(line => line.includes('最近活动'))).toBe(activityRow);
    finish({ id: 'test-stream', object: 'chat.completion', created: 0, model: config.buyer.selectedModel,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: Array.from({ length: 80 }, (_, i) => `stream line ${i}`).join('\n') } }] });
    await vi.waitFor(() => expect(app.lastFrame()).toContain('收到'));
    expect(frameLines(app.lastFrame())).toHaveLength(31);
    app.stdin.write('\u001B[5~');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('PgUp/PgDn 翻页'));
    expect(frameLines(app.lastFrame()).findIndex(line => line.includes('最近活动'))).toBe(activityRow);
  });
});
