import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type UiLanguage = 'zh' | 'en';
const listeners = new Set<() => void>();
export function detectLanguage(env: NodeJS.ProcessEnv = process.env, locale = Intl.DateTimeFormat().resolvedOptions().locale): UiLanguage {
  const configured = env.TAM_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG;
  const value = !configured || /^(?:C|POSIX)(?:[.@]|$)/i.test(configured) ? locale : configured;
  return /^zh(?:[-_]|$)/i.test(value) ? 'zh' : 'en';
}
let language = detectLanguage();
export const getUiLanguage = () => language;
export const getUiLocale = () => language === 'zh' ? 'zh-CN' : 'en-US';
export function subscribeUiLanguage(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function languageChoicePath(home = process.env.TAM_HOME ?? process.env.HOME ?? homedir()) { return path.join(home, '.clawmarket', 'language.json'); }
export function setUiLanguage(value: UiLanguage) {
  if (value !== 'zh' && value !== 'en') throw new Error('Language must be zh or en.');
  if (language === value) return;
  language = value; for (const listener of listeners) listener();
}
export async function saveUiLanguage(value: UiLanguage, home?: string) {
  if (value !== 'zh' && value !== 'en') throw new Error('Language must be zh or en.');
  const file = languageChoicePath(home), temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, JSON.stringify({ language: value, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await rename(temporary, file); setUiLanguage(value);
}
export async function initializeUiLanguage(override?: UiLanguage, home?: string) {
  let saved: UiLanguage | undefined;
  try { const value = JSON.parse(await readFile(languageChoicePath(home), 'utf8')).language; if (value === 'zh' || value === 'en') saved = value; }
  catch { /* A damaged preference must not block access to the wallet. */ }
  setUiLanguage(override ?? (process.env.TAM_LANG ? detectLanguage() : saved ?? detectLanguage()));
}
export function extractLanguageOption(args: string[]): { language?: UiLanguage; args: string[] } {
  let selected: UiLanguage | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--lang' || argument.startsWith('--lang=')) {
      if (selected) throw new Error('--lang may only be set once.');
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++index];
      if (value !== 'zh' && value !== 'en') throw new Error('--lang must be zh or en.');
      selected = value;
    } else remaining.push(argument);
  }
  return { language: selected, args: remaining };
}
