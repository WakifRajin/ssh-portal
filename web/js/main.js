import { DEFAULT_BRIDGE, BridgeSession } from './bridge.js';
import { createBridgeSetup } from './bridge-setup.js';
import { $, $$, h, icon, esc, toast, modal, confirmBox, promptBox, contextMenu, formatBytes } from './ui.js';
import { createFileExplorer } from './files.js';
import { createEditor } from './editor.js';
import { createApps } from './apps.js';
import { createSystem } from './system.js';
import { openPalette } from './palette.js';
import { createNetwork } from './network.js';
import { getPrefs, setPrefs, onPrefs, interval } from './prefs.js';
import { clearSudo } from './sudo.js';

const LS = {
  get: (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(`sshportal.${k}`)) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => localStorage.setItem(`sshportal.${k}`, JSON.stringify(v)),
};

// Static markup marks icons with data-icon; fill them in once.
function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (!el.querySelector(':scope > svg.ic')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  }
}
hydrateIcons();

// In a short window the rail scrolls (CSS), which would clip the hover tooltips,
// so fall back to native tooltips there.
{
  const short = matchMedia('(max-height: 780px)');
  const syncRailTips = () => {
    for (const b of $$('#dock [data-tip]')) {
      if (short.matches) b.title = b.dataset.tip;
      else if (b.title === b.dataset.tip) b.removeAttribute('title');
    }
  };
  short.addEventListener('change', syncRailTips);
  syncRailTips();
}

// ------------------------------------------------------------------ theme ---
// Themes: dark, light and "glass" (liquid glass); no explicit choice = system.
const THEME_NAMES = { dark: 'Dark', light: 'Light', glass: 'Liquid glass' };
const THEME_CYCLE = { dark: 'light', light: 'glass', glass: 'dark' };
const THEME_ICON = { dark: 'moon', light: 'sun', glass: 'droplet' };

