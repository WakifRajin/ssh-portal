// Backend for the Services, Logs, Docker and Devices panels: validators,
// remote command builders and parsers for the output of those commands.
// Everything that reaches a remote shell is validated with a strict regex and
// quoted with shq(). server.js owns the SSH side (sudo, exec, streaming).

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const clampInt = (v, lo, hi, def) => {
  if (v === '' || v == null) return def;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
};

// Split marker-delimited output ("--NAME--" lines) into { NAME: [lines] }.
function sections(text, first = null) {
  const out = {};
  let cur = first;
  if (cur) out[cur] = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^--([A-Z0-9]+)--$/);
    if (m) out[(cur = m[1])] = [];
    else if (cur) out[cur].push(line);
  }
  return out;
}
const lastSeg = (p) => String(p || '').split('/').filter(Boolean).pop() || '';

// ------------------------------------------------------------- services ---

const UNIT_RE = /^[A-Za-z0-9@:._\\-]{1,200}$/;
const UNIT_SUFFIX = /\.(service|socket|timer|target|mount|automount|path|slice|scope|swap|device)$/;

export function validUnit(u) {
  if (typeof u !== 'string' || !UNIT_RE.test(u) || u.startsWith('-')) throw new Error('Invalid unit name');
  return UNIT_SUFFIX.test(u) ? u : `${u}.service`;
}

export const scopeOf = (s) => (s === 'user' ? 'user' : 'system');
const userFlag = (scope) => (scope === 'user' ? '--user ' : '');

export function svcListCommand(scope) {
  const u = userFlag(scope);
  return `command -v systemctl >/dev/null 2>&1 || { echo '--NOSYSTEMD--'; exit 0; }; echo '--UNITS--'; systemctl ${u}list-units --type=service --all --no-legend --no-pager --plain; echo '--FILES--'; systemctl ${u}list-unit-files --type=service --no-legend --no-pager`;
}

// stdout of svcListCommand -> sorted unit list (loaded units + installed files)
export function parseSvcList(stdout) {
  const sec = sections(stdout);
  const units = new Map();
  for (const line of sec.UNITS || []) {
    // some systemd versions prefix failed/inactive units with a bullet
    const m = line.replace(/^[\s●○×*↻]+/u, '').match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m || !m[1].endsWith('.service')) continue;
    units.set(m[1], { unit: m[1], description: m[5].trim(), load: m[2], active: m[3], sub: m[4], enabled: '' });
  }
  for (const line of sec.FILES || []) {
    const p = line.trim().split(/\s+/);
    const unit = p[0];
    if (!unit || !unit.endsWith('.service')) continue;
    const known = units.get(unit);
    if (known) known.enabled = p[1] || '';
    else if (!unit.endsWith('@.service')) units.set(unit, { unit, description: '', load: 'not-loaded', active: 'inactive', sub: 'dead', enabled: p[1] || '' });
  }
  return [...units.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
}

const STATUS_PROPS = ['Description', 'ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'MemoryCurrent', 'CPUUsageNSec', 'ActiveEnterTimestamp', 'FragmentPath', 'Restart', 'NRestarts'];

export function svcStatusCommand(unit, scope) {
  const u = userFlag(scope);
  const q = shq(validUnit(unit));
  // status exits non-zero for inactive units; that is normal, so fold it into the output
  return `systemctl ${u}show -p ${STATUS_PROPS.join(',')} -- ${q}; echo '--STATUS--'; systemctl ${u}status --no-pager -n 0 -- ${q} 2>&1`;
}

export function parseSvcStatus(unit, stdout) {
  const sec = sections(stdout, 'PROPS');
  const props = Object.fromEntries(STATUS_PROPS.map((k) => [k, '']));
  for (const line of sec.PROPS) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i) in props) props[line.slice(0, i)] = line.slice(i + 1);
  }
  return { unit, props, text: (sec.STATUS || []).join('\n').trim() };
}

const SVC_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'];
export function svcActionCommand(unit, action, scope) {
  if (!SVC_ACTIONS.includes(action)) throw new Error('Invalid action');
  return `systemctl ${userFlag(scope)}${action} -- ${shq(validUnit(unit))}`;
}

// ----------------------------------------------------------------- logs ---

const SINCE = { '15m': '--since=-15min', '1h': '--since=-1h', '6h': '--since=-6h', today: '--since=today', boot: '-b', all: '' };

