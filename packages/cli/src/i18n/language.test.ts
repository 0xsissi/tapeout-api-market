import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectLanguage, extractLanguageOption, getUiLanguage, initializeUiLanguage, languageChoicePath, saveUiLanguage, setUiLanguage, subscribeUiLanguage } from './language.js';

afterEach(() => { vi.unstubAllEnvs(); setUiLanguage('zh'); });
describe('UI language preferences', () => {
  it('detects Chinese variants and defaults other system languages to English', () => {
    expect(detectLanguage({}, 'zh-CN')).toBe('zh');
    expect(detectLanguage({ LC_ALL: 'zh_TW.UTF-8' }, 'en-US')).toBe('zh');
    expect(detectLanguage({ TAM_LANG: 'en', LANG: 'zh_CN' }, 'zh-CN')).toBe('en');
    expect(detectLanguage({}, 'de-DE')).toBe('en');
    expect(detectLanguage({ LANG: 'C.UTF-8' }, 'zh-CN')).toBe('zh');
  });
  it('removes the one-run language option while preserving all command arguments', () => {
    expect(extractLanguageOption(['--payment-token', 'BEM', 'console', '--lang=en'])).toEqual({ language: 'en', args: ['--payment-token', 'BEM', 'console'] });
    expect(extractLanguageOption(['--lang', 'zh', 'buyer', 'status'])).toEqual({ language: 'zh', args: ['buyer', 'status'] });
    for (const args of [['--lang'], ['--lang', 'fr'], ['--lang=en', '--lang=zh']]) expect(() => extractLanguageOption(args)).toThrow();
  });
  it('persists a language independently of wallet and currency, with explicit override priority', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tam-language-'));
    await saveUiLanguage('en', home);
    expect(JSON.parse(await readFile(languageChoicePath(home), 'utf8')).language).toBe('en');
    vi.stubEnv('TAM_LANG', ''); await initializeUiLanguage(undefined, home); expect(getUiLanguage()).toBe('en');
    await initializeUiLanguage('zh', home); expect(getUiLanguage()).toBe('zh');
    expect(JSON.parse(await readFile(languageChoicePath(home), 'utf8')).language).toBe('en');
    vi.stubEnv('TAM_LANG', 'zh'); await initializeUiLanguage(undefined, home); expect(getUiLanguage()).toBe('zh');
    await initializeUiLanguage('en', home); expect(getUiLanguage()).toBe('en');
    await writeFile(languageChoicePath(home), '{broken'); await expect(initializeUiLanguage(undefined, home)).resolves.toBeUndefined();
  });
  it('notifies on actual changes and stops notifying after unsubscribe', () => {
    setUiLanguage('zh'); const listener = vi.fn(); const unsubscribe = subscribeUiLanguage(listener);
    setUiLanguage('en'); setUiLanguage('en'); expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe(); setUiLanguage('zh'); expect(listener).toHaveBeenCalledTimes(1);
  });
});