function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
function syncThemeIcons() {
  const next = THEME_CYCLE[currentTheme()] || 'dark';
  for (const b of $$('[data-action="theme"]')) {
    b.innerHTML = icon(THEME_ICON[next]);
    b.title = `Switch to ${THEME_NAMES[next]} theme`;
    if (b.dataset.tip) b.dataset.tip = `Theme: ${THEME_NAMES[next]} next`;
  }
  // browser / installed-app title bar colour
  const explicit = document.documentElement.dataset.theme;
  const color = { dark: '#0b0d12', light: '#f5f6f8', glass: '#0d1020' }[explicit];
  for (const m of $$('meta[name="theme-color"]')) m.content = color || (m.media.includes('light') ? '#f5f6f8' : '#0b0d12');
}
function setTheme(t) {
  if (!t || t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  LS.set('theme', !t || t === 'system' ? null : t);
  syncThemeIcons();
  termMod?.refreshTerminalAppearance();
}
const toggleTheme = () => setTheme(THEME_CYCLE[currentTheme()] || 'dark');
syncThemeIcons();

// --------------------------------------------------------------- pairing ---
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (hashToken) {
  LS.set('token', hashToken);
  history.replaceState(null, '', location.pathname + location.search);
}

const settings = { bridge: LS.get('bridge', DEFAULT_BRIDGE), token: LS.get('token', '') };
let session = null;
let info = null;

// ----------------------------------------------------------- connect view ---
const connectView = $('#connect-view');
const workspace = $('#workspace');
const form = $('#connect-form');

const bridgeSetup = createBridgeSetup({ settings, LS });
const checkBridge = () => bridgeSetup.check();

$('#token-input').value = settings.token;
$('#bridge-url-input').value = settings.bridge;
$('#bridge-form').addEventListener('submit', (e) => {
  e.preventDefault();
  settings.token = $('#token-input').value.trim();
  settings.bridge = $('#bridge-url-input').value.trim().replace(/\/+$/, '') || DEFAULT_BRIDGE;
  LS.set('token', settings.token);
  LS.set('bridge', settings.bridge);
  checkBridge().then(() => toast(bridgeSetup.state === 'ready' ? 'Bridge settings saved' : "Saved, but the bridge isn't answering with that address and token", bridgeSetup.state === 'ready' ? 'success' : 'error'));
});

// ------------------------------------------------------------- profiles ---
const profiles = () => LS.get('profiles', []);
function renderProfiles() {
  const ps = profiles();
  $('#saved-wrap').hidden = !ps.length;
  $('#profile-list').innerHTML = ps
    .map(
      (p, i) => `<li><button type="button" class="profile" data-i="${i}">
        <span class="avatar" style="--h:${[...p.host].reduce((a, c) => a + c.charCodeAt(0), 0) % 360}">${esc((p.name || p.host)[0].toUpperCase())}</span>
        <span class="p-text"><b>${esc(p.name || p.host)}</b><small>${esc(p.username)}@${esc(p.host)}${+p.port !== 22 ? ':' + esc(p.port) : ''}</small></span>
        <span class="p-auth">${esc({ password: 'password', key: 'key', agent: 'agent' }[p.auth] || '')}</span></button>
        ${p.mac ? `<button type="button" class="icon-btn sm" data-wake="${i}" aria-label="Wake ${esc(p.name || p.host)}" title="Wake-on-LAN">${icon('power')}</button>` : ''}
        <button type="button" class="icon-btn sm" data-del="${i}" aria-label="Forget ${esc(p.name || p.host)}" title="Forget">${icon('x')}</button></li>`,
    )
    .join('');
}
$('#profile-list').addEventListener('click', async (e) => {
  const wake = e.target.closest('[data-wake]');
  if (wake) {
    const p = profiles()[+wake.dataset.wake];
    try {
      const r = await fetch(`${settings.bridge}/api/wol?mac=${encodeURIComponent(p.mac)}`, { method: 'POST', headers: { authorization: `Bearer ${settings.token}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The bridge must be running and paired');
      toast(`Wake-on-LAN packet sent to ${p.name || p.host}. Give it a moment to boot.`, 'success', 6000);
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const ps = profiles();
    ps.splice(+del.dataset.del, 1);
    LS.set('profiles', ps);
    return renderProfiles();
  }
  const b = e.target.closest('[data-i]');
  if (!b) return;
  const p = profiles()[+b.dataset.i];
  for (const k of ['host', 'port', 'username', 'keyPath', 'name', 'mac']) form[k].value = p[k] ?? '';
  form.auth.value = p.auth || 'password';
  form.x11.checked = p.x11 !== false;
  syncForm();
  $$('.profile').forEach((x) => x.classList.toggle('picked', x === b));
  if (p.auth === 'password') form.password.focus();
  else form.requestSubmit();
});

function syncForm() {
  const a = form.auth.value;
  for (const el of $$('[data-auth]', form)) el.hidden = el.dataset.auth !== a;
  $('[data-save]', form).hidden = !form.save.checked;
}
form.addEventListener('change', (e) => {
  if (e.target.name === 'dataSaver') setPrefs({ dataSaver: e.target.checked });
  syncForm();
});
$('#key-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) form.privateKey.value = await f.text();
});

const connectLabel = () => `${icon('plug')}<span>Connect</span>`;
$('#connect-btn').innerHTML = connectLabel();

// Connection details of the current session, kept in memory only (never
// stored) so "Reconnect" works after a network blip.
let lastArgs = null;

async function openSession(args) {
  if (!(await bridgeSetup.ensureReady())) {
    throw new Error(bridgeSetup.state === 'unpaired' ? 'Pair this browser with the bridge first (see the Bridge panel).' : "The bridge isn't running yet. Follow the steps in the Bridge panel.");
  }
  const s = new BridgeSession(settings.bridge, settings.token);
  s.onHostKey = hostKeyDialog;
  s.onPrompt = promptDialog;
  await s.open();
  try {
    info = await s.req('connect', { ...args, compress: getPrefs().dataSaver });
  } catch (e) {
    s.close();
    throw e;
  }
  info.x11 = args.x11;
  session = s;
  lastArgs = args;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  const btn = $('#connect-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span><span>Connecting to ${esc(v.host)}…</span>`;
  try {
    const args = { host: v.host.trim(), port: +v.port || 22, username: v.username.trim(), x11: form.x11.checked, agent: v.auth !== 'key' };
    if (v.auth === 'password') args.password = v.password;
    if (v.auth === 'key') {
      if (v.privateKey.trim()) args.privateKey = v.privateKey;
      else if (v.keyPath.trim()) args.keyPath = v.keyPath.trim();
      args.passphrase = v.passphrase;
    }
    await openSession(args);
    if (form.save.checked) {
      const ps = profiles().filter((p) => !(p.host === args.host && p.username === args.username && +p.port === args.port));
      ps.unshift({ name: v.name, host: args.host, port: args.port, username: args.username, auth: v.auth, keyPath: v.keyPath, x11: form.x11.checked, mac: v.mac.trim() || undefined });
      LS.set('profiles', ps.slice(0, 12));
    }
    form.password.value = '';
    form.passphrase.value = '';
    enterWorkspace();
  } catch (err) {
    toast(err.message, 'error', 7000);
    checkBridge();
  } finally {
    btn.disabled = false;
    btn.innerHTML = connectLabel();
  }
});

async function hostKeyDialog(m) {
  const changed = !!m.previous;
  const r = await modal({
    title: changed ? 'Host key has changed' : 'Verify host',
    body: `${changed ? `<div class="callout danger"><b>The key for ${esc(m.host)} is different from last time.</b> The machine may have been reinstalled, or someone could be intercepting the connection.<br><span class="small">Previous: <code>${esc(m.previous)}</code></span></div>` : `<p>First connection to <b>${esc(m.host)}</b>. Check that the fingerprint matches the server.</p>`}
      <div class="fp-box"><span class="small muted">SHA256 fingerprint</span><code class="fp">${esc(m.fingerprint.replace(/^SHA256:/, ''))}</code></div>
      <p class="muted small">On the server: <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code></p>`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: changed ? 'Accept new key' : 'Trust and connect', value: true, primary: true, danger: changed },
    ],
  });
  return r.value === true;
}

async function promptDialog(m) {
  const r = await modal({
    title: m.title || 'Authentication',
    body: `${m.instructions ? `<p>${esc(m.instructions)}</p>` : ''}${m.prompts
      .map((p, i) => `<label class="field"><span>${esc(p.prompt)}</span><input name="a${i}" type="${p.echo ? 'text' : 'password'}" autocomplete="off" ${i ? '' : 'autofocus'}></label>`)
      .join('')}`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Continue', value: true, primary: true },
    ],
  });
  return r.value === true ? m.prompts.map((_, i) => r.data[`a${i}`] ?? '') : null;
}

// ------------------------------------------------------------- workspace ---
const tabs = new Map(); // id -> { id, title, iconName, view, tabEl, kind }
let activeId = null;
const appState = { desktopDisplay: null };
let filesView = null;
let appsView = null;
let termMod = null;
const loadTermMod = async () => (termMod ??= await import('./terminals.js'));

function addTab({ id, title, iconName, view, closable = true, kind = id.split(':')[0] }) {
  if (tabs.has(id)) return activate(id);
  const tabEl = h(`<div class="tab" role="tab" data-id="${esc(id)}" tabindex="0" draggable="true" aria-selected="false">
    ${icon(iconName)}<span class="tab-title">${esc(title)}</span>${closable ? `<button class="tab-x" tabindex="-1" aria-label="Close ${esc(title)}">${icon('x')}</button>` : ''}</div>`);
  view.el.classList.add('pane');
  view.el.hidden = true;
  $('#tabstrip').append(tabEl);
  $('#panes').append(view.el);
  tabs.set(id, { id, title, iconName, view, tabEl, kind, closable });
  activate(id);
}

function activate(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (activeId && activeId !== id) {
    const prev = tabs.get(activeId);
    if (prev) {
      prev.view.el.hidden = true;
      prev.tabEl.classList.remove('active');
      prev.tabEl.setAttribute('aria-selected', 'false');
      prev.view.hide?.();
    }
  }
  activeId = id;
  t.view.el.hidden = false;
  t.tabEl.classList.remove('activity');
  t.tabEl.classList.add('active');
  t.tabEl.setAttribute('aria-selected', 'true');
  t.tabEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  t.view.show?.();
  for (const d of $$('#dock [data-open]')) d.classList.toggle('active', d.dataset.open === t.kind);
  updateStatus();
}

async function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.view.canClose && !(await t.view.canClose())) return;
  if (t.kind === 'terminal' && t.view.paneCount > 1 && getPrefs().confirmCloseTerminals && !(await confirmBox('Close tab?', `This tab has ${t.view.paneCount} terminals. Close all of them?`, { okLabel: 'Close tab', danger: true }))) return;
  const order = [...tabs.keys()];
  const idx = order.indexOf(id);
  t.view.dispose?.();
  t.view.el.remove();
  t.tabEl.remove();
  tabs.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = order[idx + 1] || order[idx - 1];
    if (next) activate(next);
    else updateStatus();
  }
}