// Streaming journal command. `sudo` prefixes `sudo -S -p ''` (the caller then
// writes the password to the channel). Falls back to plain log files when the
// remote has no journald.
export function journalCommand(a, { sudo = false } = {}) {
  const lines = clampInt(a.lines, 10, 5000, 300);
  const follow = a.follow !== false;
  const scope = scopeOf(a.scope);
  const args = [];
  if (scope === 'user') args.push('--user');
  args.push('-o json', '--no-pager', `-n ${lines}`);
  if (follow) args.push('-f');
  if (a.unit) args.push(`-u ${shq(validUnit(a.unit))}`);
  if (a.priority != null && a.priority !== '') {
    const p = Number(a.priority);
    if (!Number.isInteger(p) || p < 0 || p > 7) throw new Error('Priority must be 0-7');
    args.push(`-p ${p}`);
  }
  if (a.grep != null && a.grep !== '') {
    const g = String(a.grep).replace(/\0/g, '');
    if (g.length > 200) throw new Error('Search text is too long');
    args.push(`--grep=${shq(g)}`);
  }
  const since = a.since == null || a.since === '' ? 'all' : a.since;
  if (!(since in SINCE)) throw new Error('Invalid time range');
  if (SINCE[since]) args.push(SINCE[since]);
  // user journals are readable by the user; root would not even see the user bus
  const useSudo = sudo && scope !== 'user';
  const pre = useSudo ? "sudo -S -p '' " : '';
  const command = `if command -v journalctl >/dev/null 2>&1; then ${pre}journalctl ${args.join(' ')}; else ${pre}tail -q -n ${lines}${follow ? ' -F' : ''} /var/log/syslog /var/log/messages 2>/dev/null; fi`;
  return { command, sudo: useSudo };
}

// ---------------------------------------------------------------- docker ---

const DOCKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/;
export function validDockerId(id) {
  if (typeof id !== 'string' || !DOCKER_ID_RE.test(id)) throw new Error('Invalid container or image id');
  return id;
}
const runtimeOf = (rt) => {
  if (rt !== 'docker' && rt !== 'podman') throw new Error('Docker or Podman is not installed');
  return rt;
};

export function dockerLogsCommand(rt, a, { sudo = false } = {}) {
  const tail = clampInt(a.tail, 10, 5000, 300);
  const pre = sudo ? "sudo -S -p '' " : '';
  return `${pre}${runtimeOf(rt)} logs ${a.follow !== false ? '-f ' : ''}--tail ${tail} --timestamps -- ${shq(validDockerId(a.id))} 2>&1`;
}

const DOCKER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'rm', 'rmi'];
export function dockerActionCommand(rt, action, id) {
  if (!DOCKER_ACTIONS.includes(action)) throw new Error('Invalid action');
  return `${runtimeOf(rt)} ${action} -- ${shq(validDockerId(id))}`;
}

export function dockerInspectCommand(rt, id, kind) {
  return `${runtimeOf(rt)} inspect --type ${kind === 'image' ? 'image' : 'container'} -- ${shq(validDockerId(id))}`;
}

// permission problem talking to the docker socket (needs sudo / docker group)
export const isDockerPermission = (text) => /permission denied/i.test(text) && /docker\.sock|podman/i.test(text);

export function dockerErrorCode(text) {
  const t = String(text || '');
  if (isDockerPermission(t)) return 'PERMISSION';
  if (/cannot connect to the docker daemon|is the docker daemon running|cannot connect to podman|connection refused|no such file or directory.*sock/i.test(t)) return 'DAEMON_DOWN';
  return t.trim().slice(0, 300) || 'Unexpected response from the container runtime';
}

