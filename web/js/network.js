// Network toolbox: everything runs from the remote host's point of view
// (except Wake-on-LAN, which is sent from this computer).

import { h, $, $$, icon, esc, toast, formatBytes } from './ui.js';
import { interval, getPrefs } from './prefs.js';

const SECTIONS = [
  ['overview', 'Overview', 'server'],
  ['bandwidth', 'Live bandwidth', 'activity'],
  ['tools', 'Diagnostics', 'zap'],
  ['ports', 'Port check', 'shield'],
  ['lan', 'LAN scan', 'search'],
  ['forward', 'Port forwarding', 'link'],
  ['speed', 'Speed test', 'download'],
  ['wol', 'Wake-on-LAN', 'power'],
];

const SERVICES = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 139: 'NetBIOS', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 548: 'AFP', 631: 'IPP', 993: 'IMAPS', 995: 'POP3S', 1883: 'MQTT', 2049: 'NFS', 3000: 'dev', 3306: 'MySQL', 3389: 'RDP', 5000: 'dev', 5432: 'Postgres', 5900: 'VNC', 5901: 'VNC', 6379: 'Redis', 8000: 'HTTP alt', 8080: 'HTTP alt', 8443: 'HTTPS alt', 8888: 'Jupyter', 9000: 'dev', 9090: 'Prometheus', 27017: 'MongoDB' };
const PRESETS = {
  Common: '',
  Web: '80,443,3000,5000,8000,8080,8443,8888',
  'Remote access': '22,23,3389,5900-5905',
  Databases: '3306,5432,6379,9200,27017',
  'Top 1000': '1-1024',
};

const rate = (bps) => `${formatBytes(bps)}/s`;

function parsePorts(spec) {
  const out = new Set();
  for (const part of String(spec).split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Can't read "${part}" (use e.g. 22,80,8000-8100)`);
    const a = +m[1];
    const b = +(m[2] || m[1]);
    for (let p = Math.min(a, b); p <= Math.max(a, b) && out.size < 1024; p++) if (p > 0 && p < 65536) out.add(p);
  }
  return [...out];
}

