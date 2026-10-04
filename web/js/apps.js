// App launcher ("start menu") for the remote machine's installed GUI apps.
// Apps run either with X11 forwarding (ssh -Y: windows open on your local X
// server) or inside the in-browser remote desktop.

import { h, $, $$, icon, esc, toast } from './ui.js';

const LIST_APPS = String.raw`for d in /usr/share/applications /usr/local/share/applications "$HOME/.local/share/applications" /var/lib/flatpak/exports/share/applications "$HOME/.local/share/flatpak/exports/share/applications" /var/lib/snapd/desktop/applications; do
  [ -d "$d" ] || continue
  for f in "$d"/*.desktop; do
    [ -f "$f" ] || continue
    awk -F= '/^\[/{s=($0=="[Desktop Entry]")} s&&/^Name=/&&!n{n=substr($0,6)} s&&/^Exec=/&&!e{e=substr($0,6)} s&&/^NoDisplay=true/{x=1} s&&/^Hidden=true/{x=1} s&&/^Terminal=true/{t=1} s&&/^Type=/{ty=substr($0,6)} s&&/^Categories=/&&!c{c=substr($0,12)} s&&/^Comment=/&&!m{m=substr($0,9)} END{if(n&&e&&!x&&(ty==""||ty=="Application"))print n"\t"e"\t"(t?1:0)"\t"c"\t"m}' "$f"
  done
done 2>/dev/null`;

const CATEGORIES = [
  ['all', 'All'],
  ['Internet', 'Internet', /Network|WebBrowser|Email|Chat/],
  ['Office', 'Office', /Office|WordProcessor|Spreadsheet/],
  ['Graphics', 'Graphics', /Graphics|Viewer/],
  ['Media', 'Media', /AudioVideo|Audio|Video|Player/],
  ['Development', 'Development', /Development|IDE|TextEditor/],
  ['System', 'System', /System|Monitor|TerminalEmulator|FileManager|Settings/],
  ['Utility', 'Accessories', /Utility|Accessories/],
  ['Game', 'Games', /Game/],
];

const HUES = [210, 160, 280, 30, 340, 120, 190, 50, 250, 0];
const hue = (s) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