// `{{json .}}` gives one object per line (docker) or sometimes one array (podman)
function jsonRows(lines) {
  const text = lines.join('\n').trim();
  if (!text) return [];
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [j];
  } catch {}
  const rows = [];
  for (const l of lines) {
    const s = l.trim();
    if (!s.startsWith('{')) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {}
  }
  return rows;
}
const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k];
  return '';
};
const short = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);
const pct = (v) => (typeof v === 'number' ? `${v.toFixed(2)}%` : String(v));
const sizeStr = (v) => (typeof v === 'number' ? `${(v / 1e6).toFixed(1)}MB` : String(v));
const dateStr = (v) => (typeof v === 'number' ? new Date(v * 1000).toISOString() : String(v));
const portsStr = (p) => (Array.isArray(p) ? p.map((x) => `${x.host_port ? `${x.host_ip || '0.0.0.0'}:${x.host_port}->` : ''}${x.container_port}/${x.protocol || 'tcp'}`).join(', ') : String(p || ''));
const firstName = (n) => (Array.isArray(n) ? String(n[0] || '') : String(n || '').split(',')[0]).replace(/^\//, '');

export function parseDockerList(rt, stdout, stderr = '') {
  const empty = (error) => ({ runtime: rt, error, containers: [], images: [], volumes: [], networks: [] });
  const sec = sections(stdout);
  if (sec.NOTINSTALLED) return { ...empty('NOT_INSTALLED'), runtime: null };
  if (sec.ERROR) return empty(dockerErrorCode(sec.ERROR.join('\n')));
  if (!sec.PS) return empty(dockerErrorCode(stderr || stdout));

  const stats = jsonRows(sec.STATS || []).map((s) => ({
    id: String(pick(s, 'ID', 'Id', 'id', 'Container')),
    name: firstName(pick(s, 'Name', 'name')),
    cpu: pct(pick(s, 'CPUPerc', 'CPU', 'cpu_percent')),
    mem: String(pick(s, 'MemUsage', 'mem_usage')),
    memPerc: pct(pick(s, 'MemPerc', 'mem_percent')),
    netIO: String(pick(s, 'NetIO', 'net_io')),
    blockIO: String(pick(s, 'BlockIO', 'block_io')),
  }));
  const containers = jsonRows(sec.PS).map((c) => {
    const id = short(pick(c, 'ID', 'Id', 'id'));
    const name = firstName(pick(c, 'Names', 'Name'));
    const s = stats.find((x) => (x.id && id && (x.id.startsWith(id) || id.startsWith(x.id))) || (x.name && x.name === name));
    const state = String(pick(c, 'State') || '');
    return {
      id,
      name,
      image: String(pick(c, 'Image')),
      state,
      status: String(pick(c, 'Status') || state),
      ports: portsStr(pick(c, 'Ports')),
      created: dateStr(pick(c, 'CreatedAt', 'Created')),
      cpu: s?.cpu ?? '',
      mem: s?.mem ?? '',
      memPerc: s?.memPerc ?? '',
      netIO: s?.netIO ?? '',
      blockIO: s?.blockIO ?? '',
    };
  });
  const images = jsonRows(sec.IMAGES || []).map((i) => {
    let repo = String(pick(i, 'Repository'));
    let tag = String(pick(i, 'Tag'));
    if (!repo && Array.isArray(i.Names) && i.Names[0]) {
      const n = String(i.Names[0]);
      const k = n.lastIndexOf(':');
      if (k > n.lastIndexOf('/')) [repo, tag] = [n.slice(0, k), n.slice(k + 1)];
      else repo = n;
    }
    return { id: short(pick(i, 'ID', 'Id', 'id')), repo: repo || '<none>', tag: tag || '<none>', size: sizeStr(pick(i, 'Size')), created: dateStr(pick(i, 'CreatedSince', 'CreatedAt', 'Created')) };
  });
  const volumes = jsonRows(sec.VOLUMES || []).map((v) => ({ name: String(pick(v, 'Name', 'name')), driver: String(pick(v, 'Driver', 'driver')) }));
  const networks = jsonRows(sec.NETWORKS || []).map((n) => ({ id: short(pick(n, 'ID', 'Id', 'id')), name: String(pick(n, 'Name', 'name')), driver: String(pick(n, 'Driver', 'driver')), scope: String(pick(n, 'Scope', 'scope')) }));
  return { runtime: rt, error: null, containers, images, volumes, networks };
}

// --------------------------------------------------------------- devices ---

const USB_CLASS = { '09': 'hub', '08': 'storage', '03': 'hid', '01': 'audio', '0e': 'video', e0: 'wireless', '07': 'printer', '02': 'comm', '0a': 'comm' };

function parseUsb(sec) {
  const lsusb = [];
  for (const l of sec.LSUSB || []) {
    const m = l.match(/^Bus (\d+) Device (\d+): ID ([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/i);
    if (m) lsusb.push({ bus: +m[1], dev: +m[2], vendorId: m[3].toLowerCase(), productId: m[4].toLowerCase(), desc: m[5].trim() });
  }
  const usb = [];
  for (const l of sec.USB || []) {
    if (!l.startsWith('U\t')) continue;
    const [, bus, dev, vid, pid, man, prd, spd, dcl, icl, ser] = l.split('\t');
    const vendorId = (vid || '').toLowerCase();
    // class 00 means "see interfaces"; ef is the misc/IAD wrapper used by webcams
    const dc = (dcl || '').toLowerCase();
    const code = !dc || dc === '00' || dc === 'ef' ? (icl || dc).toLowerCase() : dc;
    const hub = vendorId === '1d6b' || code === '09';
    let vendor = man || '';
    let product = prd || '';
    if (!vendor && !product) product = lsusb.find((x) => x.bus === +bus && x.dev === +dev)?.desc || '';
    usb.push({ bus: +bus, dev: +dev, vendorId, productId: (pid || '').toLowerCase(), vendor, product, speed: spd || '', cls: hub ? 'hub' : USB_CLASS[code] || 'other', serial: ser || '', hub });
  }
  if (!usb.length) {
    for (const x of lsusb) {
      const hub = x.vendorId === '1d6b' || /\bhub\b/i.test(x.desc);
      usb.push({ bus: x.bus, dev: x.dev, vendorId: x.vendorId, productId: x.productId, vendor: '', product: x.desc, speed: '', cls: hub ? 'hub' : 'other', serial: '', hub });
    }
  }
  return usb.sort((a, b) => a.bus - b.bus || a.dev - b.dev);
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function normBlock(d) {
  const mps = Array.isArray(d.mountpoints) ? d.mountpoints : [d.mountpoint];
  return {
    name: d.name || '',
    path: d.path || (d.name ? `/dev/${d.name}` : ''),
    size: Number(d.size) || 0,
    type: d.type || '',
    model: String(d.model || '').trim(),
    vendor: String(d.vendor || '').trim(),
    tran: d.tran || '',
    mountpoints: mps.filter(Boolean),
    fstype: d.fstype || '',
    label: d.label || '',
    removable: truthy(d.rm),
    fsused: numOrNull(d.fsused),
    fsavail: numOrNull(d.fsavail),
    children: (d.children || []).map(normBlock),
  };
}

function parseStorage(lines) {
  try {
    const j = JSON.parse(lines.join('\n'));
    // loop/ram devices are snap and zram noise
    return (j.blockdevices || []).filter((d) => d.type !== 'loop' && d.type !== 'ram').map(normBlock);
  } catch {
    return [];
  }
}

function parsePci(lines) {
  const q = '"((?:[^"\\\\]|\\\\.)*)"';
  const re = new RegExp(`^(\\S+)\\s+${q}\\s+${q}\\s+${q}`);
  const un = (s) => s.replace(/\\(.)/g, '$1');
  const out = [];
  for (const l of lines) {
    const m = l.match(re);
    if (m) out.push({ slot: m[1], cls: un(m[2]), vendor: un(m[3]), device: un(m[4]) });
  }
  return out;
}

function parseBluetooth(sec, haveTool) {
  const none = { available: false, controller: null, devices: [] };
  if (!haveTool) return none;
  const show = (sec.BTSHOW || []).join('\n');
  const c = show.match(/^Controller\s+([0-9A-F:]{17})/im);
  if (!c) return none;
  const field = (k) => show.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'im'))?.[1].trim() || '';
  const list = (lines) => {
    const m = new Map();
    for (const l of lines) {
      const d = l.match(/^Device\s+([0-9A-F:]{17})\s*(.*)$/i);
      if (d) m.set(d[1].toUpperCase(), d[2].trim());
    }
    return m;
  };
  const paired = list(sec.BTPAIRED || []);
  // old bluetoothctl rejects the filter: connected state is then unknown (false)
  const connLines = sec.BTCONN || [];
  const connected = connLines.some((l) => l.startsWith('!')) ? new Map() : list(connLines);
  const devices = [];
  for (const mac of new Set([...paired.keys(), ...connected.keys()])) {
    devices.push({ mac, name: paired.get(mac) || connected.get(mac) || mac, connected: connected.has(mac), paired: paired.has(mac) });
  }
  return { available: true, controller: { name: field('Name') || field('Alias'), address: c[1].toUpperCase(), powered: /^yes$/i.test(field('Powered')) }, devices };
}

function parseIfaces(sec) {
  const addrs = new Map();
  for (const l of sec.ADDR || []) {
    const m = l.match(/^\d+:\s+(\S+?)(?:@\S+)?\s+inet6?\s+(\S+)/);
    if (m) addrs.set(m[1], [...(addrs.get(m[1]) || []), m[2]]);
  }
  const wifi = new Map();
  for (const l of sec.NMWIFI || []) {
    const m = l.match(/^yes:([^:]+):(\d+):(.*)$/);
    // nmcli only reports a percentage; map it to a rough dBm like NetworkManager does
    if (m) wifi.set(m[1], { ssid: m[3].replace(/\\(.)/g, '$1'), signal: Math.round(Number(m[2]) / 2 - 100) });
  }
  for (const l of sec.IFACES || []) {
    const p = l.split('\t');
    if (p[0] === 'WIFI' && p[1]) wifi.set(p[1], { ssid: p[2] || '', signal: numOrNull(p[3]) });
  }
  const out = [];
  for (const l of sec.IFACES || []) {
    if (!l.startsWith('I\t')) continue;
    const [, name, mac, state, speed, duplex, type, driver, master, w, b, ph] = l.split('\t');
    const sp = Number(speed);
    let kind = 'other';
    if (name === 'lo' || type === '772') kind = 'loopback';
    else if (b === '1') kind = 'bridge';
    else if (w === '1') kind = 'wifi';
    else if (ph === '1') kind = 'ethernet';
    else if (type === '1' || /^(veth|docker|br-|virbr|tun|tap|wg|tailscale|vboxnet|vmnet|zt|cni|flannel|cali|vxlan|dummy|bond|macvlan|ifb)/.test(name)) kind = 'virtual';
    out.push({
      name,
      mac: mac || '',
      state: state || '',
      speed: Number.isFinite(sp) && sp > 0 ? sp : null,
      duplex: duplex || '',
      driver: lastSeg(driver),
      kind,
      master: lastSeg(master),
      addrs: addrs.get(name) || [],
      wifi: wifi.get(name) || null,
    });
  }
  return out;
}

function parseNeighbors(sec) {
  const names = new Map();
  for (const l of sec.NAMES || []) {
    const p = l.split('\t');
    if (p[0] === 'N' && p[1]) names.set(p[1], p[2] || '');
  }
  const out = [];
  for (const l of sec.NEIGH || []) {
    const t = l.trim().split(/\s+/);
    const state = t[t.length - 1];
    const mi = t.indexOf('lladdr');
    if (mi < 0 || /^(FAILED|INCOMPLETE)$/.test(state)) continue;
    out.push({ ip: t[0], mac: t[mi + 1], iface: t[t.indexOf('dev') + 1] || '', state, vendor: null, name: names.get(t[0]) || '' });
  }
  return out;
}

const str = (v) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v));

