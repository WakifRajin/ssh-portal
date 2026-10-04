// Command palette (Ctrl+K / Ctrl+Shift+P): fuzzy-search every action.

import { h, $, icon, esc } from './ui.js';

// subsequence match; rewards consecutive hits and word starts
function score(q, text) {
  if (!q) return 1;
  const t = text.toLowerCase();
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q.toLowerCase()) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    run = i === ti ? run + 1 : 0;
    s += 1 + run * 2 + (i === 0 || /[\s/:._-]/.test(t[i - 1]) ? 3 : 0);
    ti = i + 1;
  }
  return s - t.length * 0.01;
}

export function openPalette(getCommands, placeholder = 'Type a command or search…') {
  const dlg = h(`<dialog class="palette" aria-label="Command palette" closedby="any">
    <div class="pal-input">${icon('search')}<input type="text" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="pal-list"><kbd>Esc</kbd></div>
    <ul class="pal-list" id="pal-list" role="listbox"></ul>
  </dialog>`);
  const input = $('input', dlg);
  const list = $('ul', dlg);
  const commands = getCommands().filter((c) => !c.when || c.when());
  let shown = [];
  let idx = 0;

  function render() {
    const q = input.value.trim();
    shown = commands
      .map((c) => ({ c, s: score(q, `${c.group || ''} ${c.title}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.c);
    if (!q) shown = commands.slice(0, 60);
    idx = Math.min(idx, Math.max(0, shown.length - 1));
    let lastGroup = null;
    list.innerHTML = shown.length
      ? shown
          .map((c, i) => {
            const head = !q && c.group !== lastGroup ? `<li class="pal-group" role="presentation">${esc(c.group || '')}</li>` : '';
            lastGroup = c.group;
            return `${head}<li role="option" id="pal-${i}" data-i="${i}" class="${i === idx ? 'active' : ''}" aria-selected="${i === idx}">
              ${icon(c.icon || 'chevRight')}<span class="pal-title">${esc(c.title)}</span>${c.hint ? `<kbd>${esc(c.hint)}</kbd>` : ''}</li>`;
          })
          .join('')
      : '<li class="pal-empty">No matching commands</li>';
    input.setAttribute('aria-activedescendant', `pal-${idx}`);
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function run(i) {
    const c = shown[i];
    if (!c) return;
    dlg.close();
    dlg.remove();
    setTimeout(() => c.run(), 0);
  }

  input.addEventListener('input', () => {
    idx = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') idx = (idx + 1) % Math.max(1, shown.length);
    else if (e.key === 'ArrowUp') idx = (idx - 1 + shown.length) % Math.max(1, shown.length);
    else if (e.key === 'Enter') return run(idx);
    else return;
    e.preventDefault();
    render();
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) run(+li.dataset.i);
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && +li.dataset.i !== idx) {
      idx = +li.dataset.i;
      for (const n of list.querySelectorAll('[data-i]')) n.classList.toggle('active', +n.dataset.i === idx);
    }
  });
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  render();
  input.focus();
}
