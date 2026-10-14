// Docker: containers, images, volumes and networks of the remote host
// (works with Podman too: the bridge reports which runtime it found).

import { h, $, icon, esc, toast, modal, confirmBox, contextMenu, formatDate } from './ui.js';
import { uid, segHtml, cmdBlock, bindCopy, emptyState, loadingHtml } from './kit.js';
import { interval } from './prefs.js';
import { withSudo, isCancelled } from './sudo.js';
import { createLogView } from './logs.js';

const TABS = [['containers', 'Containers'], ['images', 'Images'], ['volumes', 'Volumes'], ['networks', 'Networks']];
const STATES = {
  running: ['ok', 'Running'],
  paused: ['warn', 'Paused'],
  restarting: ['warn', 'Restarting'],
  removing: ['warn', 'Removing'],
  exited: ['', 'Stopped'],
  created: ['', 'Created'],
  dead: ['bad', 'Dead'],
};
const VERB = { start: 'Start', stop: 'Stop', restart: 'Restart', pause: 'Pause', unpause: 'Resume', kill: 'Force stop', rm: 'Remove', rmi: 'Remove image' };
const DONE = { start: 'started', stop: 'stopped', restart: 'restarted', pause: 'paused', unpause: 'resumed', kill: 'force-stopped', rm: 'removed', rmi: 'removed' };
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const isUp = (c) => ['running', 'paused', 'restarting'].includes(c.state);
const shortId = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);

// "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 5432/tcp" -> [{host, container, proto}]
function parsePorts(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text || '').split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(?:.*:)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)$/);
    let item;
    if (m) item = { host: m[2] ? null : Number(m[1]), label: m[2] ? `${m[1]}-${m[2]}` : m[1], container: m[4] ? `${m[3]}-${m[4]}` : m[3], proto: m[5] };
    else {
      const u = p.match(/^(\d+)(?:-(\d+))?\/(\w+)$/);
      item = { host: null, label: null, container: u ? (u[2] ? `${u[1]}-${u[2]}` : u[1]) : p, proto: u?.[3] || '' };
    }
    const key = `${item.label}:${item.container}/${item.proto}`; // IPv4 and IPv6 bindings repeat
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

