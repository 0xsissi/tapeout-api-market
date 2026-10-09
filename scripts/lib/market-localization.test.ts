import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import dictionary from '../../packages/shared/src/locales/en.json' with { type: 'json' };
import { createUiTranslator } from '../../packages/shared/src/ui-translation.js';
import { detectLanguage } from '../../apps/marketplace/public/i18n.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ts = createRequire(path.join(root, 'packages/cli/package.json'))('typescript');
const t = createUiTranslator(dictionary);
describe('website and terminal translation coverage', () => {
  it('honors shared-link language, saved choice and browser language in that order', () => {
    expect(detectLanguage({ query: 'en', saved: 'zh', languages: ['zh-CN'] })).toBe('en');
    expect(detectLanguage({ query: null, saved: 'zh', languages: ['en-US'] })).toBe('zh');
    expect(detectLanguage({ languages: ['zh-TW', 'en'] })).toBe('zh');
    expect(detectLanguage({ query: 'fr', saved: 'bad', languages: ['fr'] })).toBe('en');
  });
  it('ships the exact shared dictionary and browser translation core', async () => {
    expect(JSON.parse(fs.readFileSync(path.join(root, 'apps/marketplace/public/locales/en.json'), 'utf8'))).toEqual(dictionary);
    const browser = await import('../../apps/marketplace/public/i18n-core.js');
    expect(browser.createUiTranslator(dictionary)('余额与充值', 'en')).toBe(t('余额与充值', 'en'));
  });
  it('translates static HTML, accessible labels and dynamic browser UI strings', () => {
    const html = fs.readFileSync(path.join(root, 'apps/marketplace/public/index.html'), 'utf8');
    const texts = [...html.matchAll(/>([^<>]+)</g)].map(m => m[1].replace(/\s+/g, ' ').trim());
    texts.push(...[...html.matchAll(/(?:placeholder|aria-label|content)="([^"]+)"/g)].map(m => m[1]));
    for (const text of texts.filter(text => /[\u3400-\u9fff]/.test(text) && !['中', '中文', 'Language / 界面语言'].includes(text))) expect(t(text, 'en'), text).not.toMatch(/[\u3400-\u9fff]/);
    function visit(node: any) {
      let text = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((s: any, i: number) => `{${i}}${s.literal.text}`).join('') : '';
      if (/[\u3400-\u9fff]/.test(text)) expect(t(text, 'en'), text).not.toMatch(/[\u3400-\u9fff]/);
      ts.forEachChild(node, visit);
    }
    for (const file of ['app.js', 'project-brief.js']) {
      const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, 'apps/marketplace/public', file), 'utf8'), ts.ScriptTarget.Latest, true);
      visit(source);
    }
  });
  it('provides matching English AI commands and preserves signed messages', () => {
    const guide = fs.readFileSync(path.join(root, 'apps/marketplace/public/skill.en.md'), 'utf8');
    expect(guide).toContain('BSC Testnet, chain 97 only'); expect(guide).toContain('TAM --lang en console');
    expect(guide).toContain('TAM --payment-token USDC join apply');
    const app = fs.readFileSync(path.join(root, 'apps/marketplace/public/app.js'), 'utf8');
    expect(app).toContain('new TextEncoder().encode(challenge.message)');
    expect(app).toContain("params: [hex, address]");
  });
});
