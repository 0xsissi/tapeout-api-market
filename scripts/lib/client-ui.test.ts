import { describe, expect, it } from 'vitest';
import { contextMessages, markdown, shouldSend, nearBottom } from '../../apps/client/public/ui-lib.js';
describe('browser chat behavior', () => {
  it('keeps completed turns, excludes uncertain replies and bounds context without splitting a turn', () => {
    const entries = [{ role: 'user', content: '记住青色' }, { role: 'assistant', content: '好', state: 'complete' }, { role: 'user', content: '未完成的问题' }, { role: 'assistant', content: 'partial', state: 'unknown' }];
    expect(contextMessages(entries, '什么颜色？')).toEqual([{ role: 'user', content: '记住青色' }, { role: 'assistant', content: '好' }, { role: 'user', content: '什么颜色？' }]);
    const long = Array.from({ length: 25 }, () => [{ role: 'user', content: 'x'.repeat(3000) }, { role: 'assistant', content: 'y'.repeat(3000), state: 'complete' }]).flat();
    const messages = contextMessages(long, 'next');
    expect(messages[0].role).toBe('user'); expect(messages.at(-1).role).toBe('user'); expect(messages.reduce((n: number, m: any) => n + m.content.length, 0)).toBeLessThanOrEqual(64000);
  });
  it('does not send a paid request while accepting Chinese IME text or inserting a newline', () => {
    expect(shouldSend({ key: 'Enter', isComposing: true }, false)).toBe(false);
    expect(shouldSend({ key: 'Enter', keyCode: 229 }, false)).toBe(false);
    expect(shouldSend({ key: 'Enter' }, true)).toBe(false);
    expect(shouldSend({ key: 'Enter', shiftKey: true }, false)).toBe(false);
    expect(shouldSend({ key: 'Enter' }, false)).toBe(true);
  });
  it('renders model-supplied HTML as text and preserves readable lists and code', () => {
    const output = markdown('# 标题\n\n- 第一项\n- 第二项\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n<script>alert(1)</script>');
    expect(output).toContain('<li>第一项</li>'); expect(output).toContain('&lt;img'); expect(output).toContain('&lt;script&gt;'); expect(output).not.toContain('<img'); expect(output).not.toContain('<script>');
  });
  it('only follows streamed text when the reader is close to the bottom', () => {
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 0, clientHeight: 500 })).toBe(false);
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 1470, clientHeight: 500 })).toBe(true);
  });
});
