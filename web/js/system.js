// System monitor: CPU, memory, disks and processes of the remote host.

import { h, $, icon, esc, toast, confirmBox, formatBytes, formatDuration } from './ui.js';

export function createSystem(session) {
  const el = h(`<div class="system">
    <div class="sys-cards">
      <div class="card stat"><span class="label">Host</span><b class="s-host">—</b><span class="small muted s-os"></span></div>
      <div class="card stat"><span class="label">CPU</span><b class="s-cpu">—</b><div class="bar"><i class="b-cpu"></i></div><span class="small muted s-load"></span></div>
      <div class="card stat"><span class="label">Memory</span><b class="s-mem">—</b><div class="bar"><i class="b-mem"></i></div><span class="small muted s-swap"></span></div>
      <div class="card stat"><span class="label">Uptime</span><b class="s-up">—</b><span class="small muted s-kernel"></span></div>
    </div>
    <div class="sys-grid">
      <section class="card"><h3>Disks</h3><div class="disks"></div></section>
      <section class="card procs">
        <div class="procs-head"><h3>Processes</h3>
          <label class="search-box">${icon('search')}<input type="search" placeholder="Filter" class="p-filter" aria-label="Filter processes"></label>
          <label class="chk small"><input type="checkbox" class="p-live" checked> Live</label>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>PID</th><th>User</th><th class="num">CPU %</th><th class="num">Mem %</th><th>Time</th><th>Command</th><th></th></tr></thead>
          <tbody></tbody>
        </table></div>
      </section>
    </div>
  </div>`);

  let prevCpu = null;
  let timer = null;
  let visible = false;
  let last = null;

  async function refresh() {
    try {
      const s = await session.req('sysinfo');
      last = s;
      $('.s-host', el).textContent = s.host || '—';
      $('.s-os', el).textContent = s.os || '';
      $('.s-kernel', el).textContent = s.kernel || '';
      $('.s-up', el).textContent = s.uptime ? formatDuration(+s.uptime) : '—';
      $('.s-load', el).textContent = s.load ? `load ${s.load} · ${s.cpus} cores` : '';

      const nums = (s.cpu || '').trim().split(/\s+/).slice(1).map(Number);
      if (nums.length >= 4) {
        const idle = nums[3] + (nums[4] || 0);
        const total = nums.reduce((a, b) => a + b, 0);
        if (prevCpu) {
          const pct = Math.max(0, Math.min(100, (1 - (idle - prevCpu.idle) / Math.max(1, total - prevCpu.total)) * 100));
          $('.s-cpu', el).textContent = `${pct.toFixed(0)}%`;
          $('.b-cpu', el).style.width = `${pct}%`;
        }
        prevCpu = { idle, total };
      }
      const [mt, ma, st, sf] = (s.mem || '').split(' ').map((n) => +n * 1024);
      if (mt) {
        const used = mt - ma;
        $('.s-mem', el).textContent = `${formatBytes(used)} / ${formatBytes(mt)}`;
        $('.b-mem', el).style.width = `${(used / mt) * 100}%`;
        $('.s-swap', el).textContent = st ? `swap ${formatBytes(st - sf)} / ${formatBytes(st)}` : 'no swap';
      }
      $('.disks', el).innerHTML = s.df
        .map((d) => {
          const pct = d.size ? (d.used / d.size) * 100 : 0;
          return `<div class="disk"><div class="disk-row"><b>${esc(d.mount)}</b><span class="small muted">${formatBytes(d.used)} / ${formatBytes(d.size)}</span></div>
            <div class="bar${pct > 90 ? ' warn' : ''}"><i style="width:${pct}%"></i></div><span class="small muted mono">${esc(d.fs)}</span></div>`;
        })
        .join('');
      renderProcs();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function renderProcs() {
    if (!last) return;
    const f = $('.p-filter', el).value.trim().toLowerCase();
    $('tbody', el).innerHTML = last.ps
      .filter((p) => !f || `${p.pid} ${p.user} ${p.cmd}`.toLowerCase().includes(f))
      .map(
        (p) => `<tr><td class="mono">${p.pid}</td><td>${esc(p.user)}</td><td class="num">${p.cpu.toFixed(1)}</td><td class="num">${p.mem.toFixed(1)}</td>
        <td class="mono small">${esc(p.time)}</td><td class="mono">${esc(p.cmd)}</td>
        <td><button class="icon-btn sm" data-kill="${p.pid}" data-cmd="${esc(p.cmd)}" title="End process" aria-label="End process ${p.pid}">${icon('x')}</button></td></tr>`,
      )
      .join('');
  }

  $('.p-filter', el).addEventListener('input', renderProcs);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kill]');
    if (!b) return;
    if (!(await confirmBox('End process?', `Send SIGTERM to ${b.dataset.cmd} (PID ${b.dataset.kill})?`, { okLabel: 'End process', danger: true }))) return;
    session
      .req('kill', { pid: b.dataset.kill, signal: 15 })
      .then(() => setTimeout(refresh, 500))
      .catch((err) => toast(err.message, 'error'));
  });

  const loop = async () => {
    clearTimeout(timer);
    if (!visible) return;
    if ($('.p-live', el).checked || !last) await refresh();
    timer = setTimeout(loop, 3000);
  };

  return {
    el,
    show() {
      visible = true;
      loop();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
    },
    dispose() {
      visible = false;
      clearTimeout(timer);
    },
  };
}