export function createApps(session, info, appState, actions) {
  const el = h(`<div class="apps">
    <div class="apps-top">
      <div class="card x11-card">
        <div class="x11-head"><span class="x11-dot dot"></span><div><b>Local X server</b> <span class="muted small x11-display"></span><div class="x11-msg small muted">Checking…</div></div>
          <button class="icon-btn" data-act="x11check" title="Re-check" aria-label="Re-check X server">${icon('refresh')}</button></div>
        <details class="x11-help small"><summary>How do I get windows to appear on this computer?</summary>
          <ul>
            <li><b>Windows:</b> install <a href="https://sourceforge.net/projects/vcxsrv/" target="_blank" rel="noopener">VcXsrv</a> (run XLaunch → Multiple windows → defaults) or X410. The bridge uses <code>DISPLAY=localhost:0.0</code>.</li>
            <li><b>macOS:</b> install <a href="https://www.xquartz.org/" target="_blank" rel="noopener">XQuartz</a>, log out and back in, then start the bridge from an XQuartz terminal.</li>
            <li><b>Linux:</b> nothing to install. Start the bridge from your desktop session so <code>DISPLAY</code> is set.</li>
            <li>The remote's <code>/etc/ssh/sshd_config</code> needs <code>X11Forwarding yes</code> and the <code>xauth</code> package.</li>
            <li>No X server? Choose <b>Browser desktop</b> below to run apps inside the Desktop tab instead.</li>
          </ul>
        </details>
      </div>
      <div class="card run-card">
        <form class="run-form">
          <label class="field grow"><span>Run a command</span><input name="cmd" placeholder="e.g. firefox, gedit ~/notes.txt, xeyes" autocomplete="off" spellcheck="false"></label>
          <fieldset class="seg seg-inline"><legend class="sr-only">Where</legend>
            <label><input type="radio" name="where" value="x11" checked><span>${icon('window')} This computer (ssh -Y)</span></label>
            <label><input type="radio" name="where" value="desktop"><span>${icon('monitor')} Browser desktop</span></label>
          </fieldset>
          <button class="btn btn-primary">${icon('play')} Run</button>
        </form>
      </div>
    </div>
    <div class="apps-main">
      <section class="launcher">
        <div class="launcher-head">
          <label class="search-box">${icon('search')}<input type="search" placeholder="Search applications" class="app-search" aria-label="Search applications"></label>
          <div class="chips">${CATEGORIES.map(([k, l], i) => `<button class="chip${i ? '' : ' on'}" data-cat="${k}">${l}</button>`).join('')}</div>
        </div>
        <div class="app-grid"><p class="muted">Loading installed applications…</p></div>
      </section>
      <aside class="running">
        <h3>Running from here</h3>
        <div class="run-list"><p class="muted small">Apps launched with ssh -Y show up here with their output.</p></div>
      </aside>
    </div>
  </div>`);

  const grid = $('.app-grid', el);
  const runList = $('.run-list', el);
  let apps = [];
  let cat = 'all';
  let x11ok = false;

  async function checkX11() {
    const st = await session.req('x11.status').catch((e) => ({ ok: false, error: e.message }));
    x11ok = st.ok;
    $('.x11-dot', el).dataset.kind = st.ok ? 'ok' : 'err';
    $('.x11-display', el).textContent = st.display ? `DISPLAY=${st.display}` : '';
    $('.x11-msg', el).textContent = st.ok ? `Ready${st.auth ? ' (xauth cookie found)' : ''}. GUI apps from terminals and this launcher open as windows on this computer.` : st.error;
    $('.x11-help', el).open = !st.ok;
  }

  async function loadApps() {
    try {
      const r = await session.req('exec', { command: LIST_APPS, timeout: 20000 });
      const seen = new Set();
      apps = r.stdout
        .split('\n')
        .map((l) => l.split('\t'))
        .filter((p) => p.length >= 2 && p[0] && p[1])
        .map(([name, exec, term, cats = '', comment = '']) => ({ name, exec: exec.replace(/\s+%[a-zA-Z]/g, '').replace(/%%/g, '%').trim(), terminal: term === '1', cats, comment }))
        .filter((a) => !seen.has(a.name) && seen.add(a.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      renderApps();
    } catch (e) {
      grid.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  function renderApps() {
    const q = $('.app-search', el).value.trim().toLowerCase();
    const re = CATEGORIES.find((c) => c[0] === cat)?.[2];
    const list = apps.filter((a) => (!re || re.test(a.cats)) && (!q || `${a.name} ${a.comment} ${a.exec}`.toLowerCase().includes(q)));
    grid.innerHTML = list.length
      ? list
          .map(
            (a, i) => `<button class="app" data-i="${apps.indexOf(a)}" title="${esc(a.comment || a.exec)}">
              <span class="app-ic" style="--h:${hue(a.name)}">${a.terminal ? icon('terminal') : esc(a.name.trim()[0]?.toUpperCase() || '?')}</span>
              <span class="app-name">${esc(a.name)}</span></button>`,
          )
          .join('')
      : `<p class="muted">${apps.length ? 'No matching applications.' : 'No desktop applications found on the remote (no .desktop files). You can still run any command above.'}</p>`;
  }

  async function launch(command, target, name = command) {
    if (target === 'desktop' && appState.desktopDisplay == null) {
      toast('Start the remote desktop first (Desktop tab), or choose “This computer”.', 'error');
      return actions.showDesktop();
    }
    if (target === 'x11' && !x11ok) toast('No local X server detected; the app may fail to open. See the help above.', 'error');
    try {
      if (target === 'desktop') {
        await session.launchApp(command, 'desktop', appState.desktopDisplay);
        toast(`Started ${name} on the browser desktop`);
        return actions.showDesktop();
      }
      const item = h(`<div class="proc"><div class="proc-head"><span class="dot" data-kind="ok"></span><b class="proc-name">${esc(name)}</b>
        <button class="icon-btn" data-act="kill" title="Stop" aria-label="Stop ${esc(name)}">${icon('stop')}</button></div>
        <details><summary class="small muted">output</summary><pre class="proc-out mono"></pre></details></div>`);
      runList.querySelector('p')?.remove();
      runList.prepend(item);
      const out = $('.proc-out', item);
      const res = await session.launchApp(
        command,
        'x11',
        null,
        (d) => {
          out.textContent = (out.textContent + d).slice(-20000);
        },
        (m) => {
          $('.dot', item).dataset.kind = m.code ? 'err' : '';
          $('[data-act="kill"]', item).innerHTML = icon('x');
          $('[data-act="kill"]', item).title = 'Remove';
          item.dataset.done = '1';
          if (m.code && m.code !== 0) {
            $('details', item).open = true;
            out.textContent += `\n[exited with code ${m.code}]`;
          }
        },
      );
      $('[data-act="kill"]', item).addEventListener('click', () => (item.dataset.done ? item.remove() : session.req('app.kill', { aid: res.aid })));
      toast(`Launched ${name} — its window opens on this computer`);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  $('.run-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.cmd.value.trim()) launch(f.cmd.value.trim(), f.where.value);
  });
  $('.app-search', el).addEventListener('input', renderApps);
  el.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (chip) {
      cat = chip.dataset.cat;
      $$('.chip', el).forEach((c) => c.classList.toggle('on', c === chip));
      renderApps();
    }
    if (e.target.closest('[data-act="x11check"]')) checkX11();
    const appBtn = e.target.closest('.app');
    if (appBtn) {
      const a = apps[appBtn.dataset.i];
      if (a.terminal) actions.openTerminal(null, a.exec, a.name);
      else launch(a.exec, $('.run-form', el).where.value, a.name);
    }
  });

  let loaded = false;
  return {
    el,
    launch,
    show() {
      if (!loaded) {
        loaded = true;
        checkX11();
        loadApps();
      }
    },
  };
}
