export function contextMessages(entries, prompt) {
  const turns = [];
  for (let i = 0; i + 1 < entries.length; i++) {
    if (entries[i].role === 'user' && entries[i + 1].role === 'assistant' && entries[i + 1].state === 'complete') { turns.push({ role: 'user', content: entries[i].content }, { role: 'assistant', content: entries[i + 1].content }); i++; }
  }
  const recent = turns.slice(-38);
  while (recent.length && recent.reduce((n, m) => n + m.content.length, prompt.length) > 64000) recent.splice(0, 2);
  return [...recent, { role: 'user', content: prompt }];
}
export function escapeHtml(text) { return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function inline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
export function markdown(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'); let html = '', paragraph = [], list = '', code = null, language = '';
  const flush = () => { if (paragraph.length) { html += '<p>' + inline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>'; paragraph = []; } if (list) { html += `</${list}>`; list = ''; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code !== null) { html += '<div class="code-block"><div class="code-header"><span>' + escapeHtml(language || '代码') + '</span><button class="copy-code">复制代码</button></div><pre><code>' + escapeHtml(code.join('\n')) + '</code></pre></div>'; code = null; }
      else { flush(); language = line.trim().slice(3).trim(); code = []; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const heading = line.match(/^#{1,4}\s+(.+)$/); const item = line.match(/^\s*(?:[-*]\s+|\d+[.)]\s+)(.+)$/);
    if (heading) { flush(); html += '<h3>' + inline(heading[1]) + '</h3>'; }
    else if (item) { if (paragraph.length) { html += '<p>' + inline(paragraph.join('\n')) + '</p>'; paragraph = []; } const type = /^\s*\d/.test(line) ? 'ol' : 'ul'; if (list !== type) { if (list) html += `</${list}>`; html += `<${type}>`; list = type; } html += '<li>' + inline(item[1]) + '</li>'; }
    else if (!line.trim()) flush();
    else { if (list) { html += `</${list}>`; list = ''; } paragraph.push(line); }
  }
  if (code !== null) html += '<div class="code-block"><pre><code>' + escapeHtml(code.join('\n')) + '</code></pre></div>';
  flush(); return html;
}
export function shouldSend(event, composing) { return event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229; }
export function nearBottom(element) { return element.scrollHeight - element.scrollTop - element.clientHeight < 80; }