export function createNetwork(session, info, actions) {
  const el = h(`<div class="network">
    <nav class="net-nav" aria-label="Network tools">
      ${SECTIONS.map(([k, l, i]) => `<button data-sec="${k}">${icon(i)}<span>${l}</span></button>`).join('')}
    </nav>
    <div class="net-main"></div>
  </div>`);
  const main = $('.net-main', el);
  const views = {};
  let current = null;
  let visible = false;

  function show(sec) {
    if (current === sec) return;
    views[current]?.leave?.();
    current = sec;
    for (const b of $$('[data-sec]', el)) b.classList.toggle('active', b.dataset.sec === sec);
    views[sec] ??= builders[sec]();
    main.replaceChildren(views[sec].el);
    views[sec].enter?.();
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sec]');
    if (b) show(b.dataset.sec);
  });

  const section = (title, desc, body) => h(`<section class="net-sec"><header><h2>${title}</h2><p class="muted">${desc}</p></header>${body}</section>`);
  const copyBtn = (text) => `<button type="button" class="icon-btn sm" data-copy="${esc(text)}" title="Copy" aria-label="Copy">${icon('copy')}</button>`;
  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Copied', 'success', 1500));
  });

  // ------------------------------------------------------------ overview ---
  function buildOverview() {
    const v = section('Overview', `Interfaces, routes and open ports on ${esc(info.host)}.`, `
      <div class="net-actions"><button class="btn btn-sm" data-act="refresh">${icon('refresh')} Refresh</button><button class="btn btn-sm" data-act="pubip">${icon('server')} Public IP</button><span class="pubip mono"></span></div>
      <div class="ov-grid">
        <div class="card"><h3>Interfaces</h3><div class="ov-addr"></div></div>
        <div class="card"><h3>Routes &amp; DNS</h3><pre class="ov-route mono"></pre><pre class="ov-dns mono"></pre></div>
        <div class="card span2"><h3>Listening ports</h3><div class="table-wrap"><table><thead><tr><th>Proto</th><th>Address</th><th class="num">Port</th><th>Process</th><th></th></tr></thead><tbody class="ov-listen"></tbody></table></div></div>
        <div class="card span2"><h3>Established connections <span class="muted ov-conn-n"></span></h3><pre class="ov-conn mono"></pre></div>
      </div>`);
    async function load() {
      try {
        const s = await session.req('net.info');
        $('.ov-addr', v).innerHTML = (s.addr || [])
          .map((l) => {
            const [name, state, ...addrs] = l.trim().split(/\s+/);
            return `<div class="if-row"><b class="mono">${esc(name)}</b><span class="pill sm ${state === 'UP' ? 'ok' : ''}">${esc(state || '')}</span><span class="mono small">${addrs.map(esc).join('<br>')}</span></div>`;
          })
          .join('') || '<p class="muted">No data</p>';
        $('.ov-route', v).textContent = (s.route || []).join('\n') || '—';
        $('.ov-dns', v).textContent = (s.dns || []).join('\n');
        $('.ov-listen', v).innerHTML = (s.listen || [])
          .map((l) => {
            const p = l.trim().split(/\s+/);
            const local = p[4] || p[3] || '';
            const port = local.slice(local.lastIndexOf(':') + 1);
            const addr = local.slice(0, local.lastIndexOf(':'));
            const proc = (l.match(/users:\(\("([^"]+)"/) || [])[1] || '';
            const fwd = /^tcp/.test(p[0]) && +port ? `<button class="btn btn-sm" data-fwd="${esc(port)}" title="Open this port on your computer through SSH">${icon('link')} Forward</button>` : '';
            return `<tr><td>${esc(p[0])}</td><td class="mono">${esc(addr)}</td><td class="num mono">${esc(port)}</td><td class="mono">${esc(proc)}</td><td>${fwd}</td></tr>`;
          })
          .join('');
        $('.ov-conn', v).textContent = (s.conn || []).slice(0, 60).join('\n') || 'None';
        $('.ov-conn-n', v).textContent = s.conn?.length ? `(${s.conn.length})` : '';
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    v.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'refresh') load();
      if (act === 'pubip') {
        $('.pubip', v).textContent = '…';
        $('.pubip', v).textContent = (await session.req('net.publicip').catch(() => '')) || 'unavailable';
      }
      const fwd = e.target.closest('[data-fwd]');
      if (fwd) quickForward('localhost', +fwd.dataset.fwd);
    });
    let loaded = false;
    return { el: v, enter: () => !loaded && ((loaded = true), load()) };
  }

  // ----------------------------------------------------------- bandwidth ---
  function buildBandwidth() {
    const v = section('Live bandwidth', `Traffic through each network interface of ${esc(info.host)}, measured every ${interval(1000) / 1000}s.`, `
      <label class="switch small"><input type="checkbox" class="bw-lo"><span></span>Show loopback</label>
      <div class="bw-list"></div>`);
    const hist = new Map(); // iface -> {rx:[], tx:[]}
    let prev = null;
    let timer = null;
    const N = 60;
    async function tick() {
      clearTimeout(timer);
      if (!visible || current !== 'bandwidth') return;
      try {
        const { t, raw } = await session.req('net.bw');
        const now = {};
        for (const line of raw.split('\n').slice(2)) {
          const m = line.match(/^\s*([^:]+):\s*(.*)$/);
          if (!m) continue;
          const f = m[2].trim().split(/\s+/).map(Number);
          now[m[1]] = { rx: f[0], tx: f[8] };
        }
        if (prev) {
          const dt = (t - prev.t) / 1000;
          for (const [name, c] of Object.entries(now)) {
            const p = prev.now[name];
            if (!p) continue;
            const s = hist.get(name) || { rx: [], tx: [] };
            s.rx.push(Math.max(0, (c.rx - p.rx) / dt));
            s.tx.push(Math.max(0, (c.tx - p.tx) / dt));
            if (s.rx.length > N) (s.rx.shift(), s.tx.shift());
            s.totalRx = c.rx;
            s.totalTx = c.tx;
            hist.set(name, s);
          }
          render();
        }
        prev = { t, now };
      } catch (e) {
        $('.bw-list', v).innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
      timer = setTimeout(tick, interval(1000));
    }
    function render() {
      const showLo = $('.bw-lo', v).checked;
      const list = $('.bw-list', v);
      for (const [name, s] of hist) {
        if (name === 'lo' && !showLo) {
          list.querySelector(`[data-if="${CSS.escape(name)}"]`)?.remove();
          continue;
        }
        let card = list.querySelector(`[data-if="${CSS.escape(name)}"]`);
        if (!card) {
          card = h(`<div class="card bw-card" data-if="${esc(name)}"><div class="bw-head"><b class="mono">${esc(name)}</b><span class="bw-rx">↓ —</span><span class="bw-tx">↑ —</span><span class="muted small bw-tot"></span></div><canvas height="70"></canvas></div>`);
          list.append(card);
        }
        $('.bw-rx', card).textContent = `↓ ${rate(s.rx.at(-1) || 0)}`;
        $('.bw-tx', card).textContent = `↑ ${rate(s.tx.at(-1) || 0)}`;
        $('.bw-tot', card).textContent = `total ↓ ${formatBytes(s.totalRx)} · ↑ ${formatBytes(s.totalTx)}`;
        drawSpark($('canvas', card), s.rx, s.tx, N);
      }
    }
    $('.bw-lo', v).addEventListener('change', render);
    return { el: v, enter: tick, leave: () => clearTimeout(timer) };
  }

  function drawSpark(canvas, a, b, n) {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const hgt = canvas.clientHeight || 70;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const max = Math.max(1024, ...a, ...b);
    const cs = getComputedStyle(canvas);
    const line = (arr, color) => {
      if (arr.length < 2) return;
      ctx.beginPath();
      arr.forEach((val, i) => {
        const x = w - (arr.length - 1 - i) * (w / (n - 1));
        const y = hgt - 2 - (val / max) * (hgt - 6);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.lineTo(w, hgt);
      ctx.lineTo(w - (arr.length - 1) * (w / (n - 1)), hgt);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    line(a, cs.getPropertyValue('--accent').trim() || '#7c93ff');
    line(b, cs.getPropertyValue('--teal').trim() || '#49d6c4');
  }

  // ---------------------------------------------------------- diagnostics ---
  function buildTools() {
    const v = section('Diagnostics', `Run from ${esc(info.host)}, so results show what that machine sees.`, `
      <form class="tool-form">
        <div class="segmented tool-seg" role="radiogroup" aria-label="Tool">
          ${[['ping', 'Ping'], ['trace', 'Traceroute'], ['dns', 'DNS lookup'], ['http', 'HTTP check'], ['whois', 'Whois']].map(([k, l], i) => `<label><input type="radio" name="tool" value="${k}" ${i ? '' : 'checked'}><span>${l}</span></label>`).join('')}
        </div>
        <div class="tool-row">
          <label class="field grow"><span class="target-label">Host or IP</span><input name="target" required list="net-targets" autocomplete="off" spellcheck="false" placeholder="example.com or 192.168.1.1"></label>
          <label class="field count-field"><span>Count</span><input name="count" type="number" min="1" max="100" value="5"></label>
          <button class="btn btn-primary run-btn">${icon('play')} Run</button>
        </div>
        <datalist id="net-targets"></datalist>
      </form>
      <div class="console-head"><span class="muted small cmd-line"></span><span class="tool-status small"></span></div>
      <pre class="console mono" aria-live="polite"></pre>`);
    const form = $('.tool-form', v);
    const out = $('.console', v);
    let running = null;
    const recent = () => JSON.parse(localStorage.getItem('sshportal.netTargets') || '[]');
    const fillRecent = () => ($('#net-targets', v).innerHTML = recent().map((t) => `<option value="${esc(t)}">`).join(''));
    fillRecent();
    const sync = () => {
      const tool = form.tool.value;
      $('.count-field', v).hidden = tool !== 'ping';
      $('.target-label', v).textContent = tool === 'http' ? 'URL' : 'Host or IP';
      form.target.placeholder = tool === 'http' ? 'https://example.com' : 'example.com or 192.168.1.1';
    };
    form.addEventListener('change', sync);
    sync();
    const setRunning = (r) => {
      running = r;
      $('.run-btn', v).innerHTML = r ? `${icon('stop')} Stop` : `${icon('play')} Run`;
      $('.run-btn', v).classList.toggle('btn-danger', !!r);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (running) return running.stop();
      const target = form.target.value.trim();
      out.textContent = '';
      $('.tool-status', v).textContent = 'running…';
      $('.tool-status', v).dataset.kind = 'busy';
      try {
        const r = await session.startTool(
          form.tool.value,
          target,
          { count: form.count.value },
          (d) => {
            const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
            out.textContent += d;
            if (out.textContent.length > 200000) out.textContent = out.textContent.slice(-150000);
            if (atBottom) out.scrollTop = out.scrollHeight;
          },
          (code) => {
            setRunning(null);
            $('.tool-status', v).textContent = code === 0 ? 'done' : code == null ? 'stopped' : `exited with ${code}`;
            $('.tool-status', v).dataset.kind = code === 0 ? 'ok' : 'err';
          },
        );
        setRunning(r);
        $('.cmd-line', v).textContent = `${info.username}@${info.host}`;
        localStorage.setItem('sshportal.netTargets', JSON.stringify([target, ...recent().filter((t) => t !== target)].slice(0, 15)));
        fillRecent();
      } catch (err) {
        $('.tool-status', v).textContent = err.message;
        $('.tool-status', v).dataset.kind = 'err';
      }
    });
    return {
      el: v,
      run(tool, target) {
        form.tool.value = tool;
        sync();
        form.target.value = target;
        if (!running) form.requestSubmit();
      },
      leave: () => {},
    };
  }

  // ----------------------------------------------------------- port check ---
  function buildPorts() {
    const v = section('Port check', `TCP connection test made from ${esc(info.host)}. Works for any host it can reach.`, `
      <form class="port-form">
        <div class="tool-row">
          <label class="field grow"><span>Host</span><input name="host" required value="localhost" spellcheck="false" autocomplete="off"></label>
          <label class="field grow"><span>Ports</span><input name="ports" placeholder="Common ports" spellcheck="false" autocomplete="off"></label>
          <button class="btn btn-primary">${icon('search')} Check</button>
        </div>
        <div class="chips">${Object.keys(PRESETS).map((k) => `<button type="button" class="chip" data-preset="${esc(k)}">${esc(k)}</button>`).join('')}</div>
      </form>
      <div class="port-summary muted small"></div>
      <div class="port-grid"></div>`);
    const form = $('.port-form', v);
    v.addEventListener('click', (e) => {
      const p = e.target.closest('[data-preset]');
      if (p) form.ports.value = PRESETS[p.dataset.preset];
      const f = e.target.closest('[data-fwd]');
      if (f) quickForward(form.host.value.trim(), +f.dataset.fwd);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let ports = [];
      try {
        ports = form.ports.value.trim() ? parsePorts(form.ports.value) : [];
      } catch (err) {
        return toast(err.message, 'error');
      }
      const host = form.host.value.trim();
      const grid = $('.port-grid', v);
      grid.innerHTML = '<p class="muted"><span class="spinner"></span> Checking…</p>';
      const t0 = performance.now();
      try {
        const res = await session.req('net.ports', { host, ports });
        const open = res.filter((r) => r.state === 'open');
        $('.port-summary', v).textContent = `${open.length} open of ${res.length} checked on ${host} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
        const showAll = res.length <= 64;
        grid.innerHTML = (showAll ? res : open)
          .map(
            (r) => `<div class="port ${r.state}"><b class="mono">${r.port}</b><span>${esc(SERVICES[r.port] || '')}</span><span class="small">${r.state}${r.state === 'open' ? ` · ${r.ms} ms` : ''}</span>
            ${r.state === 'open' ? `<button class="btn btn-sm" data-fwd="${r.port}" title="Reach it from this computer">${icon('link')} Forward</button>` : ''}</div>`,
          )
          .join('') || '<p class="muted">Nothing open.</p>';
      } catch (err) {
        grid.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      }
    });
    return {
      el: v,
      check(host) {
        form.host.value = host;
        form.requestSubmit();
      },
    };
  }

  // -------------------------------------------------------------- LAN scan ---
  function buildLan() {
    const v = section('LAN scan', `Finds devices on ${esc(info.host)}'s local network (ping sweep of its /24 plus the neighbour table).`, `
      <div class="net-actions"><button class="btn btn-primary" data-act="scan">${icon('search')} Scan network</button><span class="lan-meta muted small"></span></div>
      <div class="table-wrap"><table class="lan-table" hidden><thead><tr><th>IP address</th><th>Name</th><th>MAC</th><th></th></tr></thead><tbody></tbody></table></div>`);
    v.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const ip = act.dataset.ip;
      if (act.dataset.act === 'scan') {
        act.disabled = true;
        act.innerHTML = `<span class="spinner"></span> Scanning… (about 10 s)`;
        try {
          const r = await session.req('net.scan');
          $('.lan-meta', v).textContent = `${r.hosts.length} devices · ${r.ifaces.map((i) => `${i.name} ${i.addr}`).join(', ')}`;
          const tbody = $('tbody', v);
          tbody.innerHTML = r.hosts
            .map(
              (x) => `<tr><td class="mono">${esc(x.ip)}${x.self ? ' <span class="pill sm ok">this host</span>' : ''}</td><td>${esc(x.name || '')}</td><td class="mono small">${esc(x.mac || '')}</td>
              <td class="row-actions">
                <button class="btn btn-sm" data-act="ports" data-ip="${esc(x.ip)}">${icon('shield')} Ports</button>
                <button class="btn btn-sm" data-act="ping" data-ip="${esc(x.ip)}">${icon('zap')} Ping</button>
                ${x.self ? '' : `<button class="btn btn-sm" data-act="ssh" data-ip="${esc(x.ip)}" title="Open SSH Portal for this device in a new window">${icon('terminal')} SSH</button>`}
                ${x.mac ? `<button class="btn btn-sm" data-act="savewol" data-ip="${esc(x.ip)}" data-mac="${esc(x.mac)}" data-name="${esc(x.name || x.ip)}" title="Remember for Wake-on-LAN">${icon('power')}</button>` : ''}
              </td></tr>`,
            )
            .join('');
          $('.lan-table', v).hidden = false;
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          act.disabled = false;
          act.innerHTML = `${icon('refresh')} Scan again`;
        }
      }
      if (act.dataset.act === 'ports') (show('ports'), views.ports.check(ip));
      if (act.dataset.act === 'ping') (show('tools'), views.tools.run('ping', ip));
      if (act.dataset.act === 'ssh') window.open(`${location.pathname}?connect=${encodeURIComponent(`${info.username}@${ip}`)}`, '_blank', 'noopener');
      if (act.dataset.act === 'savewol') {
        saveWol({ name: act.dataset.name, mac: act.dataset.mac });
        toast(`Saved ${act.dataset.name} for Wake-on-LAN`, 'success');
      }
    });
    return { el: v };
  }

  // ------------------------------------------------------------ forwarding ---
  async function quickForward(host, port) {
    try {
      const list = await session.req('fwd.add', { type: 'local', remoteHost: host || 'localhost', remotePort: port });
      const f = list.find((x) => x.remoteHost === (host || 'localhost') && x.remotePort === port) || list.at(-1);
      toast(`${host}:${port} is now at 127.0.0.1:${f.localPort}`, 'success', 6000);
      // only web-ish ports get opened in a browser tab automatically
      if ([80, 443, 3000, 4200, 5000, 5173, 8000, 8080, 8081, 8443, 8888, 9000, 9090].includes(port)) window.open(`http${port === 443 || port === 8443 ? 's' : ''}://127.0.0.1:${f.localPort}/`, '_blank', 'noopener');
      views.forward?.refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function buildForward() {
    const v = section('Port forwarding', 'Reach services on the remote network from this computer, through SSH. Forwards last until you disconnect.', `
      <form class="fwd-form card">
        <div class="segmented" role="radiogroup" aria-label="Forward type">
          <label><input type="radio" name="type" value="local" checked><span>Local forward (-L)</span></label>
          <label><input type="radio" name="type" value="socks"><span>SOCKS proxy (-D)</span></label>
        </div>
        <div class="tool-row">
          <label class="field"><span>Local port</span><input name="localPort" type="number" min="1" max="65535" placeholder="auto"></label>
          <span class="fwd-arrow local-only">${icon('forward')}</span>
          <label class="field grow local-only"><span>Remote host</span><input name="remoteHost" value="localhost" spellcheck="false"></label>
          <label class="field local-only"><span>Remote port</span><input name="remotePort" type="number" min="1" max="65535" placeholder="8080"></label>
          <button class="btn btn-primary">${icon('plus')} Add</button>
        </div>
        <p class="small muted socks-help" hidden>Point a browser or app at SOCKS5 proxy <code>127.0.0.1:&lt;port&gt;</code> to browse as if you were on ${esc(info.host)}'s network.</p>
      </form>
      <div class="fwd-list"></div>`);
    const form = $('.fwd-form', v);
    const sync = () => {
      const socks = form.type.value === 'socks';
      for (const n of $$('.local-only', v)) n.hidden = socks;
      $('.socks-help', v).hidden = !socks;
    };
    form.addEventListener('change', sync);
    sync();
    async function refresh() {
      const list = await session.req('fwd.list').catch(() => []);
      $('.fwd-list', v).innerHTML = list.length
        ? list
            .map((f) => {
              const local = `127.0.0.1:${f.localPort}`;
              const to = f.type === 'socks' ? `SOCKS5 → ${esc(info.host)}'s network` : `${esc(f.remoteHost)}:${f.remotePort}`;
              return `<div class="fwd card"><span class="fwd-type pill sm">${f.type === 'socks' ? 'SOCKS' : 'LOCAL'}</span>
                <span class="mono fwd-local">${local}</span>${icon('forward')}<span class="mono">${to}</span>
                <span class="muted small fwd-stats">${f.connections} active · ${f.total} total · ${formatBytes(f.bytes)}</span>
                <span class="row-actions">${f.type === 'local' ? `<a class="btn btn-sm" href="http://${local}/" target="_blank" rel="noopener">${icon('window')} Open</a>` : ''}${copyBtn(f.type === 'socks' ? `socks5://${local}` : local)}
                <button class="icon-btn sm" data-remove="${f.id}" title="Stop forwarding" aria-label="Stop forwarding">${icon('x')}</button></span></div>`;
            })
            .join('')
        : '<p class="muted empty-note">No forwards yet. Tip: in Overview or Port check, click <b>Forward</b> next to any open port.</p>';
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await session.req('fwd.add', { type: form.type.value, localPort: form.localPort.value || 0, remoteHost: form.remoteHost.value.trim(), remotePort: form.remotePort.value });
        form.localPort.value = '';
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    v.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-remove]');
      if (r) await session.req('fwd.remove', { id: r.dataset.remove }).then(refresh);
    });
    session.addEventListener('forwards', () => current === 'forward' && refresh());
    return { el: v, enter: refresh, refresh };
  }

  // ------------------------------------------------------------ speed test ---
  function buildSpeed() {
    const v = section('Speed test', `Throughput between this computer and ${esc(info.host)} over SSH, using incompressible data.`, `
      <div class="speed">
        <div class="gauge card"><span class="label">Download</span><b class="sp-down">—</b><span class="muted small">Mbit/s · remote → you</span></div>
        <div class="gauge card"><span class="label">Upload</span><b class="sp-up">—</b><span class="muted small">Mbit/s · you → remote</span></div>
      </div>
      <div class="net-actions"><button class="btn btn-primary" data-act="run">${icon('play')} Run test</button><span class="sp-meta muted small"></span></div>`);
    v.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act="run"]');
      if (!b) return;
      const mb = getPrefs().dataSaver ? 4 : 32;
      b.disabled = true;
      $('.sp-down', v).textContent = $('.sp-up', v).textContent = '…';
      try {
        const d = await session.req('net.speed', { direction: 'down', mb });
        $('.sp-down', v).textContent = d.mbps;
        const u = await session.req('net.speed', { direction: 'up', mb });
        $('.sp-up', v).textContent = u.mbps;
        $('.sp-meta', v).textContent = `${mb} MB each way${getPrefs().dataSaver ? ' (data saver)' : ''}`;
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        b.disabled = false;
      }
    });
    return { el: v };
  }

  // ----------------------------------------------------------- wake-on-lan ---
  const wolList = () => JSON.parse(localStorage.getItem('sshportal.wol') || '[]');
  function saveWol(d) {
    localStorage.setItem('sshportal.wol', JSON.stringify([d, ...wolList().filter((x) => x.mac !== d.mac)].slice(0, 30)));
    views.wol?.refresh();
  }
  function buildWol() {
    const v = section('Wake-on-LAN', 'Send a magic packet from this computer to wake a sleeping machine on the same network. The machine must have Wake-on-LAN enabled.', `
      <form class="wol-form tool-row">
        <label class="field grow"><span>Name</span><input name="name" placeholder="Workstation"></label>
        <label class="field grow"><span>MAC address</span><input name="mac" required placeholder="aa:bb:cc:dd:ee:ff" spellcheck="false" autocomplete="off"></label>
        <button class="btn btn-primary">${icon('power')} Wake</button>
      </form>
      <div class="wol-list"></div>`);
    const form = $('.wol-form', v);
    const wake = async (mac, name) => {
      try {
        await session.req('wol', { mac });
        toast(`Magic packet sent to ${name || mac}`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    function refresh() {
      const list = wolList();
      $('.wol-list', v).innerHTML = list.length
        ? list.map((d, i) => `<div class="fwd card"><b>${esc(d.name || '')}</b><span class="mono small">${esc(d.mac)}</span><span class="row-actions"><button class="btn btn-sm" data-wake="${i}">${icon('power')} Wake</button><button class="icon-btn sm" data-forget="${i}" aria-label="Forget">${icon('x')}</button></span></div>`).join('')
        : '<p class="muted empty-note">Saved devices appear here. LAN scan can add them for you.</p>';
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = { name: form.name.value.trim(), mac: form.mac.value.trim() };
      wake(d.mac, d.name).then(() => saveWol(d));
    });
    v.addEventListener('click', (e) => {
      const w = e.target.closest('[data-wake]');
      if (w) {
        const d = wolList()[w.dataset.wake];
        wake(d.mac, d.name);
      }
      const f = e.target.closest('[data-forget]');
      if (f) {
        const l = wolList();
        l.splice(+f.dataset.forget, 1);
        localStorage.setItem('sshportal.wol', JSON.stringify(l));
        refresh();
      }
    });
    refresh();
    return { el: v, refresh };
  }

  const builders = { overview: buildOverview, bandwidth: buildBandwidth, tools: buildTools, ports: buildPorts, lan: buildLan, forward: buildForward, speed: buildSpeed, wol: buildWol };

  return {
    el,
    show(sec) {
      visible = true;
      show(sec || current || 'overview');
      if (current === 'bandwidth') views.bandwidth.enter();
    },
    hide() {
      visible = false;
      views[current]?.leave?.();
    },
    open: (sec) => show(sec),
    // used by the Devices panel: jump to a tool and run it
    runTool(tool, target) {
      show('tools');
      views.tools.run(tool, target);
    },
    checkPorts(host) {
      show('ports');
      views.ports.check(host);
    },
    dispose() {
      visible = false;
      views[current]?.leave?.();
    },
  };
}
