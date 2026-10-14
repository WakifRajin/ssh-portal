// Logs: a live journal / container log viewer. `createLogView` is the shared
// component (also embedded by Services and Docker); `createLogs` is the tab.

import { h, $, icon, esc, toast } from './ui.js';
import { segHtml, uid, debounce, downloadText } from './kit.js';
import { withSudo, isCancelled, clearSudo } from './sudo.js';

const MAX_ROWS = 5000; // DOM cap: oldest rows are dropped past this
const BATCH = 400; // rows added per flush so a busy log never freezes the UI
const FLUSH_MS = 100;

const PRESETS = [['3', 'Errors'], ['4', 'Warnings+'], ['6', 'Info+'], ['7', 'Everything']];
const SINCE = [['15m', 'Last 15 minutes'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['today', 'Today'], ['boot', 'Since boot'], ['all', 'All time']];
const LEVELS = [
  ['emerg', 'err'], ['alert', 'err'], ['crit', 'err'], ['error', 'err'],
  ['warning', 'warn'], ['notice', 'info'], ['info', 'info'], ['debug', 'dbg'],
];
const PERMISSION_HINT = /not seeing messages from other users|No journal files were opened|insufficient permissions/i;

const pad = (n) => String(n).padStart(2, '0');
const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function decodeMsg(m) {
  if (Array.isArray(m)) {
    try {
      return new TextDecoder().decode(new Uint8Array(m));
    } catch {
      return m.join(' ');
    }
  }
  return m == null ? '' : String(m);
}

// Plain text has no priority field: guess from the wording.
function guessPriority(msg) {
  if (/\b(emerg(ency)?|alert|crit(ical)?|fatal|panic)\b/i.test(msg)) return 2;
  if (/\b(error|err|fail(ed|ure|ing)?|denied|refused|cannot|unable)\b/i.test(msg)) return 3;
  if (/\bwarn(ing)?\b/i.test(msg)) return 4;
  if (/\bdebug\b/i.test(msg)) return 7;
  return null;
}

// Each line is a journalctl JSON object, or plain syslog text as a fallback.
function parseJournalLine(line) {
  if (line[0] === '{') {
    try {
      const o = JSON.parse(line);
      const us = Number(o.__REALTIME_TIMESTAMP);
      const pri = o.PRIORITY != null && o.PRIORITY !== '' ? Number(o.PRIORITY) : null;
      return { t: us ? Math.floor(us / 1000) : null, pri: Number.isFinite(pri) ? pri : null, src: String(o._SYSTEMD_UNIT || o.SYSLOG_IDENTIFIER || o._COMM || '').replace(/\.service$/, ''), msg: decodeMsg(o.MESSAGE) };
    } catch {}
  }
  const m = line.match(/^(\w{3}\s+\d+\s+\d\d:\d\d:\d\d)\s+\S+\s+([^:[\s]+)(?:\[\d+\])?:\s*(.*)$/);
  if (m) return { t: null, tText: m[1].split(/\s+/).pop(), pri: guessPriority(m[3]), src: m[2], msg: m[3], plain: true };
  return { t: null, pri: guessPriority(line), src: '', msg: line, plain: true };
}

function parseDockerLine(line) {
  const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)?)\s?(.*)$/);
  if (m) {
    const t = Date.parse(m[1].replace(/(\.\d{3})\d+/, '$1'));
    return { t: Number.isNaN(t) ? null : t, pri: guessPriority(m[2]), src: '', msg: m[2] };
  }
  return { t: null, pri: guessPriority(line), src: '', msg: line };
}

function highlight(text, q) {
  if (!q) return esc(text);
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let out = '';
  let i = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, i)) {
    out += `${esc(text.slice(i, at))}<mark>${esc(text.slice(at, at + needle.length))}</mark>`;
    i = at + needle.length;
  }
  return out + esc(text.slice(i));
}

