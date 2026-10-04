// Guided setup for the local bridge: detect it, help install it (one download
// or one command), start it via sshportal://, and pair with one click.

import { REPO, BRIDGE_VERSION } from './config.js';
import { probeBridge } from './bridge.js';
import { $, $$, h, icon, esc, toast } from './ui.js';

const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

function detectOS() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'macos';
  return 'linux';
}

const older = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

export function createBridgeSetup({ settings, LS, onChange }) {
  const card = $('#bridge-card');
  const body = $('#bp-body');
  const pill = $('#bridge-status');
  let state = 'checking';
  let health = null;
  let info = null; // /api/info once paired
  let os = detectOS();
  let pollTimer = null;
  let launching = false;

  const bridgeOrigin = () => new URL(settings.bridge).origin;
  const servedByBridge = () => location.origin === bridgeOrigin();
  const siteBase = () => new URL('.', location.href).href;

  function repo() {
    if (REPO) return REPO;
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (m) return `${m[1]}/${location.pathname.split('/').filter(Boolean)[0] || location.hostname}`;
    return health?.repo || LS.get('repo', '');
  }
  const asset = (name) => `https://github.com/${repo()}/releases/latest/download/${name}`;

  async function api(path, method = 'GET') {
    const r = await fetch(`${settings.bridge}${path}`, { method, headers: { authorization: `Bearer ${settings.token}` }, cache: 'no-store' });
    if (r.status === 401) throw Object.assign(new Error('Not paired'), { unpaired: true });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  // ---------------------------------------------------------------- check ---
  async function check() {
    // The copy of the app a bridge serves itself talks to that same bridge,
    // unless an address was chosen explicitly under Advanced.
    if (!LS.get('bridge', null) && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) && location.origin !== bridgeOrigin()) {
      const own = await probeBridge(location.origin);
      if (own) settings.bridge = location.origin;
    }
    health = await probeBridge(settings.bridge);
    if (!health) {
      info = null;
      return setState('missing');
    }
    LS.set('bridgeSeen', true);
    if (health.repo) LS.set('repo', health.repo);
    if (!settings.token && servedByBridge()) {
      // the bridge's own copy of the app pairs itself
      const r = await fetch('/local-token').then((x) => x.json()).catch(() => null);
      if (r?.token) saveToken(r.token);
    }
    if (!settings.token) return setState('unpaired');
    try {
      info = await api('/api/info');
      setState('ready');
    } catch (e) {
      info = null;
      setState(e.unpaired ? 'unpaired' : 'missing');
    }
  }

  function saveToken(t) {
    settings.token = t;
    LS.set('token', t);
  }

  let renderedKey = '';
  function setState(s) {
    const changed = s !== state;
    state = s;
    // re-render only on real changes, so buttons don't move under the cursor
    const key = `${state}|${health?.version}|${info?.autostart}|${info?.standalone}`;
    if (key !== renderedKey) {
      renderedKey = key;
      render();
    }
    schedulePoll();
    if (changed) onChange?.(state);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (state === 'ready') return;
    pollTimer = setTimeout(() => {
      if (!card.isConnected || card.closest('[hidden]')) return schedulePoll();
      check();
    }, state === 'missing' ? 2000 : 4000);
  }

  // --------------------------------------------------------------- render ---
  const PILL = {
    checking: ['busy', 'Looking for it…'],
    missing: ['err', 'Not running'],
    unpaired: ['warn', 'Found · not paired'],
    ready: ['ok', 'Ready'],
  };

  function render() {
    card.dataset.state = state;
    const [kind, text] = PILL[state];
    pill.innerHTML = `<span class="dot" data-kind="${kind}"></span>${text}`;
    if (state === 'checking') body.innerHTML = `<p class="muted bp-line"><span class="spinner"></span>Looking for the bridge on this computer…</p>`;
    if (state === 'missing') body.replaceChildren(missingView());
    if (state === 'unpaired') body.replaceChildren(unpairedView());
    if (state === 'ready') body.replaceChildren(readyView());
  }

  function missingView() {
    const seen = LS.get('bridgeSeen', false);
    const canLaunch = seen && os !== 'macos';
    const el = h(`<div class="setup">
      ${
        seen
          ? `<div class="bp-row"><p class="bp-line">${icon('power')}<span>The bridge isn't running right now.</span></p>
              ${canLaunch ? `<button class="btn btn-primary btn-sm" data-act="launch">${icon('play')} Start bridge</button>` : ''}</div>
             ${os === 'macos' ? `<p class="small muted">Start it from Terminal: <code>~/.ssh-portal/bin/ssh-portal-bridge --install</code></p>` : ''}`
          : `<p class="setup-lead">SSH Portal needs a small helper on this computer to reach your network. <b>Set it up once</b>: after that it starts with your computer and this page finds it by itself.</p>`
      }
      ${seen ? `<details class="reinstall"><summary>Install or reinstall</summary></details>` : ''}
      <div class="waiting small muted"><span class="spinner"></span>Waiting for the bridge… this page connects automatically.</div>
    </div>`);
    const steps = installSteps();
    if (seen) $('.reinstall', el).append(steps);
    else el.insertBefore(steps, $('.waiting', el));
    return el;
  }

  function installSteps() {
    const wrap = h(`<div class="install">
      <div class="os-tabs" role="tablist" aria-label="Your system">
        ${Object.entries(OS_NAMES).map(([k, n]) => `<button role="tab" type="button" data-os="${k}" aria-selected="${k === os}" class="${k === os ? 'on' : ''}">${n}</button>`).join('')}
      </div>
      <div class="os-steps"></div>
    </div>`);
    const stepsEl = $('.os-steps', wrap);
    const r = repo();
    const step = (n, title, content = '') => `<li><span class="num">${n}</span><div><b>${title}</b>${content}</div></li>`;
    const cmd = (text) => `<div class="cmd"><code>${esc(text)}</code><button type="button" class="icon-btn sm" data-copy="${esc(text)}" title="Copy" aria-label="Copy command">${icon('copy')}</button></div>`;

    if (!r) {
      stepsEl.innerHTML = `<ol class="steps">
        ${step(1, 'Install Node.js 18+', '<small>from <a href="https://nodejs.org/" target="_blank" rel="noopener">nodejs.org</a></small>')}
        ${step(2, 'In the project\'s <code>bridge</code> folder run', cmd('npm install && npm start'))}
        ${step(3, 'Come back here', '<small>This page finds it by itself.</small>')}
      </ol>
      <p class="small muted">Downloads appear here once the app is hosted on GitHub Pages (or <code>REPO</code> is set in <code>js/config.js</code>).</p>`;
    } else if (os === 'windows') {
      const url = asset('ssh-portal-bridge-windows-x64.exe');
      stepsEl.innerHTML = `<ol class="steps">
        ${step(1, 'Download the bridge', `<a class="btn btn-primary dl-btn" href="${esc(url)}" download>${icon('download')} Download for Windows</a><small>ssh-portal-bridge-windows-x64.exe · about 90 MB · no Node.js needed</small>`)}
        ${step(2, 'Open the downloaded file', '<small>If Windows SmartScreen appears, click <b>More info</b>, then <b>Run anyway</b>. No admin rights needed; it installs just for you.</small>')}
        ${step(3, 'Come back here', '<small>This page connects by itself.</small>')}
      </ol>
      <details class="alt"><summary>Prefer PowerShell?</summary>${cmd(`$env:SSH_PORTAL_REPO='${r}'; irm ${siteBase()}install.ps1 | iex`)}</details>`;
    } else {
      const pre = os === 'macos' ? 'macos' : 'linux';
      stepsEl.innerHTML = `<ol class="steps">
        ${step(1, `Open ${os === 'macos' ? 'Terminal' : 'a terminal'} and paste`, cmd(`curl -fsSL ${siteBase()}install.sh | sh -s ${r}`))}
        ${step(2, 'Come back here', '<small>The bridge installs for your user, starts now and at every login, and this page connects by itself.</small>')}
      </ol>
      <details class="alt"><summary>Download the file instead</summary>
        <p class="small">${['arm64', 'x64'].map((a) => `<a href="${esc(asset(`ssh-portal-bridge-${pre}-${a}`))}">${OS_NAMES[os]} ${a === 'arm64' ? (os === 'macos' ? 'Apple Silicon' : 'ARM64') : os === 'macos' ? 'Intel' : 'x64'}</a>`).join(' · ')}</p>
        <p class="small muted">Then run <code>chmod +x ssh-portal-bridge-*</code> and start it once with <code>./ssh-portal-bridge-${pre}-… --install</code>.${os === 'macos' ? ' If macOS blocks it, right-click it in Finder and choose Open.' : ''}</p>
      </details>`;
    }
    stepsEl.insertAdjacentHTML(
      'beforeend',
      `<details class="alt"><summary>Run from source with Node.js</summary><p class="small muted">Clone the repository, then in <code>bridge/</code>:</p>${cmd('npm install && npm start')}</details>`,
    );
    return wrap;
  }

  function unpairedView() {
    return h(`<div class="setup">
      <p class="bp-line">${icon('check')}<span>Bridge v${esc(health.version)} is running on this computer.</span></p>
      <button class="btn btn-primary" data-act="pair">${icon('link')} Pair this browser</button>
      <p class="small muted">A small window from the bridge asks you to confirm. You only do this once per browser.</p>
    </div>`);
  }

  function readyView() {
    const outdated = older(health.version, BRIDGE_VERSION);
    const el = h(`<div class="setup">
      <div class="bp-row">
        <p class="bp-line">${icon('check')}<span>Bridge v${esc(health.version)} is running and paired.</span></p>
        <div class="btn-group">
          <button class="icon-btn sm" data-act="stop" title="Stop the bridge" aria-label="Stop the bridge">${icon('power')}</button>
          <button class="icon-btn sm" data-act="unpair" title="Unpair this browser" aria-label="Unpair this browser">${icon('x')}</button>
        </div>
      </div>
      ${info?.standalone ? `<label class="switch small"><input type="checkbox" data-act="autostart" ${info.autostart ? 'checked' : ''}><span></span>Start the bridge when I log in</label>` : ''}
      ${outdated ? `<details class="update callout"><summary>Update available: v${BRIDGE_VERSION}</summary></details>` : ''}
    </div>`);
    if (outdated) $('.update', el).append(installSteps());
    return el;
  }

  // -------------------------------------------------------------- actions ---
  // sshportal:// is registered by the installed bridge (Windows, Linux).
  async function launch() {
    if (launching) return false;
    launching = true;
    const frame = h('<iframe hidden title="Start bridge"></iframe>');
    document.body.append(frame);
    frame.src = 'sshportal://start';
    setTimeout(() => frame.remove(), 3000);
    pill.innerHTML = `<span class="dot" data-kind="busy"></span>Starting…`;
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probeBridge(settings.bridge)) break;
    }
    launching = false;
    renderedKey = ''; // the pill was changed by hand above
    await check();
    if (state === 'missing') toast('The bridge didn\'t start. If your browser asked, allow it to open "SSH Portal Bridge", or reinstall it below.', 'error', 8000);
    return state !== 'missing';
  }

  function pair() {
    const back = location.origin + location.pathname + location.search;
    const w = window.open(`${settings.bridge}/pair?origin=${encodeURIComponent(location.origin)}&return=${encodeURIComponent(back)}`, 'ssh-portal-pair', 'popup,width=440,height=520');
    if (!w) toast('Allow pop-ups for this page to pair, or paste the token under Advanced.', 'error', 7000);
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== bridgeOrigin() || e.data?.type !== 'ssh-portal-pair' || typeof e.data.token !== 'string') return;
    saveToken(e.data.token);
    toast('This browser is paired with the bridge', 'success');
    check();
  });
  window.addEventListener('focus', () => state !== 'ready' && check());

  body.addEventListener('click', async (e) => {
    const osBtn = e.target.closest('[data-os]');
    if (osBtn) {
      os = osBtn.dataset.os;
      const holder = osBtn.closest('.install');
      holder.replaceWith(installSteps());
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copy).then(() => {
        copy.innerHTML = icon('check');
        setTimeout(() => (copy.innerHTML = icon('copy')), 1500);
      });
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'launch') launch();
    if (act === 'pair') pair();
    if (act === 'unpair') {
      saveToken('');
      check();
    }
    if (act === 'stop') {
      await api('/api/quit', 'POST').catch(() => {});
      setTimeout(check, 800);
      toast('Bridge stopped');
    }
  });
  body.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'autostart') return;
    try {
      const r = await api(`/api/autostart?enabled=${e.target.checked ? 1 : 0}`, 'POST');
      e.target.checked = r.autostart;
      toast(r.autostart ? 'The bridge will start when you log in' : 'The bridge won\'t start at login', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  render();
  return {
    check,
    get state() {
      return state;
    },
    // Called from the Connect button (a user gesture, so sshportal:// may open).
    async ensureReady() {
      if (state !== 'ready') await check();
      if (state === 'missing' && LS.get('bridgeSeen', false) && os !== 'macos') await launch();
      if (state === 'unpaired') pair();
      if (state !== 'ready') card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return state === 'ready';
    },
  };
}
