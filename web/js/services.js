// Services: browse and control systemd services on the remote machine.

import { h, $, $$, icon, esc, toast, confirmBox, contextMenu, formatBytes, dirname } from './ui.js';
import { uid, segHtml, cmdBlock, bindCopy, emptyState, loadingHtml, humanDuration } from './kit.js';
import { interval } from './prefs.js';
import { withSudo, isCancelled } from './sudo.js';
import { createLogView } from './logs.js';

const FILTERS = [['all', 'All'], ['running', 'Running'], ['failed', 'Failed'], ['enabled', 'Enabled at boot'], ['disabled', 'Disabled']];
const VERB = { start: 'Start', stop: 'Stop', restart: 'Restart', reload: 'Reload', enable: 'Enable at boot', disable: 'Disable at boot' };
const DONE = { start: 'started', stop: 'stopped', restart: 'restarted', reload: 'reloaded', enable: 'will now start at boot', disable: 'will no longer start at boot' };
const RESTART_POLICY = { no: 'Never restarts by itself', 'on-failure': 'Restarts if it fails', always: 'Always restarts', 'on-success': 'Restarts when it finishes cleanly', 'on-abnormal': 'Restarts after a crash', 'on-abort': 'Restarts after a crash', 'on-watchdog': 'Restarts if it stops responding' };

const shortName = (unit) => unit.replace(/\.service$/, '');
const isOn = (s) => ['active', 'activating', 'reloading'].includes(s.active);

function stateInfo(s) {
  if (s.active === 'failed') return { kind: 'err', label: 'Failed' };
  if (s.active === 'activating') return { kind: 'warn', label: 'Starting…' };
  if (s.active === 'deactivating') return { kind: 'warn', label: 'Stopping…' };
  if (s.active === 'reloading') return { kind: 'warn', label: 'Reloading…' };
  if (s.active === 'active') return { kind: 'ok', label: s.sub === 'exited' ? 'Finished (ran once)' : s.sub && s.sub !== 'running' ? `Active (${s.sub})` : 'Running' };
  return { kind: '', label: 'Stopped' };
}

function bootPill(enabled) {
  if (enabled === 'enabled' || enabled === 'enabled-runtime') return '<span class="pill sm ok" title="Starts automatically when the machine boots">Starts at boot</span>';
  if (enabled === 'disabled') return '<span class="pill sm" title="Does not start automatically">Disabled</span>';
  if (enabled === 'masked' || enabled === 'masked-runtime') return '<span class="pill sm bad" title="Blocked from starting">Masked</span>';
  if (['static', 'indirect', 'alias', 'generated', 'transient'].includes(enabled)) return '<span class="pill sm" title="Started by other services or on demand; it has no boot switch of its own">Static</span>';
  return enabled ? `<span class="pill sm">${esc(enabled)}</span>` : '';
}

// systemd prints e.g. "Mon 2024-05-06 10:11:12 UTC"
function parseStamp(s) {
  const m = String(s || '').match(/(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?: ([A-Z]{2,5}))?/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3] === 'UTC' || m[3] === 'GMT' ? 'Z' : ''}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const numeric = (v) => (/^\d+$/.test(String(v ?? '')) && Number(v) < 2 ** 60 ? Number(v) : null);
