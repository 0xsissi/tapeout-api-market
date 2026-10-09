import { createUiTranslator } from './i18n-core.js';

const storageKey = 'tam-language-v1';
let language = 'zh', translate = text => text;
const originals = new WeakMap(), attributes = new WeakMap(), listeners = new Set();
const layoutMinimums = new WeakMap();
let viewportFrame;
const stableBlocks = '.bp-lead, .bp-section-title, .bp-card, .bp-scenario, .bp-flow-detail, .bp-pricing-copy, .bp-demo-controls, .bp-business-copy, .bp-cta, h1, .subtitle, .hero-description, .start-step, .brief-lead, .brief-section-title, .brief-problems > article, .brief-tech-grid > article, .brief-value-grid > article, .brief-status-grid > article, .brief-step-copy, .brief-architecture-note, .brief-node, .brief-pricing, .brief-cta, .brief-cta h2, .guide-card, .token-card, .node-card, .steps > div, .code-panel pre';
export const getLanguage = () => language;
export const locale = () => language === 'zh' ? 'zh-CN' : 'en-US';
export const t = text => translate(String(text), language);
export function detectLanguage({ query, saved, languages = [] }) {
  if (query === 'en' || query === 'zh') return query;
  if (saved === 'en' || saved === 'zh') return saved;
  return /^zh(?:[-_]|$)/i.test(languages[0] || 'en') ? 'zh' : 'en';
}
function excluded(node) { return node.parentElement?.closest('script, style, [data-i18n-raw]'); }
export function textNode(source) {
  const node = document.createTextNode(t(source)); originals.set(node, String(source)); return node;
}
export function setText(element, source) { element.replaceChildren(textNode(source)); }
function renderDocument() {
  document.documentElement.lang = locale();
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (excluded(node)) continue;
    if (!originals.has(node)) originals.set(node, node.nodeValue);
    node.nodeValue = t(originals.get(node));
  }
  for (const element of document.querySelectorAll('[placeholder], [aria-label], meta[name="description"]')) {
    if (element.closest('[data-i18n-raw]')) continue;
    if (!attributes.has(element)) attributes.set(element, Object.fromEntries(['placeholder', 'aria-label', 'content'].filter(key => element.hasAttribute(key)).map(key => [key, element.getAttribute(key)])));
    for (const [key, source] of Object.entries(attributes.get(element))) element.setAttribute(key, t(source));
  }
  for (const link of document.querySelectorAll('a[href="/skill.md"], a[href="/skill.en.md"]')) link.setAttribute('href', language === 'en' ? '/skill.en.md' : '/skill.md');
  for (const button of document.querySelectorAll('[data-language]')) {
    const selected = button.dataset.language === language;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}
export function onLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function readingPosition() {
  const page = document.querySelector('.page:not([hidden])');
  const edge = Math.max(0, document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 12;
  const candidates = page?.querySelectorAll('h1, h2, h3, p, li, .table-wrap, .brief-step-copy, .code-panel') ?? [];
  const element = [...candidates].find(node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > edge && rect.top < innerHeight; });
  return { page, element, top: element?.getBoundingClientRect().top, x: scrollX, y: scrollY };
}
function restoreReadingPosition(position) {
  if (position.page?.hidden) return;
  const y = position.element?.isConnected ? scrollY + position.element.getBoundingClientRect().top - position.top : position.y;
  window.scrollTo({ left: position.x, top: y, behavior: 'instant' });
}
/** Reserve the larger natural layout of both languages, without changing the live page. */
export function stabilizeLocalizedLayout() {
  const page = document.querySelector('.page:not([hidden])');
  if (!page) return;
  const blocks = [...page.querySelectorAll(stableBlocks)].filter(node => node.getClientRects().length);
  for (const node of blocks) {
    if (!layoutMinimums.has(node)) layoutMinimums.set(node, node.style.minHeight);
    node.style.minHeight = layoutMinimums.get(node);
  }
  for (const node of blocks) {
    const width = node.getBoundingClientRect().width;
    const floor = parseFloat(getComputedStyle(node).minHeight) || 0;
    let height = floor;
    for (const target of ['zh', 'en']) {
      const probe = node.cloneNode(true);
      probe.classList.add('i18n-size-probe'); probe.setAttribute('aria-hidden', 'true'); probe.inert = true;
      probe.style.setProperty('width', `${width}px`, 'important');
      const targetFont = getComputedStyle(document.documentElement).getPropertyValue(target === 'en' ? '--font-ui-en' : '--font-ui-zh');
      if (targetFont.trim()) probe.style.setProperty('font-family', targetFont, 'important');
      const sourceWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), probeWalker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
      while (sourceWalker.nextNode() && probeWalker.nextNode()) {
        const source = sourceWalker.currentNode;
        if (!excluded(source)) probeWalker.currentNode.nodeValue = translate(originals.get(source) ?? source.nodeValue, target);
      }
      probe.removeAttribute('id'); probe.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
      node.parentElement.append(probe);
      const steps = [...probe.querySelectorAll('[data-brief-detail]')];
      if (steps.length) {
        for (const step of steps) {
          steps.forEach(article => { article.hidden = article !== step; });
          height = Math.max(height, probe.getBoundingClientRect().height);
        }
      } else height = Math.max(height, probe.getBoundingClientRect().height);
      probe.remove();
    }
    node.style.minHeight = `${Math.ceil(height)}px`;
  }
}
export function setLanguage(value, persist = true) {
  if (value !== 'zh' && value !== 'en') return;
  if (persist && value === language) {
    try { localStorage.setItem(storageKey, value); } catch { /* Optional browser storage. */ }
    const url = new URL(location.href); url.searchParams.set('lang', value); history.replaceState(history.state, '', url);
    return;
  }
  const position = persist ? readingPosition() : null;
  cancelAnimationFrame(viewportFrame);
  if (position) document.documentElement.classList.add('is-localizing');
  language = value;
  if (persist) {
    try { localStorage.setItem(storageKey, language); } catch { /* Optional browser storage. */ }
    // An explicit choice supersedes a shared-link query without changing the current page.
    const url = new URL(location.href); url.searchParams.set('lang', value); history.replaceState(history.state, '', url);
  }
  renderDocument(); for (const listener of listeners) listener();
  stabilizeLocalizedLayout();
  if (position) {
    restoreReadingPosition(position);
    viewportFrame = requestAnimationFrame(() => {
      restoreReadingPosition(position);
      viewportFrame = requestAnimationFrame(() => document.documentElement.classList.remove('is-localizing'));
    });
  }
}
export async function initI18n() {
  try {
    const response = await fetch('/locales/en.json', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Could not load interface translations.');
    translate = createUiTranslator(await response.json());
  } catch {
    // Keep the market usable in its source language if translation delivery fails.
    setLanguage('zh', false);
    for (const button of document.querySelectorAll('[data-language]')) {
      button.disabled = true;
      button.title = 'Language file unavailable. Reload to retry. / 请刷新重试。';
    }
    console.warn('Language file unavailable; using Chinese. Reload to retry.');
    return;
  }
  let saved; try { saved = localStorage.getItem(storageKey); } catch { /* Optional browser storage. */ }
  setLanguage(detectLanguage({ query: new URL(location.href).searchParams.get('lang'), saved, languages: navigator.languages }), false);
  for (const button of document.querySelectorAll('[data-language]')) button.addEventListener('click', () => setLanguage(button.dataset.language));
  let resizeFrame;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { const position = readingPosition(); stabilizeLocalizedLayout(); restoreReadingPosition(position); });
  });
}