function setTabTitle(id, title) {
  const t = tabs.get(id);
  if (!t) return;
  t.title = title;
  $('.tab-title', t.tabEl).textContent = title;
  t.tabEl.title = title;
  if (id === activeId) updateStatus();
}

const strip = $('#tabstrip');
strip.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  if (e.target.closest('.tab-x')) closeTab(tab.dataset.id);
  else if (tab.dataset.id !== activeId) withTransition(() => activate(tab.dataset.id), 'tab-switch');
});

// Smooth state changes where the browser supports View Transitions.
function withTransition(update, type) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return update();
  document.documentElement.dataset.vt = type || '';
  const vt = document.startViewTransition(update);
  vt.finished.finally(() => delete document.documentElement.dataset.vt);
}
strip.addEventListener('auxclick', (e) => {
  const tab = e.target.closest('.tab');
  if (e.button === 1 && tab && tabs.get(tab.dataset.id)?.closable) closeTab(tab.dataset.id);
});
strip.addEventListener('keydown', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  if (e.key === 'Enter' || e.key === ' ') activate(tab.dataset.id);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const all = $$('.tab', strip);
    const n = all[(all.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
    n.focus();
  }
});
strip.addEventListener('contextmenu', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  e.preventDefault();
  const t = tabs.get(tab.dataset.id);
  const others = [...tabs.values()].filter((x) => x !== t && x.closable);
  contextMenu(e.clientX, e.clientY, [
    t.kind === 'terminal' && { label: 'Split right', icon: 'splitV', action: () => (activate(t.id), t.view.split('row')) },
    t.kind === 'terminal' && { label: 'Split down', icon: 'splitH', action: () => (activate(t.id), t.view.split('col')) },
    t.kind === 'terminal' && { label: 'Rename tab…', icon: 'edit', action: async () => { const n = await promptBox('Rename tab', 'Tab name', t.title); if (n) { t.view.fixedTitle = n; setTabTitle(t.id, n); } } },
    t.kind === 'terminal' && '-',
    { label: 'New terminal', icon: 'terminal', action: () => openTerminal() },
    '-',
    { label: 'Close', icon: 'x', disabled: !t.closable, action: () => closeTab(t.id) },
    { label: 'Close other tabs', icon: 'x', disabled: !others.length, action: () => others.forEach((o) => closeTab(o.id)) },
  ]);
});
// drag tabs to reorder
let dragTab = null;
strip.addEventListener('dragstart', (e) => {
  dragTab = e.target.closest('.tab');
  e.dataTransfer.effectAllowed = 'move';
  dragTab?.classList.add('dragging');
});
strip.addEventListener('dragend', () => {
  dragTab?.classList.remove('dragging');
  dragTab = null;
});
strip.addEventListener('dragover', (e) => {
  if (!dragTab) return;
  e.preventDefault();
  const over = e.target.closest('.tab');
  if (!over || over === dragTab) return;
  const r = over.getBoundingClientRect();
  over.parentElement.insertBefore(dragTab, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
});
strip.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

// ------------------------------------------------------------- openers ---
let termSeq = 0;
async function openTerminal(cwd = null, command = null, title = null) {
  const { createTerminalLayout } = await loadTermMod();
  const id = `terminal:${++termSeq}`;
  let view = null;
  view = createTerminalLayout(session, info, {
    cwd,
    command,
    title,
    onTitle: (t) => !view?.fixedTitle && setTabTitle(id, t),
    // last pane exited: close the tab without asking
    onEmpty: () => closeTabNow(id),
    onNewTab: () => openTerminal(),
    // dot on the tab when a background terminal prints something
    onActivity: () => activeId !== id && tabs.get(id)?.tabEl.classList.add('activity'),
  });
  addTab({ id, title: title || `${info.username}@${info.host}`, iconName: 'terminal', view });
}

function closeTabNow(id) {
  const t = tabs.get(id);
  if (!t) return;
  const order = [...tabs.keys()];
  const idx = order.indexOf(id);
  t.view.dispose?.();
  t.view.el.remove();
  t.tabEl.remove();
  tabs.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = order[idx + 1] || order[idx - 1];
    if (next) activate(next);
    else updateStatus();
  }
}

function openEditor(path) {
  const id = `editor:${path}`;
  if (tabs.has(id)) return activate(id);
  const name = path.split('/').pop();
  const view = createEditor(session, path, { onDirty: (d) => setTabTitle(id, d ? `● ${name}` : name) });
  addTab({ id, title: name, iconName: 'code', view });
}

async function openDesktop() {
  if (tabs.has('desktop')) return activate('desktop');
  const { createDesktop } = await import('./desktop.js');
  addTab({ id: 'desktop', title: 'Desktop', iconName: 'monitor', view: createDesktop(session, info, appState) });
}

