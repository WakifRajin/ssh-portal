// Devices: what is plugged into, and around, the remote machine: USB, network
// links and the switch behind them, neighbours, disks, PCI and Bluetooth.

import { h, $, $$, icon, esc, toast, formatBytes } from './ui.js';
import { cmdBlock, bindCopy, emptyState, loadingHtml, clock } from './kit.js';
import { interval } from './prefs.js';

const SECTIONS = [
  ['overview', 'Overview', 'grid'],
  ['usb', 'USB', 'usb'],
  ['network', 'Network & switch', 'broadcast'],
  ['nearby', 'Nearby devices', 'search'],
  ['storage', 'Storage', 'hdd'],
  ['pci', 'PCI', 'cpu'],
  ['bluetooth', 'Bluetooth', 'bluetooth'],
];
const INFO = {
  overview: ['Overview', (host) => `What is plugged into, and around, ${host}.`],
  usb: ['USB devices', (host) => `Everything plugged into the USB ports of ${host}. New devices appear here the moment they are connected.`],
  network: ['Network & switch', () => 'Each network connection, and which switch and port the cable goes to.'],
  nearby: ['Nearby devices', (host) => `Other devices ${host} can see on its network.`],
  storage: ['Storage', () => 'Disks and USB drives, with the folders they are mounted on.'],
  pci: ['PCI devices', () => 'Built-in hardware: graphics, network and storage controllers, and more.'],
  bluetooth: ['Bluetooth', () => 'The Bluetooth adapter and the devices it knows.'],
};
// package names for the tools each section relies on (Debian/Ubuntu names)
const TOOL_PKG = { lsusb: 'usbutils', lsblk: 'util-linux', lspci: 'pciutils', bluetoothctl: 'bluez', lldpctl: 'lldpd', bridge: 'iproute2', iw: 'iw' };
const NEIGH_STATE = {
  REACHABLE: ['ok', 'Reachable', 'Answered recently'],
  STALE: ['', 'Stale', 'Seen a while ago, not checked recently'],
  DELAY: ['warn', 'Checking', 'Being checked right now'],
  PROBE: ['warn', 'Checking', 'Being checked right now'],
  FAILED: ['bad', 'No answer', "Didn't answer"],
  INCOMPLETE: ['bad', 'No answer', "Didn't answer"],
  PERMANENT: ['', 'Static', 'Fixed entry'],
};
const VIRTUAL_NOTE = 'Docker, VPN and virtual-machine links';

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const isHub = (d) => d.hub === true || d.hub === 'true' || /\bhub\b/i.test(`${d.cls || ''} ${d.product || ''}`);
const usbKey = (d) => `${d.bus}:${d.dev}:${d.vendorId}:${d.productId}`;
const usbName = (d) => d.product || [d.vendor].filter(Boolean).join('') || `${d.vendorId}:${d.productId}`;
const ipNum = (ip) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split('.').reduce((a, b) => a * 256 + Number(b), 0) : Infinity);
const isLoopback = (i) => i.kind === 'loopback' || i.name === 'lo';

function usbIcon(d) {
  const c = String(d.cls || '').trim().toLowerCase();
  const t = `${c} ${d.product || ''}`.toLowerCase();
  const code = /^(?:0x)?([0-9a-f]{1,2})$/.exec(c)?.[1]?.padStart(2, '0');
  if (code === '09' || /\bhub\b/.test(t)) return 'layers';
  if (/mouse|pointer|trackball/.test(t)) return 'mouse';
  if (code === '03' || /keyboard|human interface|\bhid\b/.test(t)) return 'keyboard';
  if (code === '08' || /mass storage|storage|flash|disk|card reader/.test(t)) return 'hdd';
  if (code === '01' || /audio|headset|headphone|speaker|microphone/.test(t)) return 'headphones';
  if (code === '0e' || /video|camera|webcam/.test(t)) return 'camera';
  if (code === '07' || /printer/.test(t)) return 'printer';
  if (code === 'e0' || /wireless|bluetooth/.test(t)) return 'bluetooth';
  return 'usb';
}
function usbSpeed(s) {
  const n = num(s);
  if (!n) return null;
  const label = n <= 12 ? 'USB 1' : n <= 480 ? 'USB 2' : n <= 5000 ? 'USB 3' : n <= 10000 ? 'USB 3.1' : 'USB 3.2';
  return { label, title: `${n} Mbit/s` };
}
function linkSpeed(mbps, duplex) {
  const n = num(mbps);
  if (!n || n <= 0) return '';
  const s = n >= 1000 ? `${+(n / 1000).toFixed(1)} Gbit/s` : `${n} Mbit/s`;
  return duplex && duplex !== 'unknown' ? `${s} · ${duplex} duplex` : s;
}
function wifiBars(dbm) {
  const n = num(dbm);
  if (n == null) return null;
  const bars = n >= -55 ? 4 : n >= -67 ? 3 : n >= -75 ? 2 : n >= -85 ? 1 : 0;
  return { bars, label: ['Very weak', 'Weak', 'Fair', 'Good', 'Excellent'][bars], dbm: n };
}
const barsHtml = (w) => `<span class="wbars" data-n="${w.bars}" title="${w.dbm} dBm · ${w.label}"><i></i><i></i><i></i><i></i></span> <span class="small muted">${w.label} (${w.dbm} dBm)</span>`;