const fmtCreated = (v) => {
  if (typeof v === 'number') return formatDate(v);
  const s = String(v ?? '');
  if (/^\d{4}-\d\d-\d\d/.test(s)) {
    const d = new Date(s.replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }
  return s;
};
const pctNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function createDocker(session, info, actions) {
  const sname = uid('dk');
  const el = h(`<div class="dk">
    <div class="dk-top">
      <div class="dk-head">
        <h2 class="dk-title">${icon('box')}<span>Docker</span></h2>
        <span class="dk-counts small muted"></span>
        <span class="spacer"></span>
        <label class="search-box dk-search">${icon('search')}<input type="search" placeholder="Search" aria-label="Search"></label>
        <button type="button" class="btn btn-sm" data-act="refresh" title="Reload now">${icon('refresh')} Refresh</button>
      </div>
      <div class="dk-nav">${segHtml(`${sname}-tab`, TABS, 'containers', 'Docker sections')}<div class="chips dk-chips"></div></div>
    </div>
    <div class="dk-body"><div class="dk-main"></div><aside class="dk-drawer" hidden aria-label="Container logs"></aside></div>
  </div>`);
  bindCopy(el);

  const main = $('.dk-main', el);
  const drawer = $('.dk-drawer', el);
  let data = null;
  let fetchError = '';
  let tab = 'containers';
  let stateFilter = 'all';
  let q = '';
  let sudoPw = null; // memory only; set by "Use sudo for now"
  let visible = false;
  let loading = false;
  let timer = null;
  let logView = null;
  let logId = null;
  let tabHtml = '';
  const cards = new Map(); // container id -> element
  const busy = new Set();
  let cardWrap = null;

  const runtime = () => data?.runtime || 'docker';
  const runtimeName = () => (runtime() === 'podman' ? 'Podman' : 'Docker');

  // Bridge calls that may need the sudo password (only when the user opted in
  // or the bridge asks for it).
  const call = (op, args, reason) =>
    withSudo(
      session,
      async (pw) => {
        const p = pw ?? sudoPw;
        const r = await session.req(op, p ? { ...args, sudoPassword: p } : args);
        if (pw) sudoPw = pw;
        return r;
      },
      { reason },
    );

  // ----------------------------------------------------------------- data ---
  async function fetchList({ silent = true } = {}) {
    if (loading) return;
    loading = true;
    if (!silent && !data) main.innerHTML = loadingHtml(`Looking for ${runtimeName()}…`);
    try {
      const r = await session.req('docker.list', sudoPw ? { sudoPassword: sudoPw } : {});
      data = r;
      fetchError = '';
    } catch (e) {
      if (/^SUDO_/.test(e.message)) {
        sudoPw = null; // stored password no longer works
        fetchError = 'PERMISSION';
        data = { runtime: data?.runtime || null, error: 'PERMISSION', containers: [], images: [], volumes: [], networks: [] };
      } else {
        fetchError = e.message;
        if (!data) data = { runtime: null, error: e.message, containers: [], images: [], volumes: [], networks: [] };
        else data = { ...data, error: e.message };
      }
    } finally {
      loading = false;
    }
    render();
  }

  // ---------------------------------------------------------------- render ---
  function renderHeader() {
    const cs = data?.containers || [];
    $('.dk-title span', el).textContent = runtimeName();
    $('.dk-counts', el).innerHTML = data && !data.error ? `${cs.filter((c) => c.state === 'running').length} of ${cs.length} containers running · ${(data.images || []).length} images${sudoPw ? ' · <span class="pill sm warn">using sudo</span>' : ''}` : '';
    $('.dk-nav', el).hidden = !!data?.error || !data;
    $('.dk-search', el).hidden = !!data?.error || !data;
    $('.dk-chips', el).hidden = tab !== 'containers';
    $('.dk-chips', el).innerHTML = [['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped']].map(([k, l]) => `<button type="button" class="chip ${stateFilter === k ? 'on' : ''}" data-sf="${k}">${l}</button>`).join('');
  }

  function errorCard() {
    const host = esc(info.host);
    switch (data.error) {
      case 'NOT_INSTALLED':
        return emptyState({
          icon: 'box',
          title: `Docker isn't installed on ${host}`,
          body: `<p>Install it with this command, then press <b>Refresh</b>.</p>${cmdBlock('curl -fsSL https://get.docker.com | sh')}<p class="muted small">Podman works too: if it is installed, this panel finds it automatically.</p>`,
          actions: `<button type="button" class="btn" data-act="refresh">${icon('refresh')} Check again</button>`,
        });
      case 'PERMISSION':
        return emptyState({
          icon: 'lock',
          title: `Your account can't use ${runtimeName()} yet`,
          body: `<p>${runtimeName()} is installed, but the user <b>${esc(info.username)}</b> isn't allowed to talk to it. Add the account to the <code>docker</code> group, then <b>disconnect and reconnect</b> so it takes effect:</p>${cmdBlock('sudo usermod -aG docker $USER')}<p class="muted small">Don't want to change anything? You can use administrator rights for this session instead.</p>`,
          actions: `<button type="button" class="btn btn-primary" data-act="use-sudo">${icon('lock')} Use sudo for now</button><button type="button" class="btn" data-act="refresh">${icon('refresh')} Check again</button>`,
        });
      case 'DAEMON_DOWN':
        return emptyState({
          icon: 'power',
          kind: 'warn',
          title: `${runtimeName()} is installed but not running`,
          body: `<p>The ${runtimeName()} service is stopped on ${host}. Start it here, or run this in a terminal:</p>${cmdBlock('sudo systemctl start docker')}`,
          actions: `<button type="button" class="btn btn-primary" data-act="start-docker">${icon('play')} Start ${runtimeName()}</button><button type="button" class="btn" data-act="refresh">${icon('refresh')} Check again</button>`,
        });
      default:
        return emptyState({ icon: 'alert', kind: 'err', title: `Couldn't read ${runtimeName()}`, body: `<p>${esc(data.error)}</p>`, actions: `<button type="button" class="btn btn-primary" data-act="refresh">${icon('refresh')} Try again</button>` });
    }
  }

  function render() {
    renderHeader();
    if (!data) return;
    if (data.error) {
      closeDrawer();
      cardWrap = null;
      const html = errorCard();
      if (html !== tabHtml) main.innerHTML = tabHtml = html;
      return;
    }
    const ql = q.toLowerCase();
    if (tab === 'containers') return renderContainers(ql);
    cardWrap = null;
    let html;
    if (tab === 'images') html = imagesHtml(ql);
    else if (tab === 'volumes') html = tableHtml(['Name', 'Driver'], (data.volumes || []).filter((v) => !ql || `${v.name} ${v.driver}`.toLowerCase().includes(ql)).map((v) => [`<span class="mono">${esc(v.name)}</span>`, esc(v.driver)]), 'No volumes', 'Volumes keep data that should outlive a container.');
    else html = tableHtml(['Name', 'Driver', 'Scope', 'ID'], (data.networks || []).filter((n) => !ql || `${n.name} ${n.driver} ${n.scope}`.toLowerCase().includes(ql)).map((n) => [`<b>${esc(n.name)}</b>`, esc(n.driver), esc(n.scope), `<span class="mono muted">${esc(shortId(n.id))}</span>`]), 'No networks', '');
    if (html !== tabHtml) main.innerHTML = tabHtml = html;
  }

  function tableHtml(head, rows, emptyTitle, emptyBody) {
    if (!rows.length) return emptyState({ icon: 'layers', title: q ? 'Nothing matches your search' : emptyTitle, body: q ? '' : emptyBody ? `<p>${esc(emptyBody)}</p>` : '' });
    return `<div class="card dk-table"><div class="table-wrap"><table><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }

  function imagesHtml(ql) {
    const used = new Set((data.containers || []).map((c) => c.image));
    const rows = (data.images || [])
      .filter((i) => !ql || `${i.repo} ${i.tag} ${i.id}`.toLowerCase().includes(ql))
      .map((i) => {
        const ref = i.repo && i.repo !== '<none>' ? `${i.repo}:${i.tag}` : shortId(i.id);
        const inUse = used.has(`${i.repo}:${i.tag}`) || used.has(i.repo) || used.has(shortId(i.id));
        return [
          `<b>${esc(ref)}</b>${inUse ? ' <span class="pill sm ok">In use</span>' : ''}`,
          `<span class="mono muted">${esc(shortId(i.id))}</span>`,
          esc(i.size),
          esc(fmtCreated(i.created)),
          `<button type="button" class="btn btn-sm btn-danger" data-img-rm="${esc(i.id)}" data-ref="${esc(ref)}" ${inUse ? 'disabled title="A container uses this image. Remove the container first."' : ''}>${icon('trash')} Remove</button>`,
        ];
      });
    return tableHtml(['Image', 'ID', 'Size', 'Created', ''], rows, 'No images yet', 'Images are downloaded automatically the first time you run a container.');
  }

  // ------------------------------------------------------------ containers ---
  const matchC = (c, ql) => {
    if (stateFilter === 'running' && !isUp(c)) return false;
    if (stateFilter === 'stopped' && isUp(c)) return false;
    return !ql || `${c.name} ${c.image} ${c.id} ${c.ports}`.toLowerCase().includes(ql);
  };

  function renderContainers(ql) {
    const all = data.containers || [];
    for (const id of [...cards.keys()]) if (!all.some((c) => c.id === id)) (cards.get(id).remove(), cards.delete(id));
    const list = all.filter((c) => matchC(c, ql)).sort((a, b) => isUp(b) - isUp(a) || a.name.localeCompare(b.name));
    if (!cardWrap || !main.contains(cardWrap)) {
      tabHtml = '';
      main.innerHTML = '<div class="dk-cards"></div>';
      cardWrap = main.firstElementChild;
    }
    $('.dk-empty', main)?.remove();
    if (!list.length) {
      for (const c of cards.values()) c.remove();
      cardWrap.insertAdjacentHTML(
        'afterend',
        `<div class="dk-empty">${
          all.length
            ? emptyState({ icon: 'search', title: 'No containers match', body: '<p>Try a different search or filter.</p>' })
            : emptyState({ icon: 'box', title: 'No containers yet', body: `<p>Start your first one from a terminal, for example:</p>${cmdBlock(`${runtime()} run -d --name web -p 8080:80 nginx`)}<p class="muted small">It will show up here within a few seconds.</p>` })
        }</div>`,
      );
      return;
    }
    list.forEach((c, i) => {
      let card = cards.get(c.id);
      if (!card) {
        card = makeCard(c);
        cards.set(c.id, card);
      }
      updateCard(card, c);
      if (cardWrap.children[i] !== card) cardWrap.insertBefore(card, cardWrap.children[i] || null); // only moves when the order changed
    });
    while (cardWrap.children.length > list.length) cardWrap.lastElementChild.remove();
  }

  function makeCard() {
    return h(`<article class="card dk-card">
      <div class="dk-card-head"><div class="dk-names"><b class="dk-name"></b><span class="dk-image mono small muted"></span></div><span class="dk-badge pill"></span></div>
      <div class="dk-status small muted"></div>
      <div class="dk-ports chips"></div>
      <div class="dk-stats">
        <div><div class="dk-stat-h small"><span class="muted">CPU</span><span class="dk-cpu-t"></span></div><div class="bar"><i class="dk-cpu"></i></div></div>
        <div><div class="dk-stat-h small"><span class="muted">Memory</span><span class="dk-mem-t"></span></div><div class="bar"><i class="dk-mem"></i></div></div>
      </div>
      <div class="dk-actions"></div>
    </article>`);
  }

  function updateCard(card, c) {
    const [kind, label] = STATES[c.state] || ['', c.state || 'Unknown'];
    card.dataset.id = c.id;
    card.dataset.state = c.state;
    $('.dk-name', card).textContent = c.name;
    $('.dk-image', card).textContent = c.image;
    const badge = $('.dk-badge', card);
    badge.className = `dk-badge pill sm ${kind}`;
    badge.textContent = label;
    $('.dk-status', card).textContent = c.status || '';
    if (card._ports !== c.ports) {
      card._ports = c.ports;
      const ports = parsePorts(c.ports);
      $('.dk-ports', card).innerHTML = ports
        .map((p) => (p.host && p.proto === 'tcp' ? `<button type="button" class="chip dk-port" data-hostport="${p.host}" title="Open port ${p.host} of this machine in your browser, through SSH">${icon('link')} ${esc(p.label)} → ${esc(p.container)}</button>` : `<span class="chip dk-port off" title="${p.label ? 'Published, but not a TCP port that can be opened here' : 'Only reachable from inside the container network'}">${esc(p.label ? `${p.label} → ${p.container}` : p.container)}</span>`))
        .join('');
      $('.dk-ports', card).hidden = !ports.length;
    }
    const running = c.state === 'running';
    $('.dk-stats', card).hidden = !running;
    if (running) {
      const cpu = pctNum(c.cpu);
      $('.dk-cpu-t', card).textContent = c.cpu || '—';
      $('.dk-cpu', card).style.width = `${Math.min(100, cpu)}%`;
      $('.dk-mem-t', card).textContent = c.mem || '—';
      $('.dk-mem', card).style.width = `${Math.min(100, pctNum(c.memPerc))}%`;
    }
    const sig = `${c.state}|${busy.has(c.id)}`;
    if (card._sig !== sig) {
      card._sig = sig;
      card.classList.toggle('busy', busy.has(c.id));
      const dis = busy.has(c.id) ? 'disabled' : '';
      const b = (act, ic, text, tip) => `<button type="button" class="btn btn-sm" data-do="${act}" ${dis} title="${tip}">${icon(ic)} ${text}</button>`;
      let btns = '';
      if (c.state === 'running') btns = b('stop', 'stop', 'Stop', 'Stop this container') + b('restart', 'refresh', 'Restart', 'Stop and start it again') + b('pause', 'pause', 'Pause', 'Freeze it without stopping');
      else if (c.state === 'paused') btns = b('unpause', 'play', 'Resume', 'Continue a paused container') + b('stop', 'stop', 'Stop', 'Stop this container');
      else if (c.state === 'restarting') btns = b('stop', 'stop', 'Stop', 'Stop this container');
      else btns = b('start', 'play', 'Start', 'Start this container');
      $('.dk-actions', card).innerHTML = `${busy.has(c.id) ? '<span class="spinner"></span>' : ''}${btns}<span class="spacer"></span><button type="button" class="icon-btn sm" data-menu ${dis} aria-label="More actions" title="More actions">${icon('more')}</button>`;
    }
  }

  // --------------------------------------------------------------- actions ---
  async function doAction(id, action, label) {
    if (action === 'rm' && !(await confirmBox(`Remove ${label}?`, 'The container is deleted for good. Data stored in volumes is kept, but anything inside the container itself is lost.', { okLabel: 'Remove', danger: true }))) return;
    if (action === 'rmi' && !(await confirmBox(`Remove image ${label}?`, 'The image is deleted from this machine. You can download it again later.', { okLabel: 'Remove', danger: true }))) return;
    if (action === 'kill' && !(await confirmBox(`Force stop ${label}?`, 'The container is killed immediately without a chance to shut down cleanly. Use this only if Stop does not work.', { okLabel: 'Force stop', danger: true }))) return;
    busy.add(id);
    render();
    try {
      const r = await call('docker.action', { id, action }, `${VERB[action]} ${label}`);
      if (r && r.ok === false) throw new Error(r.output || 'The command failed');
      toast(`${label} ${DONE[action]}`, 'success');
    } catch (e) {
      if (!isCancelled(e)) toast(`Couldn't ${VERB[action].toLowerCase()} ${label}: ${e.message}`, 'error', 8000);
    } finally {
      busy.delete(id);
      for (const c of cards.values()) c._sig = null; // redraw buttons
      await fetchList();
    }
  }

  async function openPort(hostPort) {
    try {
      const list = await session.req('fwd.add', { type: 'local', remoteHost: '127.0.0.1', remotePort: hostPort });
      const f = list.find((x) => x.remotePort === hostPort && x.remoteHost === '127.0.0.1') || list.at(-1);
      const url = `http://127.0.0.1:${f.localPort}/`;
      toast(`Port ${hostPort} is now at ${url.replace(/^http:\/\//, '').replace(/\/$/, '')}`, 'success', 6000);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast(`Couldn't forward port ${hostPort}: ${e.message}`, 'error', 7000);
    }
  }

  async function inspect(id, name, kind = 'container') {
    let obj;
    try {
      obj = await call('docker.inspect', { id, kind }, `Inspect ${name}`);
    } catch (e) {
      if (!isCancelled(e)) toast(e.message, 'error');
      return;
    }
    const text = JSON.stringify(obj, null, 2);
    const body = h(`<div class="dk-inspect"><div class="dk-inspect-bar"><span class="muted small">Everything ${esc(runtimeName())} knows about this ${kind}</span><button type="button" class="btn btn-sm">${icon('copy')} Copy</button></div><pre class="quicklook mono"></pre></div>`);
    $('pre', body).textContent = text;
    $('button', body).addEventListener('click', () => navigator.clipboard.writeText(text).then(() => toast('Copied', 'success', 1500), () => toast("Couldn't copy", 'error')));
    await modal({ title: `Inspect ${name}`, wide: true, body, buttons: [{ label: 'Close', value: true, primary: true }] });
  }

  function openShell(c) {
    const cmd = `${sudoPw ? 'sudo ' : ''}${runtime()} exec -it ${c.name} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
    actions.openTerminal(null, cmd, `shell: ${c.name}`);
  }

  function openLogs(c) {
    if (logId === c.id) return;
    closeDrawer();
    logId = c.id;
    drawer.hidden = false;
    el.classList.add('has-drawer');
    drawer.innerHTML = `<header class="svc-d-head"><span class="dot" ${c.state === 'running' ? 'data-kind="ok"' : ''}></span><div><b>${esc(c.name)}</b><div class="muted small">Live log · last 200 lines</div></div><button type="button" class="icon-btn" data-act="close-drawer" aria-label="Close logs">${icon('x')}</button></header><div class="dk-d-log"></div>`;
    logView = createLogView(session, { kind: 'docker-logs', id: c.id, name: c.name, compact: true, tail: 200, sudoPassword: () => sudoPw });
    $('.dk-d-log', drawer).append(logView.el);
    if (visible) logView.start();
  }
  function closeDrawer() {
    logView?.dispose();
    logView = null;
    logId = null;
    drawer.hidden = true;
    drawer.innerHTML = '';
    el.classList.remove('has-drawer');
  }

  function showMenu(c, anchor) {
    const r = anchor.getBoundingClientRect();
    const up = isUp(c);
    contextMenu(r.right - 230, r.bottom + 4, [
      { label: 'Logs', icon: 'scroll', action: () => openLogs(c) },
      { label: 'Open shell', icon: 'terminal', disabled: c.state !== 'running' || !SAFE_NAME.test(c.name), action: () => openShell(c) },
      { label: 'Inspect', icon: 'info', action: () => inspect(c.id, c.name) },
      '-',
      { label: 'Force stop (kill)', icon: 'zap', disabled: !up, danger: true, action: () => doAction(c.id, 'kill', c.name) },
      { label: up ? 'Remove (stop it first)' : 'Remove', icon: 'trash', disabled: up, danger: true, action: () => doAction(c.id, 'rm', c.name) },
    ]);
  }

  async function useSudo() {
    try {
      const { r, pw } = await withSudo(
        session,
        async (pw) => {
          if (!pw) throw new Error('SUDO_REQUIRED');
          return { r: await session.req('docker.list', { sudoPassword: pw }), pw };
        },
        { reason: `Use ${runtimeName()} with administrator rights` },
      );
      sudoPw = pw;
      data = r;
      render();
      if (r.error) toast(`Still can't use ${runtimeName()}: ${r.error}`, 'error', 7000);
    } catch (e) {
      if (!isCancelled(e)) toast(e.message, 'error', 7000);
    }
  }

  async function startDaemon() {
    try {
      const r = await withSudo(session, (pw) => session.req('svc.action', { unit: 'docker', action: 'start', scope: 'system', sudoPassword: pw }), { reason: `Start the ${runtimeName()} service` });
      if (r && r.ok === false) throw new Error(r.output || 'The command failed');
      toast(`${runtimeName()} is starting…`, 'success');
      setTimeout(() => fetchList({ silent: false }), 1500);
    } catch (e) {
      if (!isCancelled(e)) toast(`Couldn't start ${runtimeName()}: ${e.message}`, 'error', 8000);
    }
  }

  // --------------------------------------------------------------- events ---
  $('.dk-search input', el).addEventListener('input', (e) => {
    q = e.target.value.trim();
    render();
  });
  el.addEventListener('change', (e) => {
    if (e.target.type === 'radio' && e.target.name === `${sname}-tab`) {
      tab = e.target.value;
      tabHtml = '';
      cardWrap = null;
      render();
    }
  });
  el.addEventListener('click', (e) => {
    const t = e.target;
    const sf = t.closest('[data-sf]');
    if (sf) {
      stateFilter = sf.dataset.sf;
      return render();
    }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'refresh') return fetchList({ silent: false });
    if (act === 'use-sudo') return useSudo();
    if (act === 'start-docker') return startDaemon();
    if (act === 'close-drawer') return closeDrawer();
    const card = t.closest('.dk-card');
    const c = card && (data?.containers || []).find((x) => x.id === card.dataset.id);
    const port = t.closest('[data-hostport]');
    if (port) return openPort(Number(port.dataset.hostport));
    const doBtn = t.closest('[data-do]');
    if (doBtn && c) return doAction(c.id, doBtn.dataset.do, c.name);
    const menu = t.closest('[data-menu]');
    if (menu && c) return showMenu(c, menu);
    const rm = t.closest('[data-img-rm]');
    if (rm) return doAction(rm.dataset.imgRm, 'rmi', rm.dataset.ref);
  });

  // --------------------------------------------------------------- polling ---
  async function loop() {
    clearTimeout(timer);
    if (!visible) return;
    await fetchList({ silent: !!data });
    if (visible) timer = setTimeout(loop, interval(data?.error ? 8000 : 3000));
  }

  return {
    el,
    show() {
      visible = true;
      loop();
      logView?.start();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
      logView?.stop();
    },
    dispose() {
      visible = false;
      clearTimeout(timer);
      logView?.dispose();
      sudoPw = null;
    },
  };
}