// path (optional): navigate the Files tab there
function openFiles(path) {
  if (!tabs.has('files')) {
    filesView = createFileExplorer(session, info, actions);
    addTab({ id: 'files', title: 'Files', iconName: 'folder', view: filesView, closable: false });
  } else activate('files');
  if (typeof path === 'string' && path) Promise.resolve(filesView.navigate(path)).then(updateStatus, () => {});
}
function openApps() {
  if (tabs.has('apps')) return activate('apps');
  appsView = createApps(session, info, appState, actions);
  addTab({ id: 'apps', title: 'Apps', iconName: 'grid', view: appsView });
}
function openSystem() {
  if (tabs.has('system')) return activate('system');
  addTab({ id: 'system', title: 'System', iconName: 'activity', view: createSystem(session) });
}
let networkView = null;
// opts: { tool, target } runs a diagnostic; { ports: host } runs a port check
function openNetwork(section, opts) {
  if (!tabs.has('network')) {
    networkView = createNetwork(session, info, actions);
    addTab({ id: 'network', title: 'Network', iconName: 'broadcast', view: networkView });
  } else activate('network');
  if (opts?.tool) networkView.runTool(opts.tool, opts.target);
  else if (opts?.ports) networkView.checkPorts(opts.ports);
  else if (section) networkView.open(section);
}

// Server panels are loaded on first use, so a problem in one can't stop the app starting.
const loadingTabs = new Set();
async function openLazy(id, title, iconName, load) {
  if (tabs.has(id)) return activate(id);
  if (loadingTabs.has(id)) return;
  loadingTabs.add(id);
  try {
    const view = await load();
    if (!view || !session) return;
    if (tabs.has(id)) view.dispose?.();
    else addTab({ id, title, iconName, view });
  } catch (e) {
    toast(`Couldn't open ${title}: ${e.message}`, 'error', 7000);
  } finally {
    loadingTabs.delete(id);
  }
}
const openServices = () => openLazy('services', 'Services', 'sliders', async () => (await import('./services.js')).createServices(session, info, actions));
const openDocker = () => openLazy('docker', 'Docker', 'box', async () => (await import('./docker.js')).createDocker(session, info, actions));
let logsView = null;
// src: { unit, scope } to start on a specific service
async function openLogs(src) {
  if (tabs.has('logs')) {
    if (src) logsView.open(src); // before activating, so the tab starts only once
    return activate('logs');
  }
  await openLazy('logs', 'Logs', 'scroll', async () => {
    const m = await import('./logs.js');
    if (!session) return null;
    logsView = m.createLogs(session);
    if (src) logsView.open(src);
    return logsView;
  });
}
let devicesView = null;
async function openDevices(section) {
  if (tabs.has('devices')) {
    if (section) devicesView.open(section);
    return activate('devices');
  }
  await openLazy('devices', 'Devices', 'usb', async () => {
    const m = await import('./devices.js');
    if (!session) return null;
    devicesView = m.createDevices(session, info, actions);
    if (section) devicesView.open(section);
    return devicesView;
  });
}

