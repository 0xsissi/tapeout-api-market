import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function readingFixture() {
  vi.resetModules();
  let scroll = 1200;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const classes = new Set<string>();
  const root = { lang: 'zh-CN', classList: { add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value) } };
  const heading = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: (root.lang === 'en-US' ? 1600 : 1400) - scroll, bottom: (root.lang === 'en-US' ? 1600 : 1400) - scroll + 60, height: 60 }),
  };
  const page = { hidden: false, querySelectorAll: (selector: string) => selector.startsWith('h1, h2, h3, p, li') ? [heading] : [] };
  const document = {
    documentElement: root,
    querySelector: (selector: string) => selector === '.topbar' ? { getBoundingClientRect: () => ({ bottom: 65 }) } : page,
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => false }),
  };
  const scrollTo = vi.fn(({ top }: { top: number }) => { scroll = top; vi.stubGlobal('scrollY', scroll); });
  const saved = vi.fn();
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { scrollTo });
  vi.stubGlobal('scrollY', scroll); vi.stubGlobal('scrollX', 0); vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
  vi.stubGlobal('location', { href: 'https://shenjige.xyz/?lang=zh#about' });
  vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
  vi.stubGlobal('localStorage', { setItem: saved });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const language = await import('../../apps/marketplace/public/i18n.js');
  return { ...language, page, heading, scrollTo, saved, classes, flush() { while (frames.size) { const pending = [...frames]; frames.clear(); pending.forEach(([, callback]) => callback(0)); } } };
}

describe('language switching while reading', () => {
  it('keeps the visible heading at the same screen position when translated content above it grows', async () => {
    const fixture = await readingFixture();
    const before = fixture.heading.getBoundingClientRect().top;
    fixture.setLanguage('en'); fixture.flush();
    expect(fixture.heading.getBoundingClientRect().top).toBe(before);
    expect(fixture.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1400, behavior: 'instant' });
    fixture.setLanguage('zh'); fixture.flush();
    expect(fixture.heading.getBoundingClientRect().top).toBe(before);
    expect(fixture.classes.has('is-localizing')).toBe(false);
  });

  it('keeps the saved scroll offset if a dynamic render removes the reading anchor', async () => {
    const fixture = await readingFixture();
    fixture.onLanguageChange(() => { fixture.heading.isConnected = false; });
    fixture.setLanguage('en'); fixture.flush();
    expect(fixture.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1200, behavior: 'instant' });
  });

  it('saves an explicit choice of the active language without rebuilding or scrolling', async () => {
    const fixture = await readingFixture();
    fixture.setLanguage('zh'); fixture.flush();
    expect(fixture.saved).toHaveBeenCalledWith('tam-language-v1', 'zh');
    expect(fixture.scrollTo).not.toHaveBeenCalled();
  });

  it('does not restore an old reading position after the user moves to another page', async () => {
    const fixture = await readingFixture();
    fixture.setLanguage('en');
    fixture.page.hidden = true;
    fixture.scrollTo({ top: 0 });
    fixture.flush();
    expect(fixture.scrollTo).toHaveBeenLastCalledWith({ top: 0 });
  });
});
