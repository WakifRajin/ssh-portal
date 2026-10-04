// Terminator-style terminals: every workspace tab holds a tree of split panes.
// All panes share the one SSH login (the bridge multiplexes channels), so
// splitting or opening tabs never asks for credentials again.

import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/+esm';
import { SearchAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-search@0.16.0/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.12.0/+esm';
import { h, $, $$, icon, esc, toast, contextMenu, modal, formatBytes } from './ui.js';
import { getPrefs } from './prefs.js';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ------------------------------------------------------------------ themes ---
const TANGO = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
const KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const pal = (arr) => Object.fromEntries(KEYS.map((k, i) => [k, arr[i]]));

export const THEMES = {
  portal: {
    name: 'Portal',
    background: '#0c0e13', foreground: '#dfe3ea', cursor: '#8aa2ff', cursorAccent: '#0c0e13', selectionBackground: '#33416b',
    ...pal(['#1d2129', '#ff6b6b', '#7ee787', '#f2cc60', '#79b8ff', '#d2a8ff', '#76e3ea', '#dfe3ea', '#5c6370', '#ff8f8f', '#a5f3a9', '#ffdf85', '#a6d1ff', '#e2c5ff', '#a3f0f5', '#ffffff']),
  },
  terminator: {
    name: 'Terminator',
    background: '#000000', foreground: '#ffffff', cursor: '#aaaaaa', cursorAccent: '#000000', selectionBackground: '#3a3a3a',
    ...pal(TANGO),
  },
  ubuntu: {
    name: 'Ubuntu',
    background: '#300a24', foreground: '#eeeeec', cursor: '#eeeeec', cursorAccent: '#300a24', selectionBackground: '#5c2a4f',
    ...pal(TANGO),
  },
  dracula: {
    name: 'Dracula',
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
    ...pal(['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  },
  solarized: {
    name: 'Solarized Dark',
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#0f4a5a',
    ...pal(['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#93a1a1', '#839496', '#657b83', '#6c71c4', '#93a1a1', '#fdf6e3']),
  },
  nord: {
    name: 'Nord',
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
    ...pal(['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  },
  light: {
    name: 'Paper (light)',
    background: '#fbfbfa', foreground: '#24292f', cursor: '#24292f', cursorAccent: '#fbfbfa', selectionBackground: '#cfe0ff',
    ...pal(['#24292f', '#cf222e', '#116329', '#7d5c00', '#0550ae', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#9a6700', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
  },
};

const FONTS = ['JetBrains Mono', 'Fira Code', 'Ubuntu Mono', 'Source Code Pro', 'Cascadia Mono', 'Consolas', 'monospace'];
const DEFAULTS = { theme: 'portal', fontSize: 14, fontFamily: 'JetBrains Mono', lineHeight: 1.15, cursorStyle: 'block', cursorBlink: true, scrollback: 10000, copyOnSelect: true, middlePaste: true, titlebars: true };

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sshportal.term') || '{}') };
const allPanes = new Set();
const layouts = new Set();
let broadcast = 'off'; // 'off' | 'tab' | 'all'
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const terminalSettings = () => ({ ...settings });
export const getBroadcast = () => broadcast;
export function onTerminalStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setBroadcast(mode) {
  broadcast = mode;
  for (const l of layouts) l.refreshBadges();
  notify();
  if (mode !== 'off') toast(mode === 'all' ? 'Broadcasting keystrokes to every terminal' : 'Broadcasting keystrokes to all panes in this tab');
}

function fontStack(f) {
  return `"${f}", "JetBrains Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace`;
}

// The app's liquid-glass theme makes the default (Portal) scheme translucent.
function effectiveTheme() {
  const t = THEMES[settings.theme] || THEMES.portal;
  if (document.documentElement.dataset.theme !== 'glass' || settings.theme !== 'portal') return t;
  return { ...t, background: 'rgba(10, 12, 26, 0.55)', cursorAccent: '#0a0c1a', selectionBackground: 'rgba(154, 176, 255, 0.35)' };
}

export function refreshTerminalAppearance() {
  for (const p of allPanes) p.applySettings();
}

export function applyTerminalSettings(patch) {
  Object.assign(settings, patch);
  localStorage.setItem('sshportal.term', JSON.stringify(settings));
  for (const p of allPanes) p.applySettings();
  for (const l of layouts) l.el.classList.toggle('no-titlebars', !settings.titlebars);
  notify();
}

export async function openTerminalSettings() {
  const themeCards = Object.entries(THEMES)
    .map(
      ([k, t]) => `<label class="theme-card"><input type="radio" name="theme" value="${k}" ${settings.theme === k ? 'checked' : ''}>
        <span class="theme-prev" style="background:${t.background};color:${t.foreground}"><span style="color:${t.green}">user@host</span>:<span style="color:${t.blue}">~</span>$ ls<br><span style="color:${t.blue}">src</span> <span style="color:${t.green}">run.sh</span> <span style="color:${t.red}">old</span></span>
        <span class="theme-name">${esc(t.name)}</span></label>`,
    )
    .join('');
  const body = h(`<div class="term-settings">
    <div class="theme-grid" role="radiogroup" aria-label="Color scheme">${themeCards}</div>
    <div class="grid-2">
      <label class="field"><span>Font</span><select name="fontFamily">${FONTS.map((f) => `<option ${settings.fontFamily === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label class="field"><span>Font size <output>${settings.fontSize}</output>px</span><input type="range" name="fontSize" min="9" max="28" value="${settings.fontSize}"></label>
      <label class="field"><span>Cursor</span><select name="cursorStyle">${['block', 'bar', 'underline'].map((c) => `<option ${settings.cursorStyle === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field"><span>Scrollback lines</span><input type="number" name="scrollback" min="500" max="200000" step="500" value="${settings.scrollback}"></label>
    </div>
    <div class="toggles">
      <label class="switch"><input type="checkbox" name="cursorBlink" ${settings.cursorBlink ? 'checked' : ''}><span></span>Blinking cursor</label>
      <label class="switch"><input type="checkbox" name="copyOnSelect" ${settings.copyOnSelect ? 'checked' : ''}><span></span>Copy on select</label>
      <label class="switch"><input type="checkbox" name="middlePaste" ${settings.middlePaste ? 'checked' : ''}><span></span>Middle-click paste</label>
      <label class="switch"><input type="checkbox" name="titlebars" ${settings.titlebars ? 'checked' : ''}><span></span>Pane title bars</label>
    </div>
  </div>`);
  const before = { ...settings };
  const live = () => {
    applyTerminalSettings({
      theme: body.querySelector('[name=theme]:checked').value,
      fontFamily: body.querySelector('[name=fontFamily]').value,
      fontSize: +body.querySelector('[name=fontSize]').value,
      cursorStyle: body.querySelector('[name=cursorStyle]').value,
      scrollback: Math.max(500, +body.querySelector('[name=scrollback]').value || 10000),
      cursorBlink: body.querySelector('[name=cursorBlink]').checked,
      copyOnSelect: body.querySelector('[name=copyOnSelect]').checked,
      middlePaste: body.querySelector('[name=middlePaste]').checked,
      titlebars: body.querySelector('[name=titlebars]').checked,
    });
    body.querySelector('output').textContent = settings.fontSize;
  };
  body.addEventListener('input', live);
  body.addEventListener('change', live);
  const r = await modal({
    title: 'Terminal preferences',
    wide: true,
    body,
    buttons: [
      { label: 'Reset to defaults', value: 'reset' },
      { label: 'Cancel', value: false },
      { label: 'Done', value: true, primary: true },
    ],
  });
  if (r.value === false || r.value === null) applyTerminalSettings(before);
  if (r.value === 'reset') applyTerminalSettings({ ...DEFAULTS });
}

let fontsReady = null;
function loadFonts() {
  fontsReady ??= Promise.race([
    Promise.all(['400', '700'].map((w) => document.fonts.load(`${w} 14px "${settings.fontFamily}"`).catch(() => {}))),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  return fontsReady;
}

// ------------------------------------------------------------------ layout ---
// One workspace tab = one layout = a binary tree of split panes, kept directly
// in the DOM: a .tsplit holds [child, .gutter, child]; leaves are .tpane.
export function createTerminalLayout(session, info, { cwd, command, title, onTitle, onEmpty, onNewTab, onActivity } = {}) {
  const el = h(`<div class="term-layout${settings.titlebars ? '' : ' no-titlebars'}"><div class="tbody"></div></div>`);
  const body = $('.tbody', el);
  const panes = new Set();
  let focused = null;
  let zoomed = null;
  let visible = false;
  let started = false;
  const defaultTitle = `${info.username}@${info.host}`;

  const layout = {
    el,
    get paneCount() {
      return panes.size;
    },
    refreshBadges,
    split: (dir) => focused && splitPane(focused, dir),
    zoom: () => focused && toggleZoom(focused),
    closeFocused: () => focused && closePane(focused),
    // used by snippets: goes through the same path as typing (honours broadcast)
    typeIntoFocused: (text) => {
      const p = focused || [...panes][0];
      if (!p) return;
      p.term.paste(text.replace(/\r$/, ''));
      if (text.endsWith('\r')) p.send('\r');
      p.focus();
    },
    focused: () => focused,
    show() {
      visible = true;
      if (!started) {
        started = true;
        first.start();
      }
      requestAnimationFrame(() => {
        for (const p of panes) p.fit();
        (focused || [...panes][0])?.focus();
      });
    },
    hide() {
      visible = false;
    },
    dispose() {
      for (const p of [...panes]) p.dispose();
      panes.clear();
      layouts.delete(layout);
    },
  };
  layouts.add(layout);

  function updateTitle() {
    const t = focused?.title || title || defaultTitle;
    onTitle?.(panes.size > 1 ? `${t} · ${panes.size}` : t);
  }

  function refreshBadges() {
    for (const p of panes) {
      const on = broadcast === 'all' || (broadcast === 'tab' && panes.size > 1);
      p.el.classList.toggle('broadcasting', on);
    }
  }

  // ---------------------------------------------------------------- pane ---
  function createPane(opts = {}) {
    const pel = h(`<div class="tpane">
      <div class="tp-bar">
        <span class="tp-title"></span>
        <span class="tp-bcast" title="Keystrokes are broadcast">${icon('broadcast')} broadcast</span>
        <span class="tp-size mono"></span>
        <span class="tp-actions">
          <button class="tp-btn" data-a="right" title="Split right (Ctrl+Shift+E)" aria-label="Split right">${icon('splitV')}</button>
          <button class="tp-btn" data-a="down" title="Split down (Ctrl+Shift+O)" aria-label="Split down">${icon('splitH')}</button>
          <button class="tp-btn" data-a="zoom" title="Maximize pane (Ctrl+Shift+X)" aria-label="Maximize pane">${icon('maximize')}</button>
          <button class="tp-btn" data-a="close" title="Close pane (Alt+Shift+W)" aria-label="Close pane">${icon('x')}</button>
        </span>
      </div>
      <div class="tp-host"></div>
      <div class="tp-search" hidden>
        <input type="text" placeholder="Find" aria-label="Find in terminal" spellcheck="false">
        <button class="tp-btn" data-s="prev" title="Previous (Shift+Enter)" aria-label="Previous match">${icon('chevUp')}</button>
        <button class="tp-btn" data-s="next" title="Next (Enter)" aria-label="Next match">${icon('chevDown')}</button>
        <button class="tp-btn" data-s="close" title="Close (Esc)" aria-label="Close search">${icon('x')}</button>
      </div>
    </div>`);
    const host = $('.tp-host', pel);
    const titleEl = $('.tp-title', pel);
    const sizeEl = $('.tp-size', pel);
    const term = new Terminal(termOptions());
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
    let shell = null;
    let ended = false;
    let sizeTimer = null;

    const pane = {
      el: pel,
      term,
      title: opts.title || defaultTitle,
      fit() {
        if (!pel.isConnected || !host.offsetWidth || !host.offsetHeight) return;
        try {
          fit.fit();
        } catch {}
      },
      focus() {
        term.focus();
      },
      write(d) {
        shell?.write(d);
      },
      applySettings() {
        const o = termOptions();
        for (const k of ['theme', 'fontSize', 'fontFamily', 'lineHeight', 'cursorStyle', 'cursorBlink', 'scrollback']) term.options[k] = o[k];
        pel.style.setProperty('--term-bg', o.theme.background);
        pane.fit();
      },
      dispose() {
        ro.disconnect();
        allPanes.delete(pane);
        panes.delete(pane);
        shell?.close();
        term.dispose();
      },
    };
    pel.style.setProperty('--term-bg', effectiveTheme().background);
    titleEl.textContent = pane.title;

    const ro = new ResizeObserver(() => {
      if (!visible) return;
      pane.fit();
    });

    term.onResize(({ cols, rows }) => {
      shell?.resize(cols, rows);
      sizeEl.textContent = `${cols}×${rows}`;
      pel.classList.add('show-size');
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => pel.classList.remove('show-size'), 900);
    });
    term.onTitleChange((t) => {
      pane.title = t || defaultTitle;
      titleEl.textContent = pane.title;
      if (focused === pane) updateTitle();
    });
    term.onBell(() => {
      pel.classList.add('bell');
      setTimeout(() => pel.classList.remove('bell'), 400);
      if (getPrefs().notifyBell && (document.hidden || !visible) && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(`Terminal bell · ${pane.title}`, { body: `${info.username}@${info.host}`, tag: 'ssh-portal-bell', icon: 'icons/icon-192.png' });
      }
    });

    // Drop files on a terminal: upload them to the shell's home directory and
    // type their (quoted) paths, like dragging into a local terminal.
    pel.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      pel.classList.add('drop');
    });
    pel.addEventListener('dragleave', (e) => !pel.contains(e.relatedTarget) && pel.classList.remove('drop'));
    pel.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      pel.classList.remove('drop');
      const files = [...e.dataTransfer.files];
      const t = toast(`Uploading ${files.length} file(s) to ~ …`, 'info', 1e9);
      const paths = [];
      try {
        for (const f of files) {
          const dest = `${info.home}/${f.name}`;
          await session.upload(f, dest, (n) => ($('span', t).textContent = `Uploading ${f.name} · ${Math.round((n / Math.max(1, f.size)) * 100)}%`));
          paths.push(dest);
        }
        term.paste(paths.map(shq).join(' ') + ' ');
        toast(`Uploaded ${formatBytes(files.reduce((s, f) => s + f.size, 0))} to your home folder`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        t.remove();
      }
      term.focus();
    });
    term.onSelectionChange(() => {
      if (settings.copyOnSelect && term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
    });
    // keystrokes go to this shell and, when broadcasting, to the others too
    pane.send = (d) => {
      if (ended) return closePane(pane);
      shell?.write(d);
      if (broadcast !== 'off') {
        const targets = broadcast === 'all' ? allPanes : panes;
        for (const p of targets) if (p !== pane) p.write(d);
      }
    };
    term.onData((d) => pane.send(d));
    term.attachCustomKeyEventHandler((e) => handleKey(e, pane));

    pel.addEventListener('focusin', () => setFocus(pane));
    pel.addEventListener('mousedown', () => setFocus(pane));
    pel.addEventListener('auxclick', (e) => {
      if (e.button === 1 && settings.middlePaste) {
        e.preventDefault();
        paste(pane);
      }
    });
    pel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setFocus(pane);
      paneMenu(pane, e.clientX, e.clientY);
    });
    $('.tp-bar', pel).addEventListener('dblclick', (e) => !e.target.closest('button') && toggleZoom(pane));
    $('.tp-actions', pel).addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'right') splitPane(pane, 'row');
      if (a === 'down') splitPane(pane, 'col');
      if (a === 'zoom') toggleZoom(pane);
      if (a === 'close') closePane(pane);
    });

    // search bar
    const sbar = $('.tp-search', pel);
    const sinput = $('input', sbar);
    const sopts = () => ({ caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ffd33d', matchBackground: '#4b5563', activeMatchBackground: '#d29922' } });
    pane.openSearch = () => {
      sbar.hidden = false;
      sinput.value = term.getSelection() || sinput.value;
      sinput.focus();
      sinput.select();
    };
    const closeSearch = () => {
      sbar.hidden = true;
      search.clearDecorations();
      term.focus();
    };
    sinput.addEventListener('input', () => search.findNext(sinput.value, { ...sopts(), incremental: true }));
    sinput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.shiftKey ? search.findPrevious : search.findNext).call(search, sinput.value, sopts());
      if (e.key === 'Escape') closeSearch();
    });
    sbar.addEventListener('click', (e) => {
      const s = e.target.closest('[data-s]')?.dataset.s;
      if (s === 'next') search.findNext(sinput.value, sopts());
      if (s === 'prev') search.findPrevious(sinput.value, sopts());
      if (s === 'close') closeSearch();
    });

    pane.start = async () => {
      await loadFonts();
      term.open(host);
      ro.observe(host);
      pane.fit();
      term.focus();
      try {
        shell = await session.openTerminal(
          { cols: term.cols, rows: term.rows, cwd: opts.cwd, command: opts.command, x11: info.x11 !== false },
          (data) => {
            term.write(data);
            if (!visible) onActivity?.();
          },
          () => {
            shell = null;
            ended = true;
            // Terminator closes a pane when its shell exits
            if (panes.has(pane)) closePane(pane);
          },
        );
      } catch (e) {
        ended = true;
        term.write(`\x1b[31m✖ ${e.message}\x1b[0m\r\n\x1b[90mPress any key to close this pane.\x1b[0m`);
      }
    };

    panes.add(pane);
    allPanes.add(pane);
    return pane;
  }

  function termOptions() {
    return {
      fontFamily: fontStack(settings.fontFamily),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: effectiveTheme(),
      allowTransparency: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
    };
  }

  function setFocus(pane) {
    if (focused === pane) return;
    focused?.el.classList.remove('focused');
    focused = pane;
    pane.el.classList.add('focused');
    updateTitle();
  }

  // -------------------------------------------------------------- splits ---
  function gutter(dir) {
    const g = h(`<div class="gutter" role="separator" aria-orientation="${dir === 'row' ? 'vertical' : 'horizontal'}" title="Drag to resize · double-click to even out"></div>`);
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const split = g.parentElement;
      const [a, , b] = split.children;
      const rect = split.getBoundingClientRect();
      g.setPointerCapture(e.pointerId);
      el.classList.add('resizing', `resizing-${dir}`);
      const move = (ev) => {
        const r = dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        setRatio(a, b, r);
      };
      const up = () => {
        g.removeEventListener('pointermove', move);
        el.classList.remove('resizing', `resizing-${dir}`);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up, { once: true });
      g.addEventListener('pointercancel', up, { once: true });
    });
    g.addEventListener('dblclick', () => {
      const [a, , b] = g.parentElement.children;
      setRatio(a, b, 0.5);
    });
    return g;
  }

  function setRatio(a, b, r) {
    r = Math.max(0.08, Math.min(0.92, r));
    a.style.flex = `${r} 1 0px`;
    b.style.flex = `${1 - r} 1 0px`;
  }
  const ratioOf = (a) => parseFloat(a.style.flex) || 0.5;

  function splitPane(pane, dir) {
    const next = createPane({ cwd: null });
    const s = h(`<div class="tsplit" data-dir="${dir}"></div>`);
    s.style.flex = pane.el.style.flex || '1 1 0px';
    if (zoomed) toggleZoom(zoomed);
    pane.el.replaceWith(s);
    s.append(pane.el, gutter(dir), next.el);
    setRatio(pane.el, next.el, 0.5);
    refreshBadges();
    next.start().then(() => setFocus(next));
    updateTitle();
  }

  function closePane(pane) {
    if (!panes.has(pane)) return;
    if (zoomed === pane) toggleZoom(pane);
    const parent = pane.el.parentElement;
    pane.dispose();
    if (parent === body) {
      pane.el.remove();
      focused = null;
      return onEmpty?.();
    }
    const sibling = [...parent.children].find((c) => c !== pane.el && !c.classList.contains('gutter'));
    sibling.style.flex = parent.style.flex;
    parent.replaceWith(sibling);
    const target = paneOf(sibling.classList.contains('tpane') ? sibling : $('.tpane', sibling));
    focused = null;
    if (target) {
      setFocus(target);
      target.focus();
    }
    refreshBadges();
    updateTitle();
  }

  const paneOf = (node) => [...panes].find((p) => p.el === node);

  function toggleZoom(pane) {
    if (zoomed && zoomed !== pane) zoomed.el.classList.remove('zoom');
    zoomed = zoomed === pane ? null : pane;
    pane.el.classList.toggle('zoom', zoomed === pane);
    body.classList.toggle('zoomed', !!zoomed);
    requestAnimationFrame(() => {
      for (const p of panes) p.fit();
      pane.focus();
    });
  }

  function moveFocus(pane, dirKey) {
    const r = pane.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best = null;
    let bestD = Infinity;
    for (const p of panes) {
      if (p === pane) continue;
      const q = p.el.getBoundingClientRect();
      const ok = { ArrowLeft: q.right <= r.left + 2, ArrowRight: q.left >= r.right - 2, ArrowUp: q.bottom <= r.top + 2, ArrowDown: q.top >= r.bottom - 2 }[dirKey];
      if (!ok) continue;
      const qx = Math.max(q.left, Math.min(cx, q.right));
      const qy = Math.max(q.top, Math.min(cy, q.bottom));
      const d = Math.hypot(qx - cx, qy - cy);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) {
      setFocus(best);
      best.focus();
    }
  }

  function resizeFocused(pane, dirKey) {
    const want = dirKey === 'ArrowLeft' || dirKey === 'ArrowRight' ? 'row' : 'col';
    let node = pane.el;
    while (node.parentElement && node.parentElement !== body) {
      const split = node.parentElement;
      if (split.dataset.dir === want) {
        const [a, , b] = split.children;
        const delta = dirKey === 'ArrowRight' || dirKey === 'ArrowDown' ? 0.04 : -0.04;
        setRatio(a, b, ratioOf(a) + delta);
        return;
      }
      node = split;
    }
  }

  // Whole scrollback as a .txt download.
  function saveOutput(pane) {
    const buf = pane.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && !lines.at(-1)) lines.pop();
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${info.host}-terminal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function paste(pane) {
    try {
      const t = await navigator.clipboard.readText();
      if (t) pane.term.paste(t);
    } catch {
      toast('Clipboard access was blocked. Use Ctrl+Shift+V or allow clipboard access for this site.', 'error');
    }
  }

  // ------------------------------------------------------------ keyboard ---
  function handleKey(e, pane) {
    if (e.type !== 'keydown') return true;
    const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey;
    const altShift = e.altKey && e.shiftKey && !e.ctrlKey;
    const alt = e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    const code = e.code;
    // App-level shortcuts: let them bubble to the workspace instead of the shell
    // (Ctrl+K stays with the shell: it's readline's kill-line).
    if ((ctrlShift && code === 'KeyP') || (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) || (alt && /^Digit[1-9]$/.test(code))) return false;
    let handled = true;
    if (ctrlShift && code === 'KeyE') splitPane(pane, 'row');
    else if (ctrlShift && code === 'KeyO') splitPane(pane, 'col');
    else if (ctrlShift && code === 'KeyX') toggleZoom(pane);
    else if ((ctrlShift || altShift) && code === 'KeyW') closePane(pane);
    else if ((ctrlShift || altShift) && code === 'KeyT') onNewTab?.();
    else if (ctrlShift && code === 'KeyC') navigator.clipboard?.writeText(pane.term.getSelection()).catch(() => {});
    else if (ctrlShift && code === 'KeyV') paste(pane);
    else if (ctrlShift && code === 'KeyF') pane.openSearch();
    else if (ctrlShift && code === 'KeyA') pane.term.selectAll();
    else if (ctrlShift && code === 'KeyG') pane.term.clear();
    else if (ctrlShift && e.key.startsWith('Arrow')) resizeFocused(pane, e.key);
    else if (alt && e.key.startsWith('Arrow')) moveFocus(pane, e.key);
    else if (alt && code === 'KeyA') setBroadcast(broadcast === 'all' ? 'off' : 'all');
    else if (alt && code === 'KeyG') setBroadcast(broadcast === 'tab' ? 'off' : 'tab');
    else if (alt && code === 'KeyO') setBroadcast('off');
    else if (e.ctrlKey && !e.shiftKey && (e.key === '=' || e.key === '+')) applyTerminalSettings({ fontSize: Math.min(28, settings.fontSize + 1) });
    else if (e.ctrlKey && !e.shiftKey && e.key === '-') applyTerminalSettings({ fontSize: Math.max(9, settings.fontSize - 1) });
    else if (e.ctrlKey && !e.shiftKey && e.key === '0') applyTerminalSettings({ fontSize: DEFAULTS.fontSize });
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    return true;
  }

  function paneMenu(pane, x, y) {
    const sel = pane.term.hasSelection();
    contextMenu(x, y, [
      { label: 'Copy', icon: 'copy', hint: 'Ctrl+Shift+C', disabled: !sel, action: () => navigator.clipboard?.writeText(pane.term.getSelection()) },
      { label: 'Paste', icon: 'clipboard', hint: 'Ctrl+Shift+V', action: () => paste(pane) },
      { label: 'Find…', icon: 'search', hint: 'Ctrl+Shift+F', action: () => pane.openSearch() },
      '-',
      { label: 'Split right', icon: 'splitV', hint: 'Ctrl+Shift+E', action: () => splitPane(pane, 'row') },
      { label: 'Split down', icon: 'splitH', hint: 'Ctrl+Shift+O', action: () => splitPane(pane, 'col') },
      { label: zoomed === pane ? 'Restore pane' : 'Maximize pane', icon: 'maximize', hint: 'Ctrl+Shift+X', action: () => toggleZoom(pane) },
      { label: 'New tab', icon: 'plus', hint: 'Alt+Shift+T', action: () => onNewTab?.() },
      '-',
      { label: broadcast === 'tab' ? '✓ Broadcast to this tab' : 'Broadcast to this tab', icon: 'broadcast', hint: 'Alt+G', action: () => setBroadcast(broadcast === 'tab' ? 'off' : 'tab') },
      { label: broadcast === 'all' ? '✓ Broadcast to all terminals' : 'Broadcast to all terminals', icon: 'broadcast', hint: 'Alt+A', action: () => setBroadcast(broadcast === 'all' ? 'off' : 'all') },
      '-',
      { label: 'Clear scrollback', icon: 'refresh', hint: 'Ctrl+Shift+G', action: () => pane.term.clear() },
      { label: 'Save output as text…', icon: 'download', action: () => saveOutput(pane) },
      { label: 'Preferences…', icon: 'settings', action: openTerminalSettings },
      { label: 'Close pane', icon: 'x', hint: 'Alt+Shift+W', danger: true, action: () => closePane(pane) },
    ]);
  }

  // first pane
  const first = createPane({ cwd, command, title });
  first.el.style.flex = '1 1 0px';
  body.append(first.el);
  setFocus(first);
  refreshBadges();
  return layout;
}