export function createDevices(session, info, actions) {
  const host = esc(info.host);
  const el = h(`<div class="network devices">
    <nav class="net-nav" aria-label="Device sections">
      ${SECTIONS.map(([k, l, i]) => `<button data-sec="${k}">${icon(i)}<span>${l}</span></button>`).join('')}
    </nav>
    <div class="net-main"><section class="net-sec dv-sec">
      <header class="dv-head"><div class="dv-title"><h2></h2><p class="muted"></p></div>
        <div class="dv-tools-top">
          <label class="search-box dv-search">${icon('search')}<input type="search" placeholder="Filter this section" aria-label="Filter this section"></label>
          <button type="button" class="btn btn-sm" data-act="refresh" title="Scan again">${icon('refresh')} <span>Refresh</span></button>
        </div>
      </header>
      <div class="dv-tip"></div>
      <div class="dv-body"></div>
    </section></div>
  </div>`);
  bindCopy(el);

  const body = $('.dv-body', el);
  const tipEl = $('.dv-tip', el);
  const searchBox = $('.dv-search', el);
  let section = 'overview';
  let data = null;
  let error = '';
  let scanning = false;
  let finding = false;
  let updated = null;
  let q = '';
  let visible = false;
  let usbTimer = null;
  let rescanTimer = null;
  let lastHtml = '';
  const opts = { hubs: false, loopback: false, virtual: false };
  const fresh = new Set(); // usb keys highlighted for a few seconds
  const dismissed = new Set();
  const collapsed = new Set(); // pci groups
  const activity = []; // hot-plug events seen this session

  const hit = (...vals) => !q || vals.join(' ').toLowerCase().includes(q.toLowerCase());
  const tools = () => data?.tools || {};

  // ------------------------------------------------------------------ data ---
  async function scan({ quiet = false } = {}) {
    if (scanning) return;
    scanning = true;
    if (!quiet) syncChrome();
    try {
      const r = await session.req('devices.scan');
      if (data) diffUsb(arr(r.usb), { rescan: false }); // a full scan can see a hot-plug before the USB poll does
      data = r;
      error = '';
      updated = new Date();
    } catch (e) {
      error = e.message;
    } finally {
      scanning = false;
    }
    syncChrome();
    render();
  }

  function diffUsb(list, { rescan = true } = {}) {
    const before = new Map(arr(data.usb).map((d) => [usbKey(d), d]));
    const now = new Map(list.map((d) => [usbKey(d), d]));
    let changed = false;
    for (const [k, d] of now) {
      if (before.has(k)) continue;
      changed = true;
      if (isHub(d)) continue;
      toast(`USB device connected: ${usbName(d)}`, 'success');
      activity.unshift({ kind: 'in', text: `${usbName(d)} connected`, at: new Date() });
      fresh.add(k);
      setTimeout(() => {
        fresh.delete(k);
        if (section === 'usb') render();
      }, 6000);
    }
    for (const [k, d] of before) {
      if (now.has(k)) continue;
      changed = true;
      if (isHub(d)) continue;
      toast(`USB device disconnected: ${usbName(d)}`, 'info');
      activity.unshift({ kind: 'out', text: `${usbName(d)} disconnected`, at: new Date() });
    }
    activity.length = Math.min(activity.length, 30);
    if (!changed) return;
    data.usb = list;
    render();
    if (!rescan) return;
    // disks and mounts usually change with USB: refresh the rest shortly
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => visible && scan({ quiet: true }), 1500);
  }

  async function pollUsb() {
    clearTimeout(usbTimer);
    if (!visible) return;
    if (data && !scanning) {
      try {
        const r = await session.req('devices.scan', { only: 'usb' });
        if (visible && data) {
          if (r.tools) data.tools = { ...data.tools, ...r.tools };
          diffUsb(arr(r.usb));
        }
      } catch {}
    }
    if (visible) usbTimer = setTimeout(pollUsb, interval(4000));
  }

  // ---------------------------------------------------------------- chrome ---
  function syncChrome() {
    for (const b of $$('[data-sec]', el)) b.classList.toggle('active', b.dataset.sec === section);
    const [title, desc] = INFO[section];
    $('.dv-title h2', el).textContent = title;
    $('.dv-title p', el).innerHTML = esc(desc('this machine')).replace('this machine', host);
    searchBox.hidden = section === 'overview';
    const r = $('[data-act="refresh"]', el);
    r.disabled = scanning;
    r.innerHTML = scanning ? `<span class="spinner"></span> <span>Scanning…</span>` : `${icon('refresh')} <span>Refresh</span>`;
    r.title = updated ? `Last scanned at ${clock(updated)}. Click to scan again.` : 'Scan again';
  }

  function tipHtml() {
    if (!data || dismissed.has(section)) return '';
    let need = { usb: ['lsusb'], storage: ['lsblk'], pci: ['lspci'] }[section] || [];
    if (section === 'network') {
      need = [];
      if (arr(data.interfaces).some((i) => i.kind === 'wifi')) need.push('iw');
      if (arr(data.interfaces).some((i) => i.kind === 'bridge')) need.push('bridge');
    }
    const missing = need.filter((t) => tools()[t] === false);
    if (!missing.length) return '';
    const pkgs = [...new Set(missing.map((t) => TOOL_PKG[t]))].join(' ');
    return `<div class="callout dv-tipbox"><span>${icon('info')}</span><div><b>Some details are missing.</b> ${esc(missing.join(', '))} ${missing.length === 1 ? "isn't" : "aren't"} installed on ${host}. Install ${missing.length === 1 ? 'it' : 'them'} to see more:${cmdBlock(`sudo apt install ${pkgs}`)}<span class="muted small">On other distributions, install the same packages with your package manager (dnf, pacman, zypper…).</span></div><button type="button" class="icon-btn sm" data-dismiss="1" aria-label="Dismiss tip" title="Dismiss">${icon('x')}</button></div>`;
  }

  // -------------------------------------------------------------- sections ---
  const toggle = (name, label, on) => `<label class="switch small"><input type="checkbox" data-opt="${name}" ${on ? 'checked' : ''}><span></span>${label}</label>`;

  function overviewHtml() {
    const usb = arr(data.usb).filter((d) => !isHub(d));
    const disks = visibleDisks();
    const linksUp = arr(data.interfaces).filter((i) => !isLoopback(i) && i.kind !== 'virtual' && i.state === 'up').length;
    const bt = data.bluetooth || {};
    const btConnected = arr(bt.devices).filter((d) => d.connected).length;
    const btText = !bt.available ? 'Not available' : !bt.controller ? 'No adapter' : bt.controller.powered === false ? 'Off' : String(btConnected);
    const card = (go, ic, n, label, sub = '') => `<button type="button" class="card dv-sum" data-goto="${go}"><span class="dv-ic">${icon(ic)}</span><b>${esc(n)}</b><span class="dv-sum-l">${esc(label)}</span>${sub ? `<span class="muted small">${esc(sub)}</span>` : ''}</button>`;
    return `<div class="dv-sums">
        ${card('usb', 'usb', usb.length, usb.length === 1 ? 'USB device' : 'USB devices', 'plugged in')}
        ${card('storage', 'hdd', disks.length, disks.length === 1 ? 'Disk' : 'Disks', disks.some((d) => d.removable || d.tran === 'usb') ? 'including removable' : '')}
        ${card('network', 'broadcast', linksUp, linksUp === 1 ? 'Network link up' : 'Network links up', 'cables and Wi-Fi')}
        ${card('nearby', 'search', arr(data.neighbors).length, 'Nearby devices', 'on the network')}
        ${card('bluetooth', 'bluetooth', btText, 'Bluetooth connected', bt.available && bt.controller ? 'devices' : '')}
      </div>
      <div class="card dv-activity"><h3>Activity</h3>${
        activity.length
          ? `<ul class="dv-act">${activity.map((a) => `<li data-kind="${a.kind}"><span class="dot" data-kind="${a.kind === 'in' ? 'ok' : ''}"></span><span>${esc(a.text)}</span><span class="muted small">${esc(clock(a.at))}</span></li>`).join('')}</ul>`
          : `<p class="muted dv-act-empty">Nothing yet. Plug in or remove a USB device and it shows up here, for example "SanDisk Ultra connected".</p>`
      }</div>`;
  }

  function usbHtml() {
    const all = arr(data.usb);
    const hubs = all.filter(isHub).length;
    const list = all.filter((d) => (opts.hubs || !isHub(d)) && hit(d.product, d.vendor, d.vendorId, d.productId, d.serial, d.cls));
    const bar = `<div class="dv-optbar">${toggle('hubs', `Show hubs${hubs ? ` (${hubs})` : ''}`, opts.hubs)}</div>`;
    if (!list.length) {
      const lsusbMissing = tools().lsusb === false;
      return bar + emptyState({
        icon: 'usb',
        title: q ? 'No USB device matches your filter' : lsusbMissing ? "USB devices can't be listed yet" : 'No USB devices plugged in',
        body: q ? '' : lsusbMissing ? `<p>The <code>lsusb</code> tool is missing on ${host}. Install it, then refresh:</p>${cmdBlock('sudo apt install usbutils')}` : `<p>Plug something into ${host}, and it appears here within a few seconds.</p>`,
      });
    }
    return `${bar}<div class="dv-grid">${list
      .map((d) => {
        const sp = usbSpeed(d.speed);
        return `<div class="card dv-card ${fresh.has(usbKey(d)) ? 'dv-new' : ''}">
          <span class="dv-ic">${icon(usbIcon(d))}</span>
          <div class="dv-info">
            <b>${esc(d.product || 'Unknown device')}</b>
            ${d.vendor ? `<span class="muted small">${esc(d.vendor)}</span>` : ''}
            <div class="dv-meta"><span class="mono small">${esc(d.vendorId)}:${esc(d.productId)}</span>${sp ? `<span class="pill sm" title="${esc(sp.title)}">${esc(sp.label)}</span>` : ''}${isHub(d) ? '<span class="pill sm">Hub</span>' : ''}<span class="muted small">Bus ${esc(d.bus)} · Device ${esc(d.dev)}</span></div>
            ${d.serial ? `<span class="muted small mono dv-serial">Serial ${esc(d.serial)}</span>` : ''}
          </div></div>`;
      })
      .join('')}</div>`;
  }

  const neighborByMac = () => new Map(arr(data.neighbors).filter((n) => n.mac).map((n) => [n.mac.toLowerCase(), n]));

  function ifaceHtml(i, macs) {
    const physical = i.kind === 'ethernet';
    const wifi = i.wifi && (i.wifi.ssid || i.wifi.signal != null) ? i.wifi : null;
    const up = i.state === 'up';
    const pill = up ? `<span class="pill sm ok">${i.kind === 'virtual' || isLoopback(i) ? 'Up' : 'Connected'}</span>` : `<span class="pill sm">${i.state === 'down' ? (i.kind === 'wifi' ? 'Off' : 'No link') : esc(i.state || 'Unknown')}</span>`;
    const ic = { ethernet: 'plug', wifi: 'wifi', bridge: 'link', virtual: 'layers' }[i.kind] || (isLoopback(i) ? 'activity' : 'plug');
    const speed = linkSpeed(i.speed, i.duplex);
    const w = wifi && wifiBars(wifi.signal);
    const rows = [
      ['MAC address', i.mac ? `<span class="mono">${esc(i.mac)}</span>` : ''],
      ['IP addresses', arr(i.addrs).length ? arr(i.addrs).map((a) => `<span class="mono">${esc(a)}</span>`).join('<br>') : '<span class="muted">None</span>'],
      ['Driver', i.driver ? `<span class="mono">${esc(i.driver)}</span>` : ''],
      ['Wi-Fi network', wifi ? `${esc(wifi.ssid || 'Not connected')}${w ? ` ${barsHtml(w)}` : ''}` : ''],
      ['Part of', i.master ? `bridge <span class="mono">${esc(i.master)}</span>` : ''],
    ].filter(([, v]) => v);
    return `<div class="card dv-iface" data-state="${esc(i.state)}">
      <div class="dv-if-head"><span class="dv-ic">${icon(ic)}</span><div class="dv-if-name"><b class="mono">${esc(i.name)}</b> ${pill}<span class="muted small">${esc(speed)}</span></div></div>
      <dl class="dv-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${physical ? lldpHtml(i) : ''}${i.kind === 'bridge' ? fdbHtml(i, macs) : ''}
    </div>`;
  }

  function lldpHtml(i) {
    const entries = arr(data.lldp).filter((l) => l.iface === i.name);
    if (entries.length) {
      return `<div class="dv-conn"><h4>${icon('link')} Connected to</h4>${entries
        .map((l) => {
          const lines = [
            ['Switch', l.chassis ? `<b>${esc(l.chassis)}</b>${l.description ? ` <span class="muted small">${esc(l.description)}</span>` : ''}` : ''],
            ['Port', l.port ? `<span class="mono">${esc(l.port)}</span>${l.portDescr ? ` <span class="muted">${esc(l.portDescr)}</span>` : ''}` : ''],
            ['VLAN', l.vlan != null && l.vlan !== '' ? esc(l.vlan) : ''],
            ['Management IP', l.mgmtIp ? `<span class="mono">${esc(l.mgmtIp)}</span> <button type="button" class="linklike" data-ssh="${esc(l.mgmtIp)}" title="Open SSH Portal for this address in a new window">SSH</button>` : ''],
            ['Features', l.caps ? esc(Array.isArray(l.caps) ? l.caps.join(', ') : l.caps) : ''],
          ].filter(([, v]) => v);
          return `<dl class="dv-dl">${lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
        })
        .join('')}</div>`;
    }
    if (i.state !== 'up') return '';
    if (tools().lldpctl === false) return `<div class="dv-conn hint"><span class="muted small">To see which switch and port this is plugged into, install lldpd on the remote:</span>${cmdBlock('sudo apt install lldpd')}</div>`;
    return `<div class="dv-conn hint"><span class="muted small">No switch has announced itself on this link. The switch may have LLDP turned off, or it may be an unmanaged one.</span></div>`;
  }

  function fdbHtml(i, macs) {
    const entries = arr(data.fdb).filter((f) => f.bridge === i.name && hit(f.mac, f.vendor, f.port));
    if (!entries.length) return '';
    const byPort = new Map();
    for (const f of entries) byPort.set(f.port, [...(byPort.get(f.port) || []), f]);
    return `<details class="dv-fdb"><summary>Devices behind this bridge (${entries.length})</summary>${[...byPort]
      .map(([port, list]) => `<div class="dv-fdb-port"><b class="mono small">${esc(port)}</b>${list
        .slice(0, 40)
        .map((f) => {
          const n = macs.get(String(f.mac).toLowerCase());
          return `<div class="dv-fdb-row"><span class="mono">${esc(f.mac)}</span><span class="muted small">${esc(f.vendor || '')}</span>${n ? `<span class="small">${esc(n.name || n.ip)}</span>` : ''}</div>`;
        })
        .join('')}${list.length > 40 ? `<span class="muted small">…and ${list.length - 40} more</span>` : ''}</div>`)
      .join('')}</details>`;
  }

  function networkHtml() {
    const macs = neighborByMac();
    const all = arr(data.interfaces);
    const shown = all
      .filter((i) => (opts.loopback || !isLoopback(i)) && (opts.virtual || isLoopback(i) || i.kind !== 'virtual') && hit(i.name, i.mac, i.driver, arr(i.addrs).join(' '), i.wifi?.ssid))
      .sort((a, b) => (b.state === 'up') - (a.state === 'up') || ['ethernet', 'wifi', 'bridge'].indexOf(b.kind) - ['ethernet', 'wifi', 'bridge'].indexOf(a.kind) || a.name.localeCompare(b.name));
    const hiddenVirtual = all.filter((i) => i.kind === 'virtual' && !isLoopback(i)).length;
    const bar = `<div class="dv-optbar">${toggle('virtual', `Show virtual links${hiddenVirtual ? ` (${hiddenVirtual}: ${VIRTUAL_NOTE})` : ''}`, opts.virtual)}${toggle('loopback', 'Show loopback', opts.loopback)}</div>`;
    if (!shown.length) return bar + emptyState({ icon: 'broadcast', title: q ? 'No connection matches your filter' : 'No network connections found', body: '' });
    return `${bar}<div class="dv-ifaces">${shown.map((i) => ifaceHtml(i, macs)).join('')}</div>`;
  }

  function nearbyHtml() {
    const list = arr(data.neighbors)
      .filter((n) => hit(n.ip, n.mac, n.name, n.vendor, n.iface))
      .sort((a, b) => ipNum(a.ip) - ipNum(b.ip) || String(a.ip).localeCompare(String(b.ip)));
    const bar = `<div class="dv-optbar"><button type="button" class="btn btn-sm btn-primary" data-act="find" ${finding ? 'disabled' : ''}>${finding ? '<span class="spinner"></span> Looking… (about 10 s)' : `${icon('search')} Find more devices`}</button><span class="muted small">This list shows devices ${host} has talked to recently. "Find more devices" checks the whole network.</span></div>`;
    if (!list.length) return bar + emptyState({ icon: 'search', title: q ? 'No device matches your filter' : 'No nearby devices seen yet', body: q ? '' : '<p>Press <b>Find more devices</b> to look for everything on the network.</p>' });
    return `${bar}<div class="card dv-table"><div class="table-wrap"><table><thead><tr><th>Device</th><th>IP address</th><th>MAC address</th><th>Maker</th><th>Link</th><th>Status</th><th></th></tr></thead><tbody>${list
      .map((n) => {
        const [kind, label, tip] = NEIGH_STATE[String(n.state).toUpperCase()] || ['', n.state || 'Unknown', ''];
        const ip = esc(n.ip);
        return `<tr><td>${n.name ? `<b>${esc(n.name)}</b>` : '<span class="muted">Unnamed</span>'}</td><td class="mono">${ip}</td><td class="mono small">${esc(n.mac || '')}</td><td>${esc(n.vendor || '')}</td><td class="mono small">${esc(n.iface || '')}</td>
          <td><span class="pill sm ${kind}" title="${esc(tip)}">${esc(label)}</span></td>
          <td class="row-actions"><button type="button" class="btn btn-sm" data-ping="${ip}">${icon('zap')} Ping</button><button type="button" class="btn btn-sm" data-ports="${ip}">${icon('shield')} Check ports</button><button type="button" class="btn btn-sm" data-ssh="${ip}">${icon('terminal')} SSH</button>${n.mac ? `<button type="button" class="btn btn-sm" data-wake="${esc(n.mac)}" data-name="${esc(n.name || n.ip)}" title="Send a Wake-on-LAN packet">${icon('power')} Wake</button>` : ''}</td></tr>`;
      })
      .join('')}</tbody></table></div></div>`;
  }

  const visibleDisks = () => arr(data.storage).filter((d) => !/^(loop|ram|zram)/.test(d.name || ''));

  function partRow(p, depth) {
    const mounts = arr(p.mountpoints).filter(Boolean);
    const used = num(p.fsused);
    const avail = num(p.fsavail);
    const total = used != null && avail != null ? used + avail : null;
    const pct = total ? (used / total) * 100 : null;
    const links = mounts.map((m) => (m.startsWith('/') ? `<button type="button" class="linklike mono" data-open-path="${esc(m)}" title="Open in Files">${esc(m)}</button>` : `<span class="muted mono">${esc(m)}</span>`)).join(', ');
    return `<div class="dv-part" style="--depth:${depth}">
      <div class="dv-part-main"><b>${esc(p.label || p.name)}</b><span class="muted small mono">${esc(p.name)}</span>${p.fstype ? `<span class="pill sm">${esc(p.fstype)}</span>` : ''}<span class="muted small">${esc(formatBytes(num(p.size)))}</span></div>
      <div class="dv-part-mount small">${links || '<span class="muted">Not mounted</span>'}</div>
      ${pct != null ? `<div class="dv-usage"><div class="bar${pct > 90 ? ' warn' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div><span class="small muted">${esc(formatBytes(used))} used of ${esc(formatBytes(total))}</span></div>` : ''}
    </div>${arr(p.children).map((c) => partRow(c, depth + 1)).join('')}`;
  }

  function storageHtml() {
    const list = visibleDisks().filter((d) => hit(d.model, d.vendor, d.name, d.path, d.tran, JSON.stringify(arr(d.children).map((c) => [c.label, c.fstype, c.mountpoints])), arr(d.mountpoints).join(' ')));
    if (!list.length) return emptyState({ icon: 'hdd', title: q ? 'No disk matches your filter' : tools().lsblk === false ? "Disks can't be listed yet" : 'No disks found', body: !q && tools().lsblk === false ? `<p>The <code>lsblk</code> tool is missing on ${host}:</p>${cmdBlock('sudo apt install util-linux')}` : '' });
    return `<div class="dv-disks">${list
      .map((d) => {
        const tran = String(d.tran || '').toLowerCase();
        const tranLabel = { usb: 'USB', sata: 'SATA', nvme: 'NVMe', ata: 'SATA', sas: 'SAS', mmc: 'SD/eMMC', virtio: 'Virtual' }[tran] || (tran ? tran.toUpperCase() : '');
        const parts = arr(d.children);
        const own = !parts.length && (arr(d.mountpoints).length || d.fstype) ? partRow({ ...d, label: d.label || '' }, 0) : '';
        return `<div class="card dv-disk">
          <div class="dv-disk-head"><span class="dv-ic">${icon(tran === 'usb' ? 'usb' : 'hdd')}</span>
            <div class="dv-info"><b>${esc(d.model || d.vendor || d.name)}</b><span class="muted small mono">${esc(d.path || `/dev/${d.name}`)}${d.vendor && d.model ? ` · ${esc(String(d.vendor).trim())}` : ''}</span></div>
            <div class="dv-badges"><span class="pill sm">${esc(formatBytes(num(d.size)))}</span>${tranLabel ? `<span class="pill sm">${esc(tranLabel)}</span>` : ''}${d.removable ? '<span class="pill sm warn">Removable</span>' : ''}</div></div>
          ${own}${parts.map((p) => partRow(p, 0)).join('')}${!parts.length && !own ? '<p class="muted small dv-noparts">No partitions or filesystems.</p>' : ''}
        </div>`;
      })
      .join('')}</div>`;
  }

  function pciHtml() {
    const list = arr(data.pci).filter((p) => hit(p.cls, p.vendor, p.device, p.slot));
    if (!list.length) return emptyState({ icon: 'cpu', title: q ? 'No device matches your filter' : tools().lspci === false ? "PCI devices can't be listed yet" : 'No PCI devices found', body: !q && tools().lspci === false ? `<p>The <code>lspci</code> tool is missing on ${host}:</p>${cmdBlock('sudo apt install pciutils')}` : '<p>Virtual machines and small boards often have none.</p>' });
    const groups = new Map();
    for (const p of list) groups.set(p.cls || 'Other', [...(groups.get(p.cls || 'Other') || []), p]);
    return `<div class="dv-groups">${[...groups]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cls, items]) => `<details class="card dv-group" data-group="${esc(cls)}" ${q || !collapsed.has(cls) ? 'open' : ''}><summary><b>${esc(cls)}</b><span class="pill sm">${items.length}</span></summary><div class="table-wrap"><table><tbody>${items.map((p) => `<tr><td class="mono small muted">${esc(p.slot)}</td><td>${esc(p.vendor)}</td><td>${esc(p.device)}</td></tr>`).join('')}</tbody></table></div></details>`)
      .join('')}</div>`;
  }

  function bluetoothHtml() {
    const bt = data.bluetooth || {};
    if (!bt.available) {
      return emptyState({
        icon: 'bluetooth',
        title: `Bluetooth isn't available on ${host}`,
        body: `<p>Either the machine has no Bluetooth hardware, or the <b>bluez</b> software isn't installed. To check and install it:</p>${cmdBlock('sudo apt install bluez')}`,
      });
    }
    const c = bt.controller;
    const card = c
      ? `<div class="card dv-bt-ctl"><span class="dv-ic">${icon('bluetooth')}</span><div class="dv-info"><b>${esc(c.name || 'Bluetooth adapter')}</b><span class="muted small mono">${esc(c.address || '')}</span></div><span class="pill sm ${c.powered ? 'ok' : ''}">${c.powered ? 'On' : 'Off'}</span></div>${c.powered === false ? `<div class="callout small">The adapter is switched off. Turn it on from a terminal:${cmdBlock('bluetoothctl power on')}</div>` : ''}`
      : emptyState({ icon: 'bluetooth', title: 'No Bluetooth adapter found', body: '<p>bluez is installed, but no adapter is plugged in or enabled.</p>' });
    const devs = arr(bt.devices)
      .filter((d) => hit(d.name, d.mac))
      .sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0) || (b.paired ? 1 : 0) - (a.paired ? 1 : 0) || String(a.name || a.mac).localeCompare(String(b.name || b.mac)));
    const list = devs.length
      ? `<div class="dv-list">${devs.map((d) => `<div class="card dv-bt-dev ${d.connected ? 'on' : ''}"><span class="dv-ic">${icon('bluetooth')}</span><div class="dv-info"><b>${esc(d.name || 'Unnamed device')}</b><span class="muted small mono">${esc(d.mac)}</span></div>${d.paired ? '<span class="pill sm">Paired</span>' : ''}${d.connected ? '<span class="pill sm ok">Connected</span>' : '<span class="pill sm">Not connected</span>'}</div>`).join('')}</div>`
      : `<p class="muted empty-note">${q ? 'No device matches your filter.' : 'No Bluetooth devices known yet. Pair one from a terminal with <code>bluetoothctl</code> (then <code>scan on</code> and <code>pair &lt;address&gt;</code>).'}</p>`;
    return card + list;
  }

  const RENDER = { overview: overviewHtml, usb: usbHtml, network: networkHtml, nearby: nearbyHtml, storage: storageHtml, pci: pciHtml, bluetooth: bluetoothHtml };

  function render() {
    syncChrome();
    let html;
    if (error && !data) {
      html = emptyState({ icon: 'alert', kind: 'err', title: "Couldn't scan devices", body: `<p>${esc(error)}</p>`, actions: `<button type="button" class="btn btn-primary" data-act="refresh">${icon('refresh')} Try again</button>` });
      tipEl.innerHTML = '';
    } else if (!data) {
      html = loadingHtml(`Scanning ${info.host}…`);
      tipEl.innerHTML = '';
    } else {
      html = RENDER[section]();
      const tip = tipHtml();
      if (tip !== tipEl._html) tipEl.innerHTML = tipEl._html = tip;
    }
    if (html !== lastHtml) {
      lastHtml = html;
      body.innerHTML = html;
    }
  }

  function go(sec) {
    if (!INFO[sec]) return;
    section = sec;
    q = '';
    $('input', searchBox).value = '';
    lastHtml = '';
    tipEl._html = null;
    body.scrollTop = 0;
    render();
  }

  // ---------------------------------------------------------------- events ---
  $('input', searchBox).addEventListener('input', (e) => {
    q = e.target.value.trim();
    render();
  });
  body.addEventListener('toggle', (e) => {
    const g = e.target.dataset?.group;
    if (!g) return;
    if (e.target.open) collapsed.delete(g);
    else if (!q) collapsed.add(g);
  }, true);
  el.addEventListener('change', (e) => {
    const o = e.target.dataset?.opt;
    if (!o) return;
    opts[o] = e.target.checked;
    render();
  });
  el.addEventListener('click', async (e) => {
    const t = e.target;
    const sec = t.closest('[data-sec]');
    if (sec) return go(sec.dataset.sec);
    const goto = t.closest('[data-goto]');
    if (goto) return go(goto.dataset.goto);
    if (t.closest('[data-dismiss]')) {
      dismissed.add(section);
      return render();
    }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'refresh') return scan();
    if (act === 'find') {
      finding = true;
      render();
      try {
        await session.req('net.scan');
      } catch (err) {
        toast(err.message, 'error');
      }
      finding = false;
      await scan({ quiet: true });
      render();
      return;
    }
    const path = t.closest('[data-open-path]');
    if (path) return actions.openFiles(path.dataset.openPath);
    const ping = t.closest('[data-ping]');
    if (ping) return actions.openNetwork('tools', { tool: 'ping', target: ping.dataset.ping });
    const ports = t.closest('[data-ports]');
    if (ports) return actions.openNetwork('ports', { ports: ports.dataset.ports });
    const ssh = t.closest('[data-ssh]');
    if (ssh) return void window.open(`${location.pathname}?connect=${encodeURIComponent(`${info.username}@${ssh.dataset.ssh}`)}`, '_blank', 'noopener');
    const wake = t.closest('[data-wake]');
    if (wake) {
      try {
        await session.req('wol', { mac: wake.dataset.wake });
        toast(`Wake-up signal sent to ${wake.dataset.name}. Give it a moment to boot.`, 'success', 5000);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  return {
    el,
    show(sec) {
      visible = true;
      if (sec && sec !== section) go(sec);
      else syncChrome();
      if (!data) {
        render();
        scan();
      } else render();
      pollUsb();
    },
    hide() {
      visible = false;
      clearTimeout(usbTimer);
      clearTimeout(rescanTimer);
    },
    open(sec) {
      go(sec);
    },
    dispose() {
      visible = false;
      clearTimeout(usbTimer);
      clearTimeout(rescanTimer);
    },
  };
}