function parseLldpJson(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const root = Array.isArray(j?.lldp) ? j.lldp[0] : j?.lldp;
  const ifs = root?.interface;
  // `interface` is an object keyed by iface, or an array of such objects
  const entries = Array.isArray(ifs) ? ifs.flatMap((o) => Object.entries(o || {})) : Object.entries(ifs || {});
  return entries.map(([iface, o]) => {
    const ch = o?.chassis || {};
    let name = '';
    let c = ch;
    if (!(ch.id && typeof ch.id === 'object' && 'value' in ch.id)) {
      name = Object.keys(ch)[0] || '';
      c = ch[name] || {};
    }
    const v = Array.isArray(o?.vlan) ? o.vlan[0] : o?.vlan;
    const cap = c.capability;
    const caps = (Array.isArray(cap) ? cap : cap ? [cap] : []).filter((x) => x && x.enabled !== false).map((x) => x.type).join(', ');
    return { iface, chassis: name || str(c.id?.value), description: str(c.descr), port: str(o?.port?.id?.value), portDescr: str(o?.port?.descr), vlan: str(v?.['vlan-id']), mgmtIp: str(c['mgmt-ip']), caps };
  });
}

// `networkctl lldp`: fixed-width table, columns located from the header
const NETWORKCTL_CAPS = { o: 'Other', p: 'Repeater', b: 'Bridge', w: 'Wi-Fi access point', r: 'Router', t: 'Telephone', d: 'DOCSIS', a: 'Station', c: 'Customer VLAN', s: 'Service VLAN', m: 'MAC relay' };
function parseNetworkctl(lines) {
  const hi = lines.findIndex((l) => /^LINK\s+CHASSIS ID/.test(l));
  if (hi < 0) return [];
  const h = lines[hi];
  const cols = ['LINK', 'CHASSIS ID', 'SYSTEM NAME', 'CAPS', 'PORT ID', 'PORT DESCRIPTION'].map((k) => h.indexOf(k));
  const out = [];
  for (const l of lines.slice(hi + 1)) {
    if (!l.trim()) break;
    const cell = (i) => l.slice(cols[i], i + 1 < cols.length ? cols[i + 1] : undefined).trim().replace(/^-$/, '');
    // CAPS is a fixed string like '..b........'; the letters index NETWORKCTL_CAPS
    const caps = [...cell(3)].map((c) => NETWORKCTL_CAPS[c]).filter(Boolean).join(', ');
    out.push({ iface: cell(0), chassis: cell(2) || cell(1), description: '', port: cell(4), portDescr: cell(5), vlan: '', mgmtIp: '', caps });
  }
  return out;
}

