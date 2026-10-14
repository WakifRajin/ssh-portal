// Small shared helpers for the server-management panels (Services, Logs,
// Docker, Devices): ids, segmented controls, copyable commands, empty states.

import { esc, icon, toast } from './ui.js';

let seq = 0;
// Radio groups are document-wide, so every instance needs its own name.
export const uid = (prefix = 'u') => `${prefix}${++seq}`;

export const segHtml = (name, options, value, label = '') =>
  `<div class="segmented" role="radiogroup" aria-label="${esc(label)}">${options
    .map(([v, l]) => `<label><input type="radio" name="${esc(name)}" value="${esc(v)}" ${String(v) === String(value) ? 'checked' : ''}><span>${esc(l)}</span></label>`)
    .join('')}</div>`;

// A command the user can copy and paste into a terminal.
export const cmdBlock = (text) =>
  `<div class="cmd-block"><code>${esc(text)}</code><button type="button" class="icon-btn sm" data-copy="${esc(text)}" title="Copy" aria-label="Copy command">${icon('copy')}</button></div>`;

// Delegated handler for [data-copy] buttons inside root.
export function bindCopy(root) {
  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    navigator.clipboard.writeText(c.dataset.copy).then(
      () => toast('Copied', 'success', 1500),
      () => toast("Couldn't copy. Select the text and copy it by hand.", 'error'),
    );
  });
}

// title/body/actions are trusted HTML: callers must esc() remote strings.
export const emptyState = ({ icon: ic = 'info', title, body = '', actions = '', kind = '' }) =>
  `<div class="card empty-state" ${kind ? `data-kind="${kind}"` : ''}><span class="es-ic">${icon(ic)}</span><h3>${title}</h3>${body ? `<div class="es-body">${body}</div>` : ''}${actions ? `<div class="es-actions">${actions}</div>` : ''}</div>`;

export const loadingHtml = (text = 'Loading…') => `<p class="loading muted"><span class="spinner"></span> ${esc(text)}</p>`;

// "less than a minute", "5 minutes", "3 hours", "3 days"
export function humanDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const plural = (n, u) => `${n} ${u}${n === 1 ? '' : 's'}`;
  if (sec < 60) return 'less than a minute';
  if (sec < 3600) return plural(Math.floor(sec / 60), 'minute');
  if (sec < 86400) return plural(Math.floor(sec / 3600), 'hour');
  return plural(Math.floor(sec / 86400), 'day');
}

export const debounce = (fn, ms = 200) => {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const clock = (d = new Date()) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