const levelOf = (pri) => {
  const l = pri == null ? null : LEVELS[pri];
  return l ? { name: l[0], cls: l[1], label: l[0].replace('warning', 'warn') } : { name: '', cls: 'none', label: '' };
};

const toolButtons = () => `<button type="button" class="btn btn-sm on" data-act="follow" title="Keep the newest line in view">${icon('chevDown')} Follow</button>
  <button type="button" class="btn btn-sm" data-act="clear" title="Clear what is on screen">${icon('trash')} Clear</button>
  <button type="button" class="btn btn-sm" data-act="download" title="Save the visible lines as a .log file">${icon('download')} Download</button>`;

// opts: { unit, scope, kind: 'journal'|'docker-logs', id, name, compact, tail, lines, since, priority, sudoPassword?: () => string|null }
export function createLogView(session, opts = {}) {
  const compact = !!opts.compact;
  const isDocker = opts.kind === 'docker-logs';
  const uidv = uid('lg');
  const st = {
    unit: opts.unit || '',
    scope: opts.scope || 'system',
    pri: String(opts.priority ?? (compact ? 7 : 6)),
    since: opts.since || (compact ? 'all' : '1h'),
    q: '',
    server: false,
    follow: true,
    sudo: false,
  };

  const filters = compact
    ? `<div class="lg-bar">
        ${isDocker ? '' : segHtml(`${uidv}-lv`, PRESETS, st.pri, 'Level')}
        <label class="search-box lg-search">${icon('search')}<input type="search" data-f="q" placeholder="Search lines" aria-label="Search log lines"></label>
        <span class="lg-tools">${toolButtons()}</span>
      </div>`
    : `<div class="lg-bar">
        <div class="lg-row1">
          <label class="field lg-unit"><span>Service</span><input data-f="unit" list="${uidv}-units" placeholder="Everything (type a service name to narrow down)" autocomplete="off" spellcheck="false" value="${esc(st.unit)}"></label>
          <datalist id="${uidv}-units"></datalist>
          <label class="field"><span>Source</span><select data-f="scope"><option value="system">System</option><option value="user">My services</option></select></label>
          <div class="field"><span>Level</span>${segHtml(`${uidv}-lv`, PRESETS, st.pri, 'Level')}</div>
          <label class="field"><span>Time range</span><select data-f="since">${SINCE.map(([v, l]) => `<option value="${v}" ${v === st.since ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <div class="lg-row2">
          <label class="search-box lg-search">${icon('search')}<input type="search" data-f="q" placeholder="Search the lines below" aria-label="Search log lines"></label>
          <label class="switch small" title="Ask the remote machine to search, which also finds older matches"><input type="checkbox" data-f="server"><span></span>Search on server</label>
          <label class="switch small" title="Read the full system journal with administrator rights"><input type="checkbox" data-f="sudo"><span></span>Show all system logs (needs sudo)</label>
          <span class="lg-tools">${toolButtons()}</span>
        </div>
      </div>`;

  const el = h(`<div class="lg ${compact ? 'compact' : ''}">
    ${filters}
    <div class="callout lg-hint" hidden><span>Some system messages are hidden because your account can't read the whole journal.</span> <button type="button" class="btn btn-sm" data-act="sudo-on">${icon('lock')} Show all with sudo</button></div>
    <div class="lg-wrap"><div class="lg-list" role="log" aria-live="off" tabindex="0"></div><div class="lg-empty"></div><button type="button" class="lg-jump" data-act="jump" hidden></button></div>
    <div class="lg-foot"><span class="lg-status small"></span><button type="button" class="btn btn-sm" data-act="restart" hidden>${icon('refresh')} Restart</button><span class="lg-count muted small"></span></div>
  </div>`);

  const list = $('.lg-list', el);
  const jump = $('.lg-jump', el);
  const q = (sel) => $(sel, el);
  let rows = []; // {r, el}
  let queue = [];
  let carry = '';
  let flushTimer = null;
  let stream = null;
  let gen = 0; // bumped on every (re)start/stop; stale callbacks compare against it
  let newCount = 0;
  let live = false;
  let state = 'idle'; // idle | connecting | live | ended | error
  let pwUsed = false; // this stream was started with a sudo password
  let pwRejected = false; // ...and sudo said no (streams can't report SUDO_FAILED, only print it)

  // ---------------------------------------------------------------- state ---
  function setState(s, text = '') {
    state = s;
    const kind = { connecting: 'busy', live: 'ok', error: 'err' }[s];
    const label = { connecting: 'Connecting…', live: 'Live', ended: 'Stream ended', error: text || 'Something went wrong', idle: 'Paused' }[s];
    $('.lg-status', el).innerHTML = `<span class="dot" ${kind ? `data-kind="${kind}"` : ''}></span> ${esc(s === 'ended' && text ? text : label)}`;
    $('[data-act="restart"]', el).hidden = !(s === 'ended' || s === 'error' || s === 'idle');
    updateEmpty();
  }
  function updateEmpty() {
    const e = $('.lg-empty', el);
    if (rows.some((x) => !x.el.hidden)) return void (e.hidden = true);
    e.hidden = false;
    if (rows.length && st.q) e.innerHTML = `<b>No lines contain "${esc(st.q)}"</b><span class="muted">Try a shorter search, or turn on "Search on server" to look further back.</span>`;
    else if (state === 'connecting') e.innerHTML = '<span class="spinner"></span><span class="muted">Loading log lines…</span>';
    else if (state === 'live') e.innerHTML = '<b>Waiting for log lines…</b><span class="muted">Nothing matches these filters yet. New lines appear here as they happen. Try "Everything" or a longer time range to see older ones.</span>';
    else if (state === 'error') e.innerHTML = '';
    else e.innerHTML = '<b>No log lines</b><span class="muted">Nothing to show. Try "Everything" or a longer time range.</span>';
  }
  function updateCount() {
    $('.lg-count', el).textContent = rows.length ? `${rows.length.toLocaleString()} line${rows.length === 1 ? '' : 's'}${rows.length >= MAX_ROWS ? ' (oldest are dropped)' : ''}` : '';
  }
  function setFollow(on) {
    st.follow = on;
    $('[data-act="follow"]', el).classList.toggle('on', on);
    if (on) {
      newCount = 0;
      jump.hidden = true;
      list.scrollTop = list.scrollHeight;
    }
  }

  // ----------------------------------------------------------------- rows ---
  const matches = (r) => !st.q || st.server || `${r.msg} ${r.src}`.toLowerCase().includes(st.q.toLowerCase());
  const showSrc = () => !isDocker && !(compact && st.unit);

  function makeRow(r) {
    const lv = levelOf(r.pri);
    const d = r.t ? new Date(r.t) : null;
    const row = document.createElement('div');
    row.className = 'lg-row';
    row.dataset.lv = lv.cls;
    row.innerHTML = `<span class="lg-t" title="${esc(d ? d.toLocaleString() : '')}">${esc(d ? hms(d) : r.tText || '')}</span><span class="lg-lv" title="${esc(lv.name)}">${esc(lv.label)}</span>${showSrc() ? `<span class="lg-src" title="${esc(r.src)}">${esc(r.src)}</span>` : ''}<span class="lg-msg">${highlight(r.msg, st.q)}</span>`;
    row.hidden = !matches(r);
    return row;
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue.splice(0, BATCH);
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const r of batch) {
      const rowEl = makeRow(r);
      rows.push({ r, el: rowEl });
      frag.append(rowEl);
      if (!rowEl.hidden) added++;
    }
    list.append(frag);
    if (rows.length > MAX_ROWS) for (const d of rows.splice(0, rows.length - MAX_ROWS)) d.el.remove();
    if (st.follow) list.scrollTop = list.scrollHeight;
    else if (added) {
      newCount += added;
      jump.hidden = false;
      jump.innerHTML = `${icon('chevDown')} ${newCount.toLocaleString()} new line${newCount === 1 ? '' : 's'}`;
    }
    updateCount();
    updateEmpty();
    if (queue.length) flushTimer = setTimeout(flush, FLUSH_MS);
  }
  const schedule = () => flushTimer || (flushTimer = setTimeout(flush, FLUSH_MS));

  function clearRows() {
    clearTimeout(flushTimer);
    flushTimer = null;
    queue = [];
    rows = [];
    carry = '';
    newCount = 0;
    list.replaceChildren();
    jump.hidden = true;
    updateCount();
    updateEmpty();
  }

  // Chunks can split lines: keep the unfinished tail until the next chunk.
  function feed(chunk) {
    carry += chunk;
    const parts = carry.split('\n');
    carry = parts.pop();
    if (carry.length > 200000) {
      parts.push(carry);
      carry = '';
    }
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      const r = isDocker ? parseDockerLine(line) : parseJournalLine(line);
      if (r.plain && PERMISSION_HINT.test(line) && !st.sudo) $('.lg-hint', el).hidden = false;
      if (pwUsed && /Sorry, try again|incorrect password attempt|authentication failure/i.test(line)) pwRejected = true;
      queue.push(r);
    }
    if (queue.length) schedule();
  }

  function applyFilter() {
    for (const x of rows) {
      x.el.hidden = !matches(x.r);
      $('.lg-msg', x.el).innerHTML = highlight(x.r.msg, st.q);
    }
    updateEmpty();
  }

  // --------------------------------------------------------------- stream ---
  function buildArgs() {
    if (isDocker) return { kind: 'docker-logs', id: opts.id, tail: opts.tail || 200, follow: true };
    const a = { kind: 'journal', scope: st.scope, priority: Number(st.pri), lines: opts.lines || (compact ? 100 : 1000), follow: true };
    if (st.unit) a.unit = st.unit;
    if (st.since !== 'all') a.since = st.since;
    if (st.server && st.q) a.grep = st.q;
    return a;
  }

  function stopStream() {
    const s = stream;
    stream = null;
    live = false;
    s?.stop();
  }

  async function start() {
    const my = ++gen;
    stopStream();
    clearRows();
    pwUsed = pwRejected = false;
    $('.lg-hint', el).hidden = true;
    setState('connecting');
    const args = buildArgs();
    const onData = (d) => my === gen && feed(d);
    const onExit = (code) => {
      if (my !== gen) return;
      flush();
      stream = null;
      live = false;
      if (pwRejected) {
        clearSudo();
        return setState('error', 'The sudo password was not accepted. Press Restart to try again.');
      }
      setState('ended', code == null || code === 0 ? 'Stream ended' : `Stream ended (exit code ${code})`);
    };
    try {
      const s = await withSudo(
        session,
        (pw) => {
          // "all system logs" always needs the password up front
          if (st.sudo && !isDocker && !pw) throw new Error('SUDO_REQUIRED');
          const password = pw ?? opts.sudoPassword?.();
          pwUsed = !!password;
          return session.startStream(password ? { ...args, sudoPassword: password } : args, onData, onExit);
        },
        { reason: st.sudo ? 'Read all system logs' : isDocker ? 'Read container logs' : 'Read the system journal' },
      );
      if (my !== gen) return void s.stop();
      stream = s;
      live = true;
      setState('live');
    } catch (e) {
      if (my !== gen) return;
      if (isCancelled(e)) {
        if (st.sudo) {
          st.sudo = false;
          const c = q('[data-f="sudo"]');
          if (c) c.checked = false;
          return start();
        }
        return setState('idle');
      }
      setState('error', e.message);
    }
  }

  function stop() {
    gen++;
    stopStream();
    clearTimeout(flushTimer);
    flushTimer = null;
    if (state !== 'idle') setState('idle');
  }

  // --------------------------------------------------------------- events ---
  const restartSoon = debounce(start, 350);
  const filterSoon = debounce(applyFilter, 150);

  el.addEventListener('input', (e) => {
    if (e.target.dataset?.f !== 'q') return;
    st.q = e.target.value.trim();
    if (st.server) restartSoon();
    else filterSoon();
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    const f = t.dataset?.f;
    if (t.type === 'radio' && t.name === `${uidv}-lv`) {
      st.pri = t.value;
      return start();
    }
    if (f === 'unit') {
      st.unit = t.value.trim();
      return start();
    }
    if (f === 'scope') {
      st.scope = t.value;
      loadUnits();
      return start();
    }
    if (f === 'since') {
      st.since = t.value;
      return start();
    }
    if (f === 'server') {
      st.server = t.checked;
      if (st.q) start();
      else applyFilter();
    }
    if (f === 'sudo') {
      st.sudo = t.checked;
      start();
    }
  });
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'follow') setFollow(!st.follow);
    if (act === 'jump') setFollow(true);
    if (act === 'clear') {
      clearRows();
      toast('Cleared. New lines will keep arriving.', 'info', 2500);
    }
    if (act === 'restart') start();
    if (act === 'sudo-on') {
      st.sudo = true;
      const c = q('[data-f="sudo"]');
      if (c) c.checked = true;
      start();
    }
    if (act === 'download') {
      const lines = rows.filter((x) => !x.el.hidden).map(({ r }) => `${r.t ? new Date(r.t).toISOString() : r.tText || ''} ${levelOf(r.pri).name || '-'} ${r.src ? `${r.src}: ` : ''}${r.msg}`);
      if (!lines.length) return toast('Nothing to save yet', 'info');
      const d = new Date();
      const base = (isDocker ? opts.name || 'container' : st.unit || 'system').replace(/[^\w.-]+/g, '_');
      downloadText(`${base}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.log`, lines.join('\n') + '\n');
    }
  });
  // scrolling away from the bottom pauses auto-scroll; coming back resumes it
  list.addEventListener('scroll', () => {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    if (atBottom && !st.follow) setFollow(true);
    else if (!atBottom && st.follow) {
      st.follow = false;
      $('[data-act="follow"]', el).classList.remove('on');
    }
  });

  // service picker: unit names on this machine
  async function loadUnits() {
    const dl = $(`#${uidv}-units`, el);
    if (!dl) return;
    try {
      const r = await session.req('svc.list', { scope: st.scope });
      dl.innerHTML = (r.services || []).map((s) => `<option value="${esc(s.unit)}">${esc(s.description || '')}</option>`).join('');
    } catch {}
  }
  if (!compact && !isDocker) {
    q('[data-f="scope"]').value = st.scope;
    loadUnits();
  }
  setState('idle');

  return {
    el,
    start,
    stop,
    restart: start,
    clear: clearRows,
    get running() {
      return live;
    },
    // change what is shown; restart only if asked (the tab may be hidden)
    setSource({ unit, scope } = {}, { restart = true } = {}) {
      st.unit = unit || '';
      st.scope = scope || 'system';
      if (unit && !compact) {
        st.since = 'all'; // a specific service is usually read by its last N lines
        const s = q('[data-f="since"]');
        if (s) s.value = 'all';
      }
      const u = q('[data-f="unit"]');
      if (u) u.value = st.unit;
      const sc = q('[data-f="scope"]');
      if (sc) sc.value = st.scope;
      loadUnits();
      if (restart) start();
    },
    dispose() {
      stop();
    },
  };
}

// The "Logs" tab.
export function createLogs(session) {
  const view = createLogView(session, { kind: 'journal', compact: false });
  const el = h('<div class="logs"></div>');
  el.append(view.el);
  let visible = false;
  return {
    el,
    show() {
      visible = true;
      view.start();
    },
    hide() {
      visible = false;
      view.stop();
    },
    open(src = {}) {
      view.setSource(src, { restart: visible });
    },
    dispose() {
      visible = false;
      view.dispose();
    },
  };
}