const actions = {
  openTerminal: (cwd, command, title) => openTerminal(cwd, command, title),
  openEditor,
  showDesktop: openDesktop,
  openLogs: (src) => openLogs(src),
  openFiles: (path) => openFiles(path),
  openNetwork: (section, opts) => openNetwork(section, opts),
  openWithRemote: (path) => {
    if (!tabs.has('apps')) openApps();
    appsView.launch(`xdg-open '${path.replace(/'/g, `'\\''`)}'`, appState.desktopDisplay != null ? 'desktop' : 'x11', `xdg-open ${path.split('/').pop()}`);
  },
};

const activeTab = () => tabs.get(activeId);
const activeTerm = () => (activeTab()?.kind === 'terminal' ? activeTab().view : null);
const filesCwd = () => (activeId === 'files' ? filesView?.cwd : null);

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open && !workspace.hidden) {
    ({ files: openFiles, terminal: () => openTerminal(filesCwd()), desktop: openDesktop, apps: openApps, system: openSystem, network: () => openNetwork(), services: openServices, logs: () => openLogs(), docker: openDocker, devices: () => openDevices() })[open]?.();
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'theme') toggleTheme();
  if (action === 'palette') showPalette();
  if (action === 'term-settings') loadTermMod().then((m) => m.openTerminalSettings());
  if (action === 'settings') openSettings();
  if (action === 'install') installApp();
  if (action === 'disconnect') disconnect();
});

// ------------------------------------------------------------- snippets ---
// Saved commands, run in the focused terminal (honours broadcast).
async function runSnippet(cmd) {
  let term = activeTerm();
  if (!term) {
    await openTerminal(filesCwd(), cmd.command);
    return;
  }
  term.typeIntoFocused(cmd.command + '\r');
}

async function manageSnippets() {
  const list = getPrefs().snippets.slice();
  const body = h(`<div class="snip-editor">
    <p class="muted small">Snippets appear in the command palette (Ctrl+K) and run in the focused terminal.</p>
    <div class="snip-rows"></div>
    <button type="button" class="btn btn-sm" data-add>${icon('plus')} Add snippet</button>
  </div>`);
  const rows = $('.snip-rows', body);
  const row = (s = { name: '', command: '' }) => {
    const r = h(`<div class="snip-row"><input placeholder="Name" value="${esc(s.name)}" aria-label="Snippet name"><input class="mono" placeholder="Command" value="${esc(s.command)}" aria-label="Command" spellcheck="false"><button type="button" class="icon-btn sm" aria-label="Remove">${icon('x')}</button></div>`);
    $('button', r).addEventListener('click', () => r.remove());
    rows.append(r);
    return r;
  };
  list.forEach((s) => row(s));
  $('[data-add]', body).addEventListener('click', () => $('input', row()).focus());
  const r = await modal({ title: 'Snippets', wide: true, body, buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] });
  if (r.value !== true) return;
  const snippets = $$('.snip-row', body)
    .map((x) => ({ name: x.children[0].value.trim(), command: x.children[1].value }))
    .filter((s) => s.command.trim())
    .map((s) => ({ ...s, name: s.name || s.command.slice(0, 40) }));
  setPrefs({ snippets });
  toast(`${snippets.length} snippet${snippets.length === 1 ? '' : 's'} saved`, 'success');
}

// ------------------------------------------------------- preferences ---
async function openSettings() {
  const p = getPrefs();
  const body = h(`<div class="settings">
    <section><h3>Appearance</h3>
      <div class="segmented" role="radiogroup" aria-label="Theme">
        ${['system', 'light', 'dark', 'glass'].map((t) => `<label><input type="radio" name="theme" value="${t}" ${(document.documentElement.dataset.theme || 'system') === t ? 'checked' : ''}><span>${t === 'system' ? 'System' : THEME_NAMES[t]}</span></label>`).join('')}
      </div>
      <button type="button" class="btn btn-sm" data-act="term">${icon('terminal')} Terminal theme &amp; font…</button>
    </section>
    <section><h3>Network</h3>
      <label class="switch"><input type="checkbox" name="dataSaver" ${p.dataSaver ? 'checked' : ''}><span></span><div><b>Data saver</b><small>Compresses SSH traffic (from the next connection), lowers remote-desktop quality and polls less often. Best on Wi-Fi, VPN or mobile links.</small></div></label>
    </section>
    <section><h3>Behaviour</h3>
      <label class="switch"><input type="checkbox" name="confirmCloseTerminals" ${p.confirmCloseTerminals ? 'checked' : ''}><span></span><div><b>Confirm before closing split terminals</b></div></label>
      <label class="switch"><input type="checkbox" name="notifyBell" ${p.notifyBell ? 'checked' : ''}><span></span><div><b>Notify on terminal bell</b><small>Shows a desktop notification when a hidden terminal rings (e.g. <code>make; printf '\\a'</code>).</small></div></label>
      <button type="button" class="btn btn-sm" data-act="snippets">${icon('code')} Manage snippets…</button>
    </section>
    <section><h3>App</h3>
      <div class="row-actions">
        <button type="button" class="btn btn-sm" data-act="install" ${installEvent ? '' : 'hidden'}>${icon('download')} Install SSH Portal</button>
        <button type="button" class="btn btn-sm" data-act="shortcuts">${icon('keyboard')} Keyboard shortcuts</button>
        <button type="button" class="btn btn-sm btn-danger" data-act="reset">${icon('trash')} Reset all local data</button>
      </div>
      <p class="muted small">${matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches ? 'Running as an installed app.' : 'Install it from your browser for its own window, Dock/taskbar icon and offline start.'}</p>
    </section>
  </div>`);
  body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'term') loadTermMod().then((m) => m.openTerminalSettings());
    if (act === 'snippets') manageSnippets();
    if (act === 'install') installApp();
    if (act === 'shortcuts') showShortcuts();
    if (act === 'reset' && (await confirmBox('Reset SSH Portal?', 'This forgets saved machines, bookmarks, snippets, preferences and the bridge pairing in this browser.', { okLabel: 'Reset', danger: true }))) {
      for (const k of Object.keys(localStorage)) if (k.startsWith('sshportal.')) localStorage.removeItem(k);
      location.reload();
    }
  });
  body.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.name === 'theme') setTheme(t.value);
    if (t.name === 'dataSaver') setPrefs({ dataSaver: t.checked });
    if (t.name === 'confirmCloseTerminals') setPrefs({ confirmCloseTerminals: t.checked });
    if (t.name === 'notifyBell') {
      if (t.checked && 'Notification' in window && Notification.permission !== 'granted') t.checked = (await Notification.requestPermission()) === 'granted';
      setPrefs({ notifyBell: t.checked });
    }
  });
  await modal({ title: 'Preferences', wide: true, body, buttons: [{ label: 'Done', value: true, primary: true }] });
}

const SHORTCUTS = [
  ['General', [['Ctrl+K · Ctrl+Shift+P', 'Command palette (Ctrl+Shift+P inside a terminal)'], ['?', 'This list'], ['Ctrl+PageUp / PageDown', 'Previous / next tab'], ['Alt+1…9', 'Go to tab'], ['Alt+Shift+T', 'New terminal tab'], ['Alt+Shift+W', 'Close tab / pane']]],
  ['Terminal', [['Ctrl+Shift+E', 'Split right'], ['Ctrl+Shift+O', 'Split down'], ['Ctrl+Shift+X', 'Maximize pane'], ['Alt+Arrows', 'Move between panes'], ['Ctrl+Shift+Arrows', 'Resize pane'], ['Alt+G / Alt+A / Alt+O', 'Broadcast: tab / all / off'], ['Ctrl+Shift+C / V', 'Copy / paste'], ['Ctrl+Shift+F', 'Find'], ['Ctrl + = / − / 0', 'Font size'], ['Drop files', 'Upload and paste the path']]],
  ['Files', [['Enter / Backspace', 'Open / up'], ['Space', 'Quick look'], ['F2 · Del', 'Rename · delete'], ['Ctrl+C / X / V', 'Copy / cut / paste'], ['Ctrl+H', 'Hidden files'], ['Alt+← / →', 'Back / forward']]],
];
function showShortcuts() {
  modal({
    title: 'Keyboard shortcuts',
    wide: true,
    body: `<div class="shortcuts">${SHORTCUTS.map(([g, rows]) => `<section><h3>${g}</h3><dl>${rows.map(([k, d]) => `<dt>${k.split(/\s+(\/|·)\s+/).map((x) => (x === '/' || x === '·' ? ` ${x} ` : `<kbd>${esc(x)}</kbd>`)).join('')}</dt><dd>${esc(d)}</dd>`).join('')}</dl></section>`).join('')}</div>`,
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// ---------------------------------------------------------------- PWA ---
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  for (const b of $$('[data-action="install"]')) b.hidden = false;
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  for (const b of $$('[data-action="install"]')) b.hidden = true;
  toast('SSH Portal is installed. Find it with your other apps.', 'success');
});
async function installApp() {
  if (!installEvent) return toast('Use your browser menu → Install SSH Portal (or Add to Home Screen).');
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => {
      const t = toast('A new version of SSH Portal is ready.', 'info', 15000);
      const b = h(`<button class="btn btn-sm">Update</button>`);
      b.addEventListener('click', () => w.postMessage('skip-waiting'));
      t.append(b);
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => w.state === 'installed' && navigator.serviceWorker.controller && offer(w));
    });
  }).catch(() => {});
  let reloaded = false;
  // Only reload for updates: the first install also fires controllerchange
  // (clients.claim), and reloading then would drop a ?open= deep link.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || session || !hadController) return; // never yank an active session
    reloaded = true;
    location.reload();
  });
}

// ------------------------------------------------------------- palette ---
function commands() {
  const term = activeTerm();
  const cmds = [
    { group: 'Terminal', title: 'New terminal tab', icon: 'terminal', hint: 'Alt+Shift+T', run: () => openTerminal(filesCwd()) },
    { group: 'Terminal', title: 'Split terminal right', icon: 'splitV', hint: 'Ctrl+Shift+E', when: () => !!term, run: () => term.split('row') },
    { group: 'Terminal', title: 'Split terminal down', icon: 'splitH', hint: 'Ctrl+Shift+O', when: () => !!term, run: () => term.split('col') },
    { group: 'Terminal', title: 'Maximize / restore pane', icon: 'maximize', hint: 'Ctrl+Shift+X', when: () => !!term, run: () => term.zoom() },
    { group: 'Terminal', title: 'Close pane', icon: 'x', hint: 'Alt+Shift+W', when: () => !!term, run: () => term.closeFocused() },
    { group: 'Terminal', title: 'Broadcast input to this tab', icon: 'broadcast', hint: 'Alt+G', when: () => !!termMod, run: () => termMod.setBroadcast('tab') },
    { group: 'Terminal', title: 'Broadcast input to all terminals', icon: 'broadcast', hint: 'Alt+A', when: () => !!termMod, run: () => termMod.setBroadcast('all') },
    { group: 'Terminal', title: 'Stop broadcasting', icon: 'broadcast', hint: 'Alt+O', when: () => termMod?.getBroadcast() !== 'off', run: () => termMod.setBroadcast('off') },
    { group: 'Terminal', title: 'Terminal preferences (theme, font…)', icon: 'settings', run: () => loadTermMod().then((m) => m.openTerminalSettings()) },
    { group: 'Go to', title: 'Files', icon: 'folder', run: openFiles },
    { group: 'Go to', title: 'Remote desktop', icon: 'monitor', run: openDesktop },
    { group: 'Go to', title: 'Applications', icon: 'grid', run: openApps },
    { group: 'Go to', title: 'System monitor', icon: 'activity', run: openSystem },
    { group: 'Server', title: 'Services (start, stop, restart)', icon: 'sliders', run: openServices },
    { group: 'Server', title: 'Logs (system journal)', icon: 'scroll', run: () => openLogs() },
    { group: 'Server', title: 'Docker containers', icon: 'box', run: openDocker },
    { group: 'Server', title: 'Devices', icon: 'usb', run: () => openDevices() },
    { group: 'Server', title: 'Devices: USB', icon: 'usb', run: () => openDevices('usb') },
    { group: 'Server', title: 'Devices: Network & switch', icon: 'broadcast', run: () => openDevices('network') },
    { group: 'Server', title: 'Devices: Nearby devices', icon: 'search', run: () => openDevices('nearby') },
    { group: 'Server', title: 'Devices: Storage', icon: 'hdd', run: () => openDevices('storage') },
    { group: 'Network', title: 'Network overview', icon: 'server', run: () => openNetwork('overview') },
    { group: 'Network', title: 'Live bandwidth', icon: 'activity', run: () => openNetwork('bandwidth') },
    { group: 'Network', title: 'Ping / traceroute / DNS / HTTP check', icon: 'zap', run: () => openNetwork('tools') },
    { group: 'Network', title: 'Port check', icon: 'shield', run: () => openNetwork('ports') },
    { group: 'Network', title: 'Scan LAN for devices', icon: 'search', run: () => openNetwork('lan') },
    { group: 'Network', title: 'Port forwarding / SOCKS proxy', icon: 'link', run: () => openNetwork('forward') },
    { group: 'Network', title: 'Speed test', icon: 'download', run: () => openNetwork('speed') },
    { group: 'Network', title: 'Wake-on-LAN', icon: 'power', run: () => openNetwork('wol') },
    ...getPrefs().snippets.map((s) => ({ group: 'Snippets', title: `Run: ${s.name}`, icon: 'play', run: () => runSnippet(s) })),
    { group: 'Snippets', title: 'Manage snippets…', icon: 'code', run: manageSnippets },
    { group: 'Go to', title: 'Folder…', icon: 'folder', run: async () => { const p = await promptBox('Go to folder', 'Path on the remote', filesView?.cwd || info.home); if (p) { openFiles(); filesView.navigate(p.replace(/^~(?=\/|$)/, info.home)); } } },
    ...[...tabs.values()].map((t) => ({ group: 'Open tabs', title: `Switch to: ${t.title}`, icon: t.iconName, run: () => activate(t.id) })),
    ...Object.entries(THEME_NAMES).map(([k, n]) => ({ group: 'Theme', title: `Theme: ${n}${currentTheme() === k ? '  ✓' : ''}`, icon: THEME_ICON[k], run: () => setTheme(k) })),
    { group: 'Theme', title: 'Theme: follow system', icon: 'monitor', run: () => setTheme('system') },
    { group: 'Session', title: `${getPrefs().dataSaver ? 'Turn off' : 'Turn on'} data saver`, icon: 'zap', run: () => setPrefs({ dataSaver: !getPrefs().dataSaver }) },
    { group: 'Session', title: 'Preferences…', icon: 'settings', run: openSettings },
    { group: 'Session', title: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: showShortcuts },
    { group: 'Session', title: 'Install SSH Portal as an app', icon: 'download', when: () => !!installEvent, run: installApp },
    { group: 'Session', title: 'Open another machine in a new window', icon: 'window', run: () => window.open(location.pathname, '_blank') },
    { group: 'Session', title: 'Disconnect', icon: 'logout', run: disconnect },
  ];
  return cmds;
}
const showPalette = () => !workspace.hidden && openPalette(commands);

// -------------------------------------------------------------- status ---
let latencyTimer = null;
let x11State = null;
async function updateStatus() {
  const t = activeTab();
  const view = $('#st-view');
  if (t?.kind === 'terminal') view.innerHTML = `${icon('terminal')}<span>${t.view.paneCount} pane${t.view.paneCount === 1 ? '' : 's'} · ${[...tabs.values()].filter((x) => x.kind === 'terminal').length} terminal tab(s)</span>`;
  else if (t?.kind === 'files') view.innerHTML = `${icon('folder')}<span class="mono">${esc(filesView?.cwd || '')}</span>`;
  else if (t?.kind === 'editor') view.innerHTML = `${icon('code')}<span class="mono">${esc(t.id.slice(7))}</span>`;
  else view.innerHTML = '';
  const b = termMod?.getBroadcast() || 'off';
  const bb = $('#st-bcast');
  bb.hidden = b === 'off';
  bb.innerHTML = `${icon('broadcast')}<span>Broadcasting to ${b === 'all' ? 'all terminals' : 'this tab'}</span>${icon('x')}`;
}
$('#st-bcast').addEventListener('click', () => termMod?.setBroadcast('off'));

async function pollLatency() {
  if (!session) return;
  const t0 = performance.now();
  try {
    await session.req('ping');
    const ms = Math.round(performance.now() - t0);
    $('#st-latency').innerHTML = `<span class="dot" data-kind="${ms < 150 ? 'ok' : 'busy'}"></span>${ms} ms`;
  } catch {
    $('#st-latency').innerHTML = `<span class="dot" data-kind="err"></span>—`;
  }
}

// Bytes actually sent over SSH (after compression): rate + totals.
let trafficTimer = null;
let lastTraffic = null;
async function pollTraffic() {
  clearTimeout(trafficTimer);
  if (!session) return;
  try {
    const t = await session.req('traffic');
    const now = performance.now();
    const el = $('#st-traffic');
    if (lastTraffic) {
      const dt = (now - lastTraffic.at) / 1000;
      const down = Math.max(0, (t.rx - lastTraffic.rx) / dt);
      const up = Math.max(0, (t.tx - lastTraffic.tx) / dt);
      el.innerHTML = `<span class="tr-down">↓ ${formatRate(down)}</span><span class="tr-up">↑ ${formatRate(up)}</span>${t.compress ? `<span class="tr-z" title="SSH compression on">${icon('zap')}</span>` : ''}`;
      el.title = `This session: ↓ ${formatBytes(t.rx)} · ↑ ${formatBytes(t.tx)} over ${t.connections} SSH connection${t.connections === 1 ? '' : 's'}${t.compress ? ' (compressed)' : ''}\nClick for data saver`;
    }
    lastTraffic = { ...t, at: now };
  } catch {}
  trafficTimer = setTimeout(pollTraffic, interval(2000));
}
const formatRate = (bps) => (bps < 1024 ? `${Math.round(bps)} B/s` : `${formatBytes(bps)}/s`);
$('#st-traffic').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const t = lastTraffic;
  contextMenu(r.left, r.top - 150, [
    { label: t ? `Session total: ↓ ${formatBytes(t.rx)}  ↑ ${formatBytes(t.tx)}` : 'Measuring…', icon: 'activity', disabled: true, action: () => {} },
    { label: getPrefs().dataSaver ? 'Turn off data saver' : 'Turn on data saver', icon: 'zap', action: () => setPrefs({ dataSaver: !getPrefs().dataSaver }) },
    { label: 'Live bandwidth of the remote…', icon: 'broadcast', action: () => openNetwork('bandwidth') },
  ]);
});
onPrefs((p, patch) => {
  if ('dataSaver' in patch) {
    syncDataSaver();
    if (session) toast(p.dataSaver ? 'Data saver on. SSH compression starts with your next connection; polling and remote desktop quality drop now.' : 'Data saver off.', 'info', 6000);
  }
});
function syncDataSaver() {
  $('#st-saver').hidden = !getPrefs().dataSaver;
  form.dataSaver.checked = getPrefs().dataSaver;
  document.documentElement.classList.toggle('data-saver', getPrefs().dataSaver);
}
$('#st-saver').addEventListener('click', () => setPrefs({ dataSaver: false }));

async function pollX11() {
  if (!session || !info.x11) {
    $('#st-x11').innerHTML = `${icon('window')}<span>X11 off</span>`;
    return;
  }
  x11State = await session.req('x11.status').catch(() => null);
  $('#st-x11').innerHTML = `${icon('window')}<span>X11 ${x11State?.ok ? 'ready' : 'no local X server'}</span>`;
  $('#st-x11').title = x11State?.ok ? `GUI apps open on ${x11State.display}` : x11State?.error || '';
  $('#st-x11').dataset.kind = x11State?.ok ? 'ok' : 'warn';
}

// ------------------------------------------------------------ lifecycle ---
// restore: { cwd, terminals, active } after a reconnect
function enterWorkspace(restore = null) {
  withTransition(() => {
    connectView.hidden = true;
    workspace.hidden = false;
  }, 'enter');
  $('#session-chip .chip-text').textContent = `${info.username}@${info.host}`;
  $('#session-chip').title = info.uname || '';
  $('#st-conn').innerHTML = `<span class="dot" data-kind="ok"></span><span>${esc(info.uname || info.host)}</span>`;
  document.title = `${info.username}@${info.host} · SSH Portal`;
  openFiles();
  if (restore?.cwd) filesView.navigate(restore.cwd);
  for (let i = 0; i < (restore?.terminals || 0); i++) openTerminal();
  const open = restore?.open || pendingOpen;
  pendingOpen = null;
  if (open === 'terminal' && !restore?.terminals) openTerminal();
  if (open === 'network') openNetwork();
  if (open === 'desktop') openDesktop();
  if (open === 'apps') openApps();
  if (open === 'system') openSystem();
  if (open === 'files') openFiles();
  if (open === 'services') openServices();
  if (open === 'logs') openLogs();
  if (open === 'docker') openDocker();
  if (open === 'devices') openDevices();
  session.addEventListener('closed', onSessionLost);
  lastTraffic = null;
  pollLatency();
  pollX11();
  pollTraffic();
  latencyTimer = setInterval(pollLatency, interval(10000));
  loadTermMod().then((m) => m.onTerminalStateChange(updateStatus));
}

// The SSH link dropped (Wi-Fi blip, remote rebooted…): offer to reconnect and
// restore the workspace layout.
async function onSessionLost() {
  if (!session) return;
  const snapshot = {
    cwd: filesView?.cwd,
    terminals: [...tabs.values()].filter((t) => t.kind === 'terminal').length,
    open: tabs.get(activeId)?.kind,
  };
  const args = lastArgs;
  leaveWorkspace();
  if (!args) return toast('The SSH connection was closed', 'error', 7000);
  const r = await modal({
    title: 'Connection lost',
    body: `<p>The connection to <b>${esc(args.username)}@${esc(args.host)}</b> was closed.</p><p class="muted small">Reconnecting reopens your folder and ${snapshot.terminals} terminal tab(s). Programs that were running in them have stopped.</p>`,
    buttons: [
      { label: 'Close', value: false },
      { label: 'Reconnect', value: true, primary: true },
    ],
  });
  if (r.value !== true) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = toast(`Reconnecting to ${args.host}… (attempt ${attempt})`, 'info', 30000);
    try {
      await openSession(args);
      t.remove();
      enterWorkspace(snapshot);
      toast('Reconnected', 'success');
      return;
    } catch (e) {
      t.remove();
      if (attempt === 3) toast(`Couldn't reconnect: ${e.message}`, 'error', 8000);
      else await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

function leaveWorkspace() {
  clearInterval(latencyTimer);
  clearTimeout(trafficTimer);
  networkView = logsView = devicesView = null;
  clearSudo();
  loadingTabs.clear();
  termMod?.setBroadcast('off');
  for (const t of tabs.values()) {
    t.view.dispose?.();
    t.view.el.remove();
    t.tabEl.remove();
  }
  tabs.clear();
  activeId = null;
  appState.desktopDisplay = null;
  filesView = appsView = null;
  const s = session;
  session = null;
  s?.close();
  withTransition(() => {
    workspace.hidden = true;
    connectView.hidden = false;
  }, 'leave');
  document.title = 'SSH Portal';
  renderProfiles();
  checkBridge();
}

async function disconnect() {
  const dirty = [...tabs.values()].some((t) => t.title.startsWith('●'));
  const terms = [...tabs.values()].filter((t) => t.kind === 'terminal').length;
  if ((dirty || terms) && !(await confirmBox('Disconnect?', dirty ? 'Some files have unsaved changes. They will be lost.' : `${terms} terminal tab(s) will be closed.`, { okLabel: 'Disconnect', danger: dirty }))) return;
  lastArgs = null; // deliberate: don't offer to reconnect
  leaveWorkspace();
}

// ------------------------------------------------------------ shortcuts ---
const typing = (el) => el?.closest?.('input, textarea, select, [contenteditable], .xterm, .dt-screen');
document.addEventListener('keydown', (e) => {
  if (workspace.hidden) return;
  const k = e.key.toLowerCase();
  if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey && !typing(e.target) && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    showShortcuts();
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'k') {
    e.preventDefault();
    showPalette();
  } else if (e.ctrlKey && e.shiftKey && k === 'p') {
    e.preventDefault();
    showPalette();
  } else if (e.altKey && e.shiftKey && e.code === 'KeyT') {
    e.preventDefault();
    openTerminal(filesCwd());
  } else if (e.altKey && e.shiftKey && e.code === 'KeyW' && activeTab()?.closable) {
    e.preventDefault();
    closeTab(activeId);
  } else if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault();
    const ids = [...$$('.tab', strip)].map((t) => t.dataset.id);
    activate(ids[(ids.indexOf(activeId) + (e.key === 'PageDown' ? 1 : -1) + ids.length) % ids.length]);
  } else if (e.altKey && !e.shiftKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
    const ids = [...$$('.tab', strip)].map((t) => t.dataset.id);
    const id = ids[+e.code.slice(5) - 1];
    if (id) {
      e.preventDefault();
      activate(id);
    }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (session) e.preventDefault();
});

// ------------------------------------------------------------ deep links ---
// ?connect=user@host[:port] (also web+ssh://user@host:port from the installed
// app's link handler) and ?open=terminal|files|network (app shortcuts).
let pendingOpen = null;
{
  const params = new URLSearchParams(location.search);
  pendingOpen = params.get('open');
  const target = params.get('connect');
  if (target) {
    const m = decodeURIComponent(target)
      .replace(/^(web\+ssh|ssh):\/\//i, '')
      .replace(/\/.*$/, '')
      .match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:@]+)(?::(\d+))?$/);
    if (m) {
      const [, user = '', host, port = '22'] = m;
      const hostname = host.replace(/^\[|\]$/g, '');
      const saved = profiles().find((p) => p.host === hostname && (!user || p.username === user) && +p.port === +port);
      form.host.value = hostname;
      form.port.value = port;
      form.username.value = user || saved?.username || '';
      if (saved) {
        form.auth.value = saved.auth || 'password';
        form.keyPath.value = saved.keyPath || '';
        form.x11.checked = saved.x11 !== false;
      }
      queueMicrotask(() => {
        syncForm();
        if (saved && saved.auth !== 'password') form.requestSubmit();
        else (form.username.value ? form.password : form.username).focus();
      });
    }
  }
  if (target || pendingOpen) history.replaceState(null, '', location.pathname);
}

// ------------------------------------------------------------------ boot ---
$('#hosted-origin').textContent = location.origin;
renderProfiles();
syncForm();
syncDataSaver();
checkBridge();
if (location.protocol === 'https:' && /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent)) $('#safari-note').hidden = false;
