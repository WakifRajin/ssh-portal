// Small UI toolkit: icons, toasts, dialogs, context menus, formatting.

const P = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  code: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  media: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  forward: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  folderPlus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  filePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  star: '<path d="M12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3Z"/>',
  play: '<path d="m6 3 14 9-14 9Z"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  window: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M2 9h20"/><path d="M6 6.5h.01"/><path d="M9 6.5h.01"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  splitV: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  splitH: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/>',
  broadcast: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  chevUp: '<path d="m18 15-6-6-6 6"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/><path d="M9 15.5a3 3 0 0 0 2.5 2.4" />',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.file}</svg>`;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function formatBytes(n) {
  if (n == null || isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const formatDate = (unix) => (unix ? dtf.format(new Date(unix * 1000)) : '');

export function formatDuration(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hh}h ${m}m` : hh ? `${hh}h ${m}m` : `${m}m`;
}

// ------------------------------------------------------------------ toasts ---
export function toast(message, type = 'info', ms = 4000) {
  const box = $('#toasts');
  const el = h(`<div class="toast toast-${type}" role="status">${icon({ error: 'x', success: 'check' }[type] || 'info')}<span>${esc(message)}</span></div>`);
  box.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
  return el;
}

// ----------------------------------------------------------------- dialogs ---
// Generic modal built on <dialog>. `body` is an HTML string or element; buttons
// are [{label, value, primary, danger}]. Resolves with the clicked value (or
// null on Esc) and the form's data.
export function modal({ title, body = '', buttons = [{ label: 'OK', value: true, primary: true }], wide = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const dlg = h(`<dialog class="modal${wide ? ' wide' : ''}" aria-labelledby="dlg-title">
      <form method="dialog">
        <header><h2 id="dlg-title">${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
        <div class="modal-body"></div>
        <footer></footer>
      </form>
    </dialog>`);
    const bodyEl = $('.modal-body', dlg);
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else bodyEl.append(body);
    const foot = $('footer', dlg);
    const form = $('form', dlg);
    let done = false;
    // Settle directly from the button handlers; the 'close' event (Esc, light
    // dismiss) is only a fallback since browsers may defer it.
    const finish = (value) => {
      if (done) return;
      done = true;
      const data = Object.fromEntries(new FormData(form));
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve({ value, data });
    };
    for (const b of buttons) {
      const btn = h(`<button type="${b.primary ? 'submit' : 'button'}" class="btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}">${esc(b.label)}</button>`);
      if (!b.primary) btn.addEventListener('click', () => finish(b.value));
      foot.append(btn);
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const primary = buttons.find((b) => b.primary);
      finish(primary ? primary.value : true);
    });
    $('[data-close]', dlg).addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    dlg.addEventListener('close', () => finish(null));
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg);
    const focusEl = $('[autofocus]', dlg) || $('input, textarea, select', bodyEl);
    focusEl?.focus();
    if (focusEl?.select && focusEl.dataset.selectBase !== undefined) {
      const v = focusEl.value;
      const dot = v.lastIndexOf('.');
      focusEl.setSelectionRange(0, dot > 0 ? dot : v.length);
    } else focusEl?.select?.();
  });
}

export async function confirmBox(title, message, { okLabel = 'OK', danger = false } = {}) {
  const r = await modal({
    title,
    body: `<p>${esc(message)}</p>`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: okLabel, value: true, primary: true, danger },
    ],
  });
  return r.value === true;
}

export async function promptBox(title, label, value = '', { okLabel = 'OK', selectBase = false, type = 'text' } = {}) {
  const r = await modal({
    title,
    body: `<label class="field"><span>${esc(label)}</span><input name="v" type="${type}" value="${esc(value)}" required ${selectBase ? 'data-select-base' : ''} autocomplete="off" spellcheck="false"></label>`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: okLabel, value: true, primary: true },
    ],
  });
  return r.value === true ? r.data.v : null;
}

// ------------------------------------------------------------ context menu ---
// Positioned at the pointer; uses the Popover API for top-layer + light dismiss.
let menuEl = null;
export function contextMenu(x, y, items) {
  if (!menuEl) {
    menuEl = h('<div class="ctxmenu" popover="auto" role="group"></div>');
    document.body.append(menuEl);
  }
  menuEl.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menuEl.append(h('<hr>'));
      continue;
    }
    const b = h(`<button type="button" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${icon(it.icon || 'file')}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</button>`);
    b.addEventListener('click', () => {
      menuEl.hidePopover();
      it.action();
    });
    menuEl.append(b);
  }
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  menuEl.showPopover();
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  menuEl.querySelector('button:not([disabled])')?.focus();
}

menuKeyNav();
function menuKeyNav() {
  document.addEventListener('keydown', (e) => {
    if (!menuEl?.matches(':popover-open')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = $$('button:not([disabled])', menuEl);
    const i = btns.indexOf(document.activeElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
  });
}

// --------------------------------------------------------------- file types ---
const EXT = {
  image: 'png jpg jpeg gif webp svg bmp ico avif',
  code: 'js mjs cjs ts tsx jsx json py rb go rs c h cpp hpp cc java kt swift php sh bash zsh fish ps1 lua pl r sql html htm css scss less vue svelte xml yaml yml toml ini conf cfg md txt log csv env dockerfile makefile cmake gradle properties service desktop gitignore rst tex',
  archive: 'zip tar gz tgz bz2 xz 7z rar zst deb rpm iso',
  media: 'mp3 wav flac ogg m4a mp4 mkv webm avi mov',
};
const extMap = {};
for (const [k, v] of Object.entries(EXT)) for (const e of v.split(' ')) extMap[e] = k;

export function fileKind(entry) {
  if (entry.type === 'dir') return 'folder';
  const name = entry.name.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : name;
  return extMap[ext] || (name.startsWith('.') ? 'code' : 'file');
}
export function isTextLike(name) {
  const n = name.toLowerCase();
  const ext = n.includes('.') ? n.split('.').pop() : n;
  return extMap[ext] === 'code' || !n.includes('.') || n.startsWith('.');
}

export const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`);
export const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1) || '/';
