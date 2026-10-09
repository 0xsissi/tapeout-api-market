import { onLanguageChange, locale, setText } from './i18n.js';
import { aimmExample, createFlowClock, FLOW_STAGES } from './brief-demo-core.js';

export function initProjectBrief() {
  const root = document.querySelector('#page-about');
  const $ = selector => root.querySelector(selector);
  const $$ = selector => [...root.querySelectorAll(selector)];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const clock = createFlowClock();
  clock.setPlaying(!motion.matches);
  const panel = $('#brief-flow-panel'), packet = $('#brief-flow-packet');
  const steps = $$('[data-brief-step]'), chapters = $$('[data-brief-jump]');
  const pathIds = ['discover', 'request', 'upstream', 'deposit', 'collect'];
  const paths = Object.fromEntries(pathIds.map(id => [id, $(`#flow-${id}`)]));
  const mobileNodes = $$('.bp-mobile-node');
  let flowVisible = false, frame, previousFrame, renderedStep = -1, alpha = 1, scrollFrame;

  function renderProgress(state) {
    steps.forEach((button, index) => button.style.setProperty('--step-progress', index < state.step ? 1 : index === state.step ? state.progress : 0));
    const stage = FLOW_STAGES[state.step], position = state.playing ? state.progress : .5;
    const part = Math.min(stage.routes.length - 1, Math.floor(position * stage.routes.length));
    const route = stage.routes[part], fraction = Math.min(1, position * stage.routes.length - part);
    const path = paths[route.id];
    const point = path.getPointAtLength((route.reverse ? 1 - fraction : fraction) * path.getTotalLength());
    packet.setAttribute('transform', `translate(${point.x} ${point.y})`);
    packet.classList.toggle('is-money', !!stage.money);
  }
  function renderStage(state = clock.state()) {
    renderedStep = state.step;
    const stage = FLOW_STAGES[state.step];
    steps.forEach((button, index) => button.setAttribute('aria-pressed', String(index === state.step)));
    $$('[data-brief-detail]').forEach(article => { article.hidden = Number(article.dataset.briefDetail) !== state.step; });
    for (const [id, path] of Object.entries(paths)) path.classList.toggle('is-active', stage.routes.some(route => route.id === id));
    for (const name of ['buyer', 'seller', 'model', 'pool']) $(`#flow-node-${name}`).classList.toggle('is-active', stage.nodes.includes(name));
    mobileNodes.forEach((node, index) => node.classList.toggle('is-active', stage.nodes.includes(['buyer', 'seller', 'model'][index])));
    renderProgress(state);
  }
  function tick(time) {
    frame = undefined;
    const state = clock.advance(previousFrame === undefined ? 0 : time - previousFrame);
    previousFrame = time;
    if (state.step !== renderedStep) renderStage(state); else renderProgress(state);
    if (state.visible && state.playing) frame = requestAnimationFrame(tick);
  }
  function syncPlayback() {
    const active = !root.hidden && !document.hidden;
    root.dataset.active = String(active);
    const state = clock.setVisible(active && flowVisible && !motion.matches);
    setText($('#brief-play'), motion.matches ? '已关闭动画' : state.playing ? '暂停演示' : '播放演示');
    $('#brief-play').setAttribute('aria-pressed', String(state.playing && !motion.matches));
    $('#brief-play').disabled = motion.matches;
    if (state.playing && state.visible) {
      if (frame === undefined) { previousFrame = undefined; frame = requestAnimationFrame(tick); }
    } else { cancelAnimationFrame(frame); frame = undefined; previousFrame = undefined; }
  }
  steps.forEach(button => button.addEventListener('click', () => { renderStage(clock.select(Number(button.dataset.briefStep))); syncPlayback(); }));
  $('#brief-play').addEventListener('click', () => { clock.setPlaying(!clock.state().playing); syncPlayback(); });
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('hashchange', syncPlayback);
  motion.addEventListener('change', () => { if (motion.matches) clock.setPlaying(false); syncPlayback(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { flowVisible = entries[0].isIntersecting; syncPlayback(); }, { threshold: .15 }).observe(panel);
    const batch = $('.bp-batch-demo');
    new IntersectionObserver(entries => { batch.dataset.batchVisible = String(entries[0].isIntersecting); }).observe(batch);
    if (!motion.matches) {
      root.classList.add('bp-motion-ready');
      const reveal = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-visible'); reveal.unobserve(entry.target); } }, { threshold: .06 });
      $$('[data-reveal]').forEach(node => reveal.observe(node));
    }
  } else { flowVisible = true; syncPlayback(); }

  function renderPricing() {
    const load = Number($('#brief-load').value) / 100;
    const result = aimmExample(load, alpha);
    const ceiling = alpha === 2 ? 25 : 5;
    const point = u => [48 + u / .8 * 406, 212 - (aimmExample(u, alpha).factor - 1) / (ceiling - 1) * 180];
    const points = Array.from({ length: 81 }, (_, index) => point(index / 100));
    $('#brief-price-curve').setAttribute('d', points.map((p, index) => `${index ? 'L' : 'M'}${p.join(' ')}`).join(' '));
    const [x, y] = point(load); $('#brief-price-dot').setAttribute('cx', String(x)); $('#brief-price-dot').setAttribute('cy', String(y));
    $('#brief-price-guide').setAttribute('x1', String(x)); $('#brief-price-guide').setAttribute('x2', String(x));
    $('#brief-load-value').textContent = `${Math.round(load * 100)}%`;
    const format = value => value.toLocaleString(locale(), { maximumFractionDigits: 2 });
    $('#brief-price-value').textContent = `${format(result.price)} USDC`;
    for (const [name, value] of [['top', ceiling], ['middle', 1 + (ceiling - 1) * 2 / 3], ['low', 1 + (ceiling - 1) / 3]]) $(`[data-price-axis="${name}"]`).textContent = `${format(value)}×`;
    $$('[data-brief-alpha]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.briefAlpha) === alpha)));
  }
  $('#brief-load').addEventListener('input', renderPricing);
  $$('[data-brief-alpha]').forEach(button => button.addEventListener('click', () => { alpha = Number(button.dataset.briefAlpha); renderPricing(); }));
  chapters.forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.briefJump).scrollIntoView({ block: 'start', behavior: motion.matches ? 'instant' : 'smooth' })));
  const sections = ['brief-problem', 'brief-how', 'brief-tech', 'brief-business', 'brief-progress'].map(id => document.getElementById(id));
  function updateReading() {
    scrollFrame = undefined;
    if (root.hidden) return;
    const rect = root.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, -rect.top / Math.max(1, rect.height - innerHeight)));
    root.style.setProperty('--bp-reading-progress', String(progress));
    const edge = (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 65) + $('.bp-index').offsetHeight + 25;
    const current = sections.filter(section => section.getBoundingClientRect().top <= edge).at(-1);
    chapters.forEach(button => { const selected = button.dataset.briefJump === current?.id; button.classList.toggle('is-current', selected); if (selected) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current'); });
  }
  const scheduleReading = () => { if (scrollFrame === undefined && !root.hidden) scrollFrame = requestAnimationFrame(updateReading); };
  window.addEventListener('scroll', scheduleReading, { passive: true });
  window.addEventListener('resize', scheduleReading);
  window.addEventListener('hashchange', scheduleReading);
  onLanguageChange(() => { renderPricing(); syncPlayback(); scheduleReading(); });
  renderStage(); renderPricing(); syncPlayback(); scheduleReading();
}