function cpuTime(ns) {
  const s = ns / 1e9;
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} hours`;
}

export function createServices(session, info, actions) {
  const sname = uid('sv');
  const el = h(`<div class="svc">
    <div class="svc-top">
      <div class="svc-bar">
        <label class="search-box svc-search">${icon('search')}<input type="search" placeholder="Search services" aria-label="Search services"></label>
        ${segHtml(`${sname}-scope`, [['system', 'System'], ['user', 'My services']], 'system', 'Which services')}
        <button type="button" class="btn btn-sm" data-act="refresh" title="Reload the list">${icon('refresh')} Refresh</button>
      </div>
      <div class="svc-bar2"><div class="chips svc-chips"></div><span class="svc-summary small muted"></span></div>
    </div>
    <div class="svc-body"><div class="svc-list" aria-live="polite"></div><aside class="svc-drawer" hidden aria-label="Service details"></aside></div>
  </div>`);
  bindCopy(el);

  const listEl = $('.svc-list', el);
  const drawer = $('.svc-drawer', el);
  let scope = 'system';
  let filter = 'all';
  let q = '';
  let services = [];
  let available = true;
  let fatal = '';
  let listError = '';
  let loaded = false;
  let loading = false;
  let selected = null;
  let detail = null;
  let detailLog = null;
  let visible = false;
  let timer = null;
  let lastHtml = '';
  const busy = new Set();

  // ----------------------------------------------------------------- list ---
  async function load({ silent = false } = {}) {
    if (loading) return;
    loading = true;
    const myScope = scope;
    if (!silent && !services.length) listEl.innerHTML = loadingHtml('Loading services…');
    try {
      const r = await session.req('svc.list', { scope: myScope });
      if (myScope !== scope) return;
      available = r.available !== false;
      listError = r.error || '';
      services = r.services || [];
      fatal = '';
    } catch (e) {
      if (myScope !== scope) return;
      fatal = e.message;
    } finally {
      loading = false;
    }
    loaded = true;
    render();
  }

  const matchesFilter = (s) => {
    if (filter === 'running') return s.active === 'active';
    if (filter === 'failed') return s.active === 'failed';
    if (filter === 'enabled') return s.enabled === 'enabled' || s.enabled === 'enabled-runtime';
    if (filter === 'disabled') return s.enabled === 'disabled';
    return true;
  };

  function counts() {
    return {
      all: services.length,
      running: services.filter((s) => s.active === 'active').length,
      failed: services.filter((s) => s.active === 'failed').length,
      enabled: services.filter((s) => s.enabled === 'enabled' || s.enabled === 'enabled-runtime').length,
      disabled: services.filter((s) => s.enabled === 'disabled').length,
    };
  }

  function renderBar() {
    const c = counts();
    $('.svc-chips', el).innerHTML = FILTERS.map(([k, l]) => `<button type="button" class="chip ${filter === k ? 'on' : ''}" data-filter="${k}">${l}${loaded && available ? ` <span class="chip-n">${c[k]}</span>` : ''}</button>`).join('');
    $('.svc-summary', el).innerHTML =
      loaded && available && !fatal
        ? `${c.all} services · ${c.running} running · ${c.failed ? `<button type="button" class="linklike bad" data-filter="failed" title="Show only failed services">${c.failed} failed</button>` : '0 failed'}`
        : '';
  }

  function rowHtml(s) {
    const st = stateInfo(s);
    const on = isOn(s);
    const isBusy = busy.has(s.unit);
    const masked = String(s.enabled).startsWith('masked');
    const dis = isBusy ? 'disabled' : '';
    return `<div class="svc-row ${selected === s.unit ? 'sel' : ''} ${isBusy ? 'busy' : ''}" data-unit="${esc(s.unit)}" tabindex="0" role="button" aria-label="Details of ${esc(shortName(s.unit))}">
      <span class="dot" ${st.kind ? `data-kind="${st.kind}"` : ''}></span>
      <div class="svc-main">
        <div class="svc-name"><b>${esc(shortName(s.unit))}</b><span class="muted small mono">${esc(s.unit)}</span></div>
        <div class="svc-desc small"><span class="svc-st ${st.kind}">${esc(st.label)}</span>${s.description ? ` <span class="muted">· ${esc(s.description)}</span>` : ''}</div>
      </div>
      ${bootPill(s.enabled)}
      <div class="svc-btns">
        ${isBusy ? '<span class="spinner"></span>' : ''}
        ${on ? `<button type="button" class="btn btn-sm" data-do="stop" ${dis} title="Stop this service">${icon('stop')} Stop</button><button type="button" class="btn btn-sm" data-do="restart" ${dis} title="Stop and start it again">${icon('refresh')} Restart</button>` : `<button type="button" class="btn btn-sm" data-do="start" ${dis || (masked ? 'disabled' : '')} title="Start this service">${icon('play')} Start</button>`}
        <button type="button" class="icon-btn sm" data-menu ${dis} aria-label="More actions for ${esc(shortName(s.unit))}" title="More actions">${icon('more')}</button>
      </div>
    </div>`;
  }

  function render() {
    renderBar();
    let html;
    if (fatal) {
      html = emptyState({ icon: 'alert', kind: 'err', title: "Couldn't load services", body: `<p>${esc(fatal)}</p>`, actions: `<button type="button" class="btn btn-primary" data-act="refresh">${icon('refresh')} Try again</button>` });
    } else if (!available) {
      html = emptyState({
        icon: 'sliders',
        title: `Services isn't available on ${esc(info.host)}`,
        body: `<p>This panel manages <b>systemd</b> services, which most modern Linux distributions use. ${esc(info.host)} doesn't seem to be running systemd, so there is nothing to show here.</p>${listError ? `<p class="muted small">${esc(listError)}</p>` : ''}`,
      });
    } else if (scope === 'user' && listError && !services.length) {
      html = emptyState({
        icon: 'alert',
        title: "Your personal services can't be read",
        body: `<p>${esc(listError)}</p><p>Your own systemd session may not be running. You can check it from a terminal:</p>${cmdBlock('systemctl --user status')}`,
        actions: `<button type="button" class="btn" data-scope="system">Show system services instead</button>`,
      });
    } else {
      const ql = q.toLowerCase();
      const shown = services.filter((s) => matchesFilter(s) && (!ql || `${s.unit} ${s.description}`.toLowerCase().includes(ql)));
      if (!shown.length) {
        html = emptyState({
          icon: 'search',
          title: services.length ? 'No services match' : 'No services found',
          body: services.length ? '<p>Try a different search or filter.</p>' : '<p>The machine reported no services for this view.</p>',
          actions: services.length ? '<button type="button" class="btn" data-act="reset">Clear search and filter</button>' : '',
        });
      } else {
        shown.sort((a, b) => (b.active === 'failed') - (a.active === 'failed') || shortName(a.unit).localeCompare(shortName(b.unit)));
        html = shown.map(rowHtml).join('');
      }
    }
    if (html !== lastHtml) {
      lastHtml = html;
      listEl.innerHTML = html;
    }
  }

  // --------------------------------------------------------------- actions ---
  async function doAction(unit, action) {
    const name = shortName(unit);
    if (action === 'stop' || action === 'disable') {
      const msg = action === 'stop' ? `${name} will stop running until you start it again.${scope === 'system' ? ' Anything that depends on it may stop working too.' : ''}` : `${name} will no longer start automatically when the machine boots. If it is running now, it keeps running.`;
      if (!(await confirmBox(`${VERB[action]} ${name}?`, msg, { okLabel: VERB[action], danger: true }))) return;
    }
    busy.add(unit);
    render();
    try {
      const run = async (pw) => {
        const r = await session.req('svc.action', { unit, action, scope, sudoPassword: pw });
        if (r && r.ok === false) throw new Error(r.output || 'The command failed');
        return r;
      };
      if (scope === 'system') await withSudo(session, run, { reason: `${VERB[action]} ${unit}` });
      else await run();
      toast(`${name} ${DONE[action]}`, 'success');
    } catch (e) {
      if (!isCancelled(e)) toast(`Couldn't ${VERB[action].toLowerCase()} ${name}: ${e.message}`, 'error', 8000);
    } finally {
      busy.delete(unit);
      await load({ silent: true });
      if (selected === unit) loadDetail();
    }
  }

  function showMenu(unit, anchor) {
    const s = services.find((x) => x.unit === unit);
    if (!s) return;
    const r = anchor.getBoundingClientRect();
    const en = s.enabled === 'enabled' || s.enabled === 'enabled-runtime';
    const canToggle = en || s.enabled === 'disabled';
    contextMenu(r.right - 220, r.bottom + 4, [
      { label: 'Enable at boot', icon: 'check', disabled: !canToggle || en, action: () => doAction(unit, 'enable') },
      { label: 'Disable at boot', icon: 'x', disabled: !canToggle || !en, action: () => doAction(unit, 'disable') },
      { label: 'Reload settings', icon: 'refresh', disabled: !isOn(s), action: () => doAction(unit, 'reload') },
      '-',
      { label: 'View logs', icon: 'scroll', action: () => actions.openLogs({ unit, scope }) },
      { label: 'Details', icon: 'info', action: () => openDetail(unit) },
    ]);
  }

  // --------------------------------------------------------------- details ---
  function openDetail(unit) {
    if (selected === unit) return;
    closeDetail(false);
    selected = unit;
    detail = null;
    const s = services.find((x) => x.unit === unit);
    drawer.hidden = false;
    el.classList.add('has-drawer');
    drawer.innerHTML = `<header class="svc-d-head"><span class="dot"></span><div><b>${esc(shortName(unit))}</b><div class="muted small mono">${esc(unit)}</div></div><button type="button" class="icon-btn" data-act="close-detail" aria-label="Close details">${icon('x')}</button></header>
      <div class="svc-d-scroll">
        <p class="svc-d-desc muted">${esc(s?.description || '')}</p>
        <div class="svc-d-actions"></div>
        <div class="svc-d-info">${loadingHtml('Reading details…')}</div>
        <details class="svc-d-text"><summary>Full status output</summary><pre class="mono"></pre></details>
        <h3 class="svc-d-h">Live log <span class="muted small">last 100 lines, following</span></h3>
        <div class="svc-d-log"></div>
      </div>`;
    detailLog = createLogView(session, { kind: 'journal', unit, scope, compact: true, lines: 100 });
    $('.svc-d-log', drawer).append(detailLog.el);
    if (visible) detailLog.start();
    renderDrawerActions();
    loadDetail();
    render();
  }

  function closeDetail(rerender = true) {
    detailLog?.dispose();
    detailLog = null;
    selected = null;
    detail = null;
    drawer.hidden = true;
    drawer.innerHTML = '';
    el.classList.remove('has-drawer');
    if (rerender) render();
  }

  function renderDrawerActions() {
    const box = $('.svc-d-actions', drawer);
    if (!box || !selected) return;
    const s = services.find((x) => x.unit === selected);
    const on = s ? isOn(s) : false;
    const en = s && (s.enabled === 'enabled' || s.enabled === 'enabled-runtime');
    const canToggle = s && (en || s.enabled === 'disabled');
    const dis = busy.has(selected) ? 'disabled' : '';
    box.innerHTML = `${on ? `<button type="button" class="btn btn-sm" data-do="stop" ${dis}>${icon('stop')} Stop</button><button type="button" class="btn btn-sm" data-do="restart" ${dis}>${icon('refresh')} Restart</button><button type="button" class="btn btn-sm" data-do="reload" ${dis}>Reload</button>` : `<button type="button" class="btn btn-sm btn-primary" data-do="start" ${dis}>${icon('play')} Start</button>`}
      ${canToggle ? (en ? `<button type="button" class="btn btn-sm" data-do="disable" ${dis}>Don't start at boot</button>` : `<button type="button" class="btn btn-sm" data-do="enable" ${dis}>Start at boot</button>`) : ''}
      <button type="button" class="btn btn-sm" data-act="all-logs">${icon('scroll')} Open in Logs</button>`;
  }

  async function loadDetail() {
    const unit = selected;
    if (!unit) return;
    try {
      const d = await session.req('svc.status', { unit, scope });
      if (selected !== unit) return;
      detail = d;
      renderDetail();
    } catch (e) {
      if (selected !== unit) return;
      $('.svc-d-info', drawer).innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  function renderDetail() {
    if (!detail || !selected) return;
    const p = detail.props || {};
    const s = services.find((x) => x.unit === selected) || { active: p.ActiveState, sub: p.SubState, enabled: p.UnitFileState };
    const st = stateInfo({ active: p.ActiveState || s.active, sub: p.SubState || s.sub });
    const since = parseStamp(p.ActiveEnterTimestamp);
    const up = since && p.ActiveState === 'active' ? ` · running for ${humanDuration((Date.now() - since.getTime()) / 1000)}` : '';
    const pid = numeric(p.MainPID);
    const mem = numeric(p.MemoryCurrent);
    const cpu = numeric(p.CPUUsageNSec);
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    $('.svc-d-head .dot', drawer).dataset.kind = st.kind;
    $('.svc-d-desc', drawer).textContent = p.Description || '';
    $('.svc-d-info', drawer).innerHTML = `<dl class="svc-dl">
      ${row('State', `<span class="svc-st ${st.kind}">${esc(st.label)}</span>${esc(up)}`)}
      ${row('At boot', bootPill(p.UnitFileState || s.enabled) || '—')}
      ${row('Process ID', pid ? `<span class="mono">${pid}</span>` : '—')}
      ${row('Memory', mem != null ? esc(formatBytes(mem)) : '—')}
      ${row('CPU time used', cpu != null ? esc(cpuTime(cpu)) : '—')}
      ${row('If it crashes', esc(RESTART_POLICY[p.Restart] || p.Restart || '—'))}
      ${row('Restarts so far', p.NRestarts != null && p.NRestarts !== '' ? esc(p.NRestarts) : '—')}
      ${row('Unit file', p.FragmentPath ? `<span class="mono small">${esc(p.FragmentPath)}</span> <button type="button" class="linklike" data-path="${esc(dirname(p.FragmentPath))}" title="Show the folder in Files">Show folder</button>` : '—')}
    </dl>`;
    $('.svc-d-text pre', drawer).textContent = detail.text || '';
    renderDrawerActions();
  }

  // --------------------------------------------------------------- events ---
  $('.svc-search input', el).addEventListener('input', (e) => {
    q = e.target.value.trim();
    render();
  });
  el.addEventListener('change', (e) => {
    if (e.target.type === 'radio' && e.target.name === `${sname}-scope`) setScope(e.target.value);
  });
  function setScope(s) {
    if (scope === s) return;
    scope = s;
    const r = $(`input[name="${sname}-scope"][value="${s}"]`, el);
    if (r) r.checked = true;
    closeDetail(false);
    services = [];
    loaded = false;
    lastHtml = '';
    fatal = listError = '';
    available = true;
    load();
  }
  el.addEventListener('click', (e) => {
    const t = e.target;
    const f = t.closest('[data-filter]');
    if (f) {
      filter = f.dataset.filter;
      return render();
    }
    const sc = t.closest('[data-scope]');
    if (sc) return setScope(sc.dataset.scope);
    const path = t.closest('[data-path]');
    if (path) return actions.openFiles(path.dataset.path);
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'refresh') return load();
    if (act === 'reset') {
      filter = 'all';
      q = '';
      $('.svc-search input', el).value = '';
      return render();
    }
    if (act === 'close-detail') return closeDetail();
    if (act === 'all-logs') return actions.openLogs({ unit: selected, scope });
    const doBtn = t.closest('[data-do]');
    if (doBtn) {
      const unit = doBtn.closest('.svc-row')?.dataset.unit || selected;
      return doAction(unit, doBtn.dataset.do);
    }
    const menu = t.closest('[data-menu]');
    if (menu) return showMenu(menu.closest('.svc-row').dataset.unit, menu);
    const row = t.closest('.svc-row');
    if (row) openDetail(row.dataset.unit);
  });
  el.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.svc-row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openDetail(row.dataset.unit);
    }
    if (e.key === 'Escape' && selected && !e.target.closest('input')) closeDetail();
  });

  // --------------------------------------------------------------- polling ---
  async function loop() {
    clearTimeout(timer);
    if (!visible) return;
    if (!busy.size) {
      await load({ silent: loaded });
      if (selected) await loadDetail();
    }
    if (visible) timer = setTimeout(loop, interval(5000));
  }

  return {
    el,
    show() {
      visible = true;
      loop();
      detailLog?.start();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
      detailLog?.stop();
    },
    dispose() {
      visible = false;
      clearTimeout(timer);
      detailLog?.dispose();
    },
  };
}
