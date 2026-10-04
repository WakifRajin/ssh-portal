import { DEFAULT_BRIDGE, BridgeSession } from './bridge.js';
import { createBridgeSetup } from './bridge-setup.js';
import { $, $$, h, icon, esc, toast, modal, confirmBox, promptBox, contextMenu } from './ui.js';
import { createFileExplorer } from './files.js';
import { createEditor } from './editor.js';
import { createApps } from './apps.js';
import { createSystem } from './system.js';
import { openPalette } from './palette.js';

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

// ------------------------------------------------------------------ theme ---
function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
function syncThemeIcons() {
  const next = currentTheme() === 'dark' ? 'sun' : 'moon';
  for (const b of $$('[data-action="theme"]')) b.innerHTML = icon(next);
}
function toggleTheme() {
  const t = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  LS.set('theme', t);
  syncThemeIcons();
}
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
        <button type="button" class="icon-btn sm" data-del="${i}" aria-label="Forget ${esc(p.name || p.host)}" title="Forget">${icon('x')}</button></li>`,
    )
    .join('');
}
$('#profile-list').addEventListener('click', (e) => {
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
  for (const k of ['host', 'port', 'username', 'keyPath', 'name']) form[k].value = p[k] ?? '';
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
form.addEventListener('change', syncForm);
$('#key-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) form.privateKey.value = await f.text();
});

const connectLabel = () => `${icon('plug')}<span>Connect</span>`;
$('#connect-btn').innerHTML = connectLabel();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  const btn = $('#connect-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span><span>Connecting to ${esc(v.host)}…</span>`;
  try {
    if (!(await bridgeSetup.ensureReady())) {
      throw new Error(bridgeSetup.state === 'unpaired' ? 'Pair this browser with the bridge first (see the Bridge panel).' : "The bridge isn't running yet. Follow the steps in the Bridge panel.");
    }
    session = new BridgeSession(settings.bridge, settings.token);
    session.onHostKey = hostKeyDialog;
    session.onPrompt = promptDialog;
    await session.open();
    const args = { host: v.host.trim(), port: +v.port || 22, username: v.username.trim(), x11: form.x11.checked, agent: v.auth !== 'key' };
    if (v.auth === 'password') args.password = v.password;
    if (v.auth === 'key') {
      if (v.privateKey.trim()) args.privateKey = v.privateKey;
      else if (v.keyPath.trim()) args.keyPath = v.keyPath.trim();
      args.passphrase = v.passphrase;
    }
    info = await session.req('connect', args);
    info.x11 = form.x11.checked;
    if (form.save.checked) {
      const ps = profiles().filter((p) => !(p.host === args.host && p.username === args.username && +p.port === args.port));
      ps.unshift({ name: v.name, host: args.host, port: args.port, username: args.username, auth: v.auth, keyPath: v.keyPath, x11: form.x11.checked });
      LS.set('profiles', ps.slice(0, 12));
    }
    form.password.value = '';
    form.passphrase.value = '';
    enterWorkspace();
  } catch (err) {
    session?.close();
    session = null;
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
  if (t.kind === 'terminal' && t.view.paneCount > 1 && !(await confirmBox('Close tab?', `This tab has ${t.view.paneCount} terminals. Close all of them?`, { okLabel: 'Close tab', danger: true }))) return;
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
  else activate(tab.dataset.id);
});
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

function openFiles() {
  if (tabs.has('files')) return activate('files');
  filesView = createFileExplorer(session, info, actions);
  addTab({ id: 'files', title: 'Files', iconName: 'folder', view: filesView, closable: false });
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

const actions = {
  openTerminal: (cwd, command, title) => openTerminal(cwd, command, title),
  openEditor,
  showDesktop: openDesktop,
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
    ({ files: openFiles, terminal: () => openTerminal(filesCwd()), desktop: openDesktop, apps: openApps, system: openSystem })[open]?.();
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'theme') toggleTheme();
  if (action === 'palette') showPalette();
  if (action === 'term-settings') loadTermMod().then((m) => m.openTerminalSettings());
  if (action === 'disconnect') disconnect();
});

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
    { group: 'Go to', title: 'Folder…', icon: 'folder', run: async () => { const p = await promptBox('Go to folder', 'Path on the remote', filesView?.cwd || info.home); if (p) { openFiles(); filesView.navigate(p.replace(/^~(?=\/|$)/, info.home)); } } },
    ...[...tabs.values()].map((t) => ({ group: 'Open tabs', title: `Switch to: ${t.title}`, icon: t.iconName, run: () => activate(t.id) })),
    { group: 'Session', title: 'Toggle light / dark theme', icon: currentTheme() === 'dark' ? 'sun' : 'moon', run: toggleTheme },
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
function enterWorkspace() {
  connectView.hidden = true;
  workspace.hidden = false;
  $('#session-chip .chip-text').textContent = `${info.username}@${info.host}`;
  $('#session-chip').title = info.uname || '';
  $('#st-conn').innerHTML = `<span class="dot" data-kind="ok"></span><span>${esc(info.uname || info.host)}</span>`;
  document.title = `${info.username}@${info.host} · SSH Portal`;
  openFiles();
  session.addEventListener('closed', onSessionLost);
  pollLatency();
  pollX11();
  latencyTimer = setInterval(pollLatency, 10000);
  loadTermMod().then((m) => m.onTerminalStateChange(updateStatus));
}

function onSessionLost() {
  if (!session) return;
  toast('The SSH connection was closed', 'error', 7000);
  leaveWorkspace();
}

function leaveWorkspace() {
  clearInterval(latencyTimer);
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
  workspace.hidden = true;
  connectView.hidden = false;
  document.title = 'SSH Portal';
  renderProfiles();
  checkBridge();
}

async function disconnect() {
  const dirty = [...tabs.values()].some((t) => t.title.startsWith('●'));
  const terms = [...tabs.values()].filter((t) => t.kind === 'terminal').length;
  if ((dirty || terms) && !(await confirmBox('Disconnect?', dirty ? 'Some files have unsaved changes. They will be lost.' : `${terms} terminal tab(s) will be closed.`, { okLabel: 'Disconnect', danger: dirty }))) return;
  leaveWorkspace();
}

// ------------------------------------------------------------ shortcuts ---
document.addEventListener('keydown', (e) => {
  if (workspace.hidden) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'k') {
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

// ------------------------------------------------------------------ boot ---
$('#hosted-origin').textContent = location.origin;
renderProfiles();
syncForm();
checkBridge();
if (location.protocol === 'https:' && /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent)) $('#safari-note').hidden = false;