function parseFdb(lines) {
  const out = [];
  const seen = new Set();
  for (const l of lines) {
    const m = l.match(/^([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+dev\s+(\S+)/i);
    const br = l.match(/\bmaster\s+(\S+)/);
    if (!m || !br || /\bpermanent\b/.test(l)) continue;
    if (parseInt(m[1].slice(0, 2), 16) & 1) continue; // multicast
    const key = `${m[1]}|${m[2]}|${br[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mac: m[1].toLowerCase(), port: m[2], bridge: br[1], vendor: null });
  }
  return out;
}

export function parseDevices(stdout, only) {
  const sec = sections(stdout);
  const tools = {};
  for (const k of ['lsusb', 'lsblk', 'lspci', 'bluetoothctl', 'lldpctl', 'networkctl', 'bridge', 'iw', 'nmcli']) tools[k] = false;
  for (const l of sec.TOOLS || []) {
    const m = l.match(/^(\w+)=([01])$/);
    if (m) tools[m[1]] = m[2] === '1';
  }
  if (only === 'usb') return { tools, usb: parseUsb(sec) };
  let lldp = parseLldpJson((sec.LLDPJSON || []).join('\n'));
  if (!lldp.length) lldp = parseNetworkctl(sec.NETWORKCTL || []);
  return {
    tools,
    usb: parseUsb(sec),
    storage: parseStorage(sec.LSBLK || []),
    pci: parsePci(sec.PCI || []),
    bluetooth: parseBluetooth(sec, tools.bluetoothctl),
    interfaces: parseIfaces(sec),
    neighbors: parseNeighbors(sec),
    lldp,
    fdb: parseFdb(sec.FDB || []),
  };
}

// ---- MAC vendor lookup ----
const ouiOf = (mac) => {
  const h = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return h.length >= 6 ? h.slice(0, 6) : '';
};
// locally administered bit set (2/6/A/E): phones rotate these, no vendor exists
const randomised = (oui) => '26AE'.includes(oui[1]);

export function collectOuis(data) {
  const set = new Set();
  for (const x of [...data.neighbors, ...data.fdb]) {
    const o = ouiOf(x.mac);
    if (/^[0-9A-F]{6}$/.test(o) && !randomised(o)) set.add(o);
  }
  return [...set].slice(0, 300);
}

export function vendorCommand(ouis) {
  const re = ouis.filter((o) => /^[0-9A-F]{6}$/.test(o)).join('|');
  const files = '/usr/share/ieee-data/oui.txt /usr/share/hwdata/oui.txt /usr/share/arp-scan/ieee-oui.txt /usr/share/nmap/nmap-mac-prefixes';
  // first line of output is the file used; the rest are its matching lines
  return `for f in ${files}; do if [ -r "$f" ]; then echo "$f"; grep -i -E '^(${re})' "$f" </dev/null 2>/dev/null; break; fi; done`;
}

export function parseVendors(stdout) {
  const map = new Map();
  for (const l of String(stdout).split('\n')) {
    const m = l.replace(/\r$/, '').match(/^([0-9A-Fa-f]{6})\s+(?:\(base 16\)\s+)?(\S.*)$/);
    if (m && !map.has(m[1].toUpperCase())) map.set(m[1].toUpperCase(), m[2].trim());
  }
  return map;
}

export function applyVendors(data, map) {
  const look = (mac) => {
    const o = ouiOf(mac);
    if (!o) return null;
    return randomised(o) ? 'Private (randomised MAC)' : map.get(o) || null;
  };
  for (const x of [...data.neighbors, ...data.fdb]) x.vendor = look(x.mac);
}
