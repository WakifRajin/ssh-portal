#!/usr/bin/env node
// SSH Portal bridge.
//
// Browsers cannot open raw TCP sockets, so a page on GitHub Pages cannot speak
// SSH by itself. This small process runs on your computer, listens on
// 127.0.0.1 only, and turns WebSocket / HTTP requests from the web app into
// SSH, SFTP, X11-forwarding (-Y) and port-forwarding operations.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import ssh2 from 'ssh2';
import { WebSocketServer } from 'ws';
import { X11Forwarder } from './x11.js';
import { DESKTOP_START, DESKTOP_STOP, SYSINFO } from './remote-scripts.js';
import { isSea } from 'node:sea';
import { installSelf, setAutostart, autostartEnabled, registerProtocol, uninstall, spawnDetached, openUrl } from './install.js';

const { Client, utils: sshUtils } = ssh2;
const VERSION = '1.2.0';
// Baked in by build.mjs for the downloadable executables.
const BUILD_APP_URL = process.env.SSH_PORTAL_BUILD_APP_URL || '';
const BUILD_REPO = process.env.SSH_PORTAL_BUILD_REPO || '';
const STANDALONE = (() => {
  try {
    return isSea();
  } catch {
    return false;
  }
})();
// Channels kept free on the main connection for SFTP and short exec calls.
const MAIN_CONN_CHANNELS = 6;
const EXTRA_CONN_CHANNELS = 9;
const __dirname = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return path.dirname(process.execPath); // bundled executable
  }
})();

// ---------------------------------------------------------------- config ---

function parseArgs(argv) {
  const opts = { port: 4422, host: '127.0.0.1', origins: [], appUrl: null, newToken: false, background: false, foreground: false, install: false, uninstall: false, autostart: true, fromUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') opts.port = Number(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--origin') opts.origins.push(next());
    else if (a === '--app-url') opts.appUrl = next();
    else if (a === '--new-token') opts.newToken = true;
    else if (a === '--background') opts.background = true;
    else if (a === '--foreground') opts.foreground = true;
    else if (a === '--install') opts.install = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--no-autostart') opts.autostart = false;
    else if (a === '--from-url') opts.fromUrl = next();
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: ssh-portal-bridge [options]

  (no options)    Downloaded app: install, start at login, run in the background.
                  From source (node server.js): run in this terminal.
  --install       Install for this user (start at login + sshportal:// link) and start.
  --uninstall     Remove the login item, the link handler and the installed program.
  --no-autostart  With --install: don't start at login.
  --background    Run without a window, logging to ~/.ssh-portal/bridge.log.
  --foreground    Run in this terminal even for the downloaded app.
  --port          Port to listen on (127.0.0.1 only). Default 4422.
  --origin        Extra allowed web origin (repeatable). *.github.io and localhost are allowed by default.
  --app-url       Your hosted app URL (printed for convenience).
  --new-token     Generate a new pairing token (un-pairs every browser).
Env: SSH_PORTAL_PORT, SSH_PORTAL_ORIGINS (comma separated), SSH_PORTAL_APP_URL, DISPLAY`);
      process.exit(0);
    }
  }
  if (process.env.SSH_PORTAL_PORT) opts.port = Number(process.env.SSH_PORTAL_PORT);
  if (process.env.SSH_PORTAL_ORIGINS) opts.origins.push(...process.env.SSH_PORTAL_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
  if (process.env.SSH_PORTAL_APP_URL && !opts.appUrl) opts.appUrl = process.env.SSH_PORTAL_APP_URL;
  opts.appUrl ||= BUILD_APP_URL || null;
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const CONFIG_DIR = path.join(os.homedir(), '.ssh-portal');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KNOWN_HOSTS_FILE = path.join(CONFIG_DIR, 'known_hosts.json');
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
const LOG_FILE = path.join(CONFIG_DIR, 'bridge.log');

// Without a window there is nobody to read the console: log to a file instead.
if (opts.background) {
  try {
    if (fs.statSync(LOG_FILE).size > 1 << 20) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch {}
  const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const write = (...a) => out.write(`[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : x?.stack || JSON.stringify(x))).join(' ')}
`);
  console.log = console.error = console.warn = write;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

const config = readJson(CONFIG_FILE, {});
if (!config.token || opts.newToken) {
  config.token = crypto.randomBytes(18).toString('base64url');
  writeJson(CONFIG_FILE, config);
}
const TOKEN = config.token;

const ORIGIN_PATTERNS = ['https://*.github.io', 'http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*', ...opts.origins].map(
  (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$', 'i'),
);
// Requests without an Origin header come from non-browser local processes,
// which could read the token file anyway; browsers always send Origin.
const originAllowed = (origin) => !origin || ORIGIN_PATTERNS.some((re) => re.test(origin));

// ---------------------------------------------------------------- helpers ---

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const fingerprint = (key) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

function modeToString(mode) {
  const t = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const bits = 'rwxrwxrwx';
  let s = t;
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-';
  return s;
}
const typeOf = (mode) => {
  const m = mode & 0o170000;
  return m === 0o040000 ? 'dir' : m === 0o120000 ? 'link' : m === 0o100000 ? 'file' : 'other';
};

function agentPath() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    try {
      fs.statSync(pipe);
      return pipe;
    } catch {
      return 'pageant';
    }
  }
  return null;
}

// One-time tickets let plain HTTP/WS requests (downloads, uploads, VNC tunnels)
// piggy-back on an authenticated control connection without exposing the token.
const tickets = new Map();
function issueTicket(session, data) {
  const id = crypto.randomBytes(18).toString('base64url');
  tickets.set(id, { session, ...data, exp: Date.now() + 60_000 });
  return id;
}
function takeTicket(id, kind) {
  const t = tickets.get(id);
  tickets.delete(id);
  if (!t || t.exp < Date.now() || t.kind !== kind || !t.session.conn) return null;
  return t;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
}, 30_000).unref();

// ---------------------------------------------------------------- session ---

class Session {
  constructor(ws) {
    this.ws = ws;
    this.authed = false;
    this.conn = null;
    this.sftp = null;
    this.info = null;
    this.terms = new Map();
    this.apps = new Map();
    this.waiting = new Map();
    this.x11 = new X11Forwarder();
    this.pool = [];
    this.pendingConn = null;
    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('close', () => this.dispose());
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // Ask the browser something (host key confirmation, password prompt...).
  ask(t, payload) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, 180_000);
      this.waiting.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.send({ t, id, ...payload });
    });
  }

  async onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!this.authed) {
      const given = Buffer.from(typeof msg.token === 'string' ? msg.token : '');
      const expected = Buffer.from(TOKEN);
      if (msg.t === 'auth' && given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        this.authed = true;
        this.send({ t: 'authed', version: VERSION, platform: process.platform, display: this.x11.display });
      } else {
        this.send({ t: 'auth-failed' });
        this.ws.close(4001, 'bad token');
      }
      return;
    }
    switch (msg.t) {
      case 'req':
        try {
          const data = await this.handle(msg.op, msg.args || {});
          this.send({ t: 'res', id: msg.id, ok: true, data });
        } catch (e) {
          this.send({ t: 'res', id: msg.id, ok: false, error: e?.message || String(e) });
        }
        break;
      case 'reply':
        this.waiting.get(msg.id)?.(msg.value);
        this.waiting.delete(msg.id);
        break;
      case 'term-in':
        this.terms.get(msg.tid)?.write(msg.data);
        break;
      case 'term-resize':
        this.terms.get(msg.tid)?.setWindow(msg.rows, msg.cols, 0, 0);
        break;
    }
  }

  dispose() {
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    for (const [k, t] of tickets) if (t.session === this) tickets.delete(k);
    for (const p of this.pool) p.conn.end();
    this.pool = [];
    this.conn?.end();
    this.conn = null;
  }

  needConn() {
    if (!this.conn || !this.sftp) throw new Error('Not connected');
  }

  // ------------------------------------------------------------ dispatch ---
  async handle(op, a) {
    switch (op) {
      case 'connect': return this.connect(a);
      case 'disconnect': this.conn?.end(); return true;
      case 'x11.status': return this.x11.probe();
      case 'ping': return true;
    }
    this.needConn();
    switch (op) {
      case 'list': return this.list(a.path);
      case 'stat': return this.statEntry(a.path);
      case 'realpath': return this.p('realpath', a.path);
      case 'mkdir': return this.p('mkdir', a.path);
      case 'rename': return this.p('rename', a.from, a.to);
      case 'touch': return this.touch(a.path);
      case 'chmod': return this.p('chmod', a.path, parseInt(a.mode, 8));
      case 'delete': return this.run(`rm -rf -- ${a.paths.map(shq).join(' ')}`, { check: true });
      case 'copy': return this.run(`cp -a -- ${a.paths.map(shq).join(' ')} ${shq(a.dest)}/`, { check: true });
      case 'move': return this.run(`mv -- ${a.paths.map(shq).join(' ')} ${shq(a.dest)}/`, { check: true });
      case 'search': return this.search(a);
      case 'readText': return this.readText(a.path, a.max);
      case 'writeText': return this.writeText(a.path, a.content);
      case 'exec': return this.run(a.command, { timeout: a.timeout });
      case 'ticket': return this.ticket(a);
      case 'term.open': return this.openTerm(a);
      case 'term.close': this.terms.get(a.tid)?.close(); return true;
      case 'app.launch': return this.launchApp(a);
      case 'app.kill': return this.killApp(a.aid);
      case 'desktop.start': return this.desktopStart(a);
      case 'desktop.stop': return this.runScript(DESKTOP_STOP, [a.mode, String(Number(a.display) || 0)]);
      case 'sysinfo': return this.sysinfo();
      case 'kill': return this.run(`kill -${Number(a.signal) || 15} ${Number(a.pid)}`, { check: true });
      default: throw new Error(`Unknown op ${op}`);
    }
  }

  // promisified sftp call
  p(method, ...args) {
    return new Promise((resolve, reject) => this.sftp[method](...args, (err, res) => (err ? reject(new Error(`${method}: ${err.message}`)) : resolve(res ?? true))));
  }

  // ------------------------------------------------------------- connect ---
  async connect(a) {
    if (this.conn) throw new Error('Already connected');
    const host = String(a.host || '').trim();
    const port = Number(a.port) || 22;
    const username = String(a.username || '').trim();
    if (!host || !username) throw new Error('Host and username are required');

    const methods = [];
    const tryKey = (key, label) => {
      const parsed = sshUtils.parseKey(key, a.passphrase || undefined);
      if (parsed instanceof Error) {
        if (label === 'provided') throw new Error(`Private key: ${parsed.message}`);
        return; // encrypted default key without a passphrase: skip quietly
      }
      methods.push({ type: 'publickey', username, key: Array.isArray(parsed) ? parsed[0] : parsed });
    };
    if (a.privateKey) tryKey(a.privateKey, 'provided');
    if (a.keyPath) tryKey(fs.readFileSync(expandHome(a.keyPath)), 'provided');
    if (a.password) methods.push({ type: 'password', username, password: a.password });
    const agent = a.agent === false ? null : agentPath();
    if (agent) methods.push({ type: 'agent', username, agent });
    if (!a.privateKey && !a.keyPath) {
      for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
        const file = path.join(os.homedir(), '.ssh', name);
        if (fs.existsSync(file)) {
          try {
            tryKey(fs.readFileSync(file), 'default');
          } catch {}
        }
      }
    }
    let kbdUsedPassword = false;
    let kbdAnswers = [];
    methods.push({
      type: 'keyboard-interactive',
      username,
      prompt: async (name, instructions, lang, prompts, finish) => {
        if (a.password && !kbdUsedPassword && prompts.length === 1 && !prompts[0].echo) {
          kbdUsedPassword = true;
          kbdAnswers.push([a.password]);
          return finish([a.password]);
        }
        const answers = await this.ask('prompt', { title: name || `${username}@${host}`, instructions, prompts });
        const final = Array.isArray(answers) ? answers : prompts.map(() => '');
        kbdAnswers.push(final);
        finish(final);
      },
    });

    // Remember the method that succeeds so extra connections (see channelConn)
    // can log in again silently.
    let lastMethod = null;
    const use = (next, m) => {
      lastMethod = m;
      if (m.type === 'keyboard-interactive') kbdAnswers = [];
      next(m);
    };
    let askedPassword = false;
    const authHandler = (methodsLeft, partial, next) => {
      while (methods.length) {
        const m = methods.shift();
        const t = m.type === 'agent' ? 'publickey' : m.type;
        if (!methodsLeft || methodsLeft.includes(t)) return use(next, m);
      }
      if (!askedPassword && (!methodsLeft || methodsLeft.includes('password'))) {
        askedPassword = true;
        this.ask('prompt', { title: `${username}@${host}`, instructions: '', prompts: [{ prompt: 'Password:', echo: false }] }).then((ans) =>
          ans && ans[0] != null ? use(next, { type: 'password', username, password: ans[0] }) : next(false),
        );
        return;
      }
      next(false);
    };

    let connGone = false;
    const hostKey = `${host}:${port}`;
    const hostVerifier = (key, verify) => {
      const fp = fingerprint(key);
      this.hostFp = fp;
      const known = readJson(KNOWN_HOSTS_FILE, {});
      if (known[hostKey] === fp) return verify(true);
      this.ask('hostkey', { host: hostKey, fingerprint: fp, previous: known[hostKey] || null }).then((ok) => {
        if (ok) {
          const k = readJson(KNOWN_HOSTS_FILE, {});
          k[hostKey] = fp;
          writeJson(KNOWN_HOSTS_FILE, k);
        }
        // the user may answer after the handshake already timed out
        if (connGone) return;
        try {
          verify(!!ok);
        } catch {}
      });
    };

    const conn = new Client();
    conn.once('close', () => (connGone = true));
    await new Promise((resolve, reject) => {
      conn.once('ready', resolve);
      conn.once('error', reject);
      conn.connect({ host, port, username, authHandler, hostVerifier, tryKeyboard: true, readyTimeout: 180_000, keepaliveInterval: 15_000 });
    }).catch((e) => {
      conn.end();
      const level = e.level === 'client-authentication' ? 'Authentication failed (all methods rejected)' : e.message;
      throw new Error(level);
    });

    conn.on('x11', (info, accept, reject) => this.x11.handle(accept, reject));
    conn.on('error', (e) => this.send({ t: 'event', kind: 'error', message: e.message }));
    conn.on('close', () => {
      this.conn = null;
      this.sftp = null;
      for (const p of this.pool) if (p.conn !== conn) p.conn.end();
      this.pool = [];
      this.send({ t: 'event', kind: 'closed' });
    });
    this.conn = conn;
    this.pool = [{ conn, chans: 0, max: MAIN_CONN_CHANNELS }];
    this.reuse = { host, port, username, method: lastMethod, kbd: kbdAnswers.slice() };
    this.sftp = await new Promise((resolve, reject) => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
    const home = await this.p('realpath', '.');
    const who = await this.run('uname -sn 2>/dev/null; id -un 2>/dev/null', { timeout: 5000 }).catch(() => ({ stdout: '' }));
    const [uname = '', user = username] = who.stdout.trim().split('\n');
    this.info = { host, port, username: user.trim() || username, home, uname: uname.trim() };
    return this.info;
  }

  // ---------------------------------------------------------------- exec ---
  run(command, { timeout = 30_000, check = false, stdin = null, limit = 4 << 20 } = {}) {
    return new Promise((resolve, reject) => {
      this.conn.exec(command, (err, ch) => {
        if (err) return reject(err);
        const out = [];
        const errOut = [];
        let size = 0;
        const timer = setTimeout(() => ch.close(), timeout);
        ch.on('data', (d) => size < limit && (out.push(d), (size += d.length)));
        ch.stderr.on('data', (d) => size < limit && (errOut.push(d), (size += d.length)));
        ch.on('close', (code) => {
          clearTimeout(timer);
          const res = { code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8') };
          if (check && res.code !== 0) reject(new Error(res.stderr.trim() || `Command failed with code ${res.code}`));
          else resolve(res);
        });
        if (stdin != null) ch.end(stdin);
      });
    });
  }

  runScript(script, args, opts = {}) {
    return this.run(`sh -s -- ${args.map(shq).join(' ')}`, { ...opts, stdin: script });
  }

  // ---------------------------------------------------------------- sftp ---
  entryFrom(name, attrs, dir) {
    return {
      name,
      path: dir === '/' ? `/${name}` : `${dir}/${name}`,
      type: typeOf(attrs.mode),
      size: attrs.size,
      mtime: attrs.mtime,
      mode: modeToString(attrs.mode),
      uid: attrs.uid,
      gid: attrs.gid,
    };
  }

  async list(dir) {
    const items = await this.p('readdir', dir);
    const entries = items.map((it) => {
      const e = this.entryFrom(it.filename, it.attrs, dir);
      const parts = (it.longname || '').split(/\s+/);
      if (parts.length > 3) {
        e.owner = parts[2];
        e.group = parts[3];
      }
      return e;
    });
    // resolve what symlinks point at, so folders behave like folders
    await Promise.all(
      entries
        .filter((e) => e.type === 'link')
        .map(async (e) => {
          e.link = true;
          try {
            const st = await this.p('stat', e.path);
            e.type = typeOf(st.mode) === 'dir' ? 'dir' : 'file';
            e.size = st.size;
          } catch {
            e.type = 'file';
            e.broken = true;
          }
        }),
    );
    return entries;
  }

  async statEntry(p) {
    const st = await this.p('stat', p);
    const name = p.split('/').filter(Boolean).pop() || '/';
    return this.entryFrom(name, st, p.slice(0, p.lastIndexOf('/')) || '/');
  }

  async touch(p) {
    const handle = await this.p('open', p, 'wx');
    await this.p('close', handle);
    return true;
  }

  async search({ path: dir, query, limit = 500 }) {
    const pattern = `*${String(query).replace(/[*?[\]]/g, '\\$&')}*`;
    const res = await this.run(`find ${shq(dir)} -maxdepth 8 -iname ${shq(pattern)} -not -path '*/.git/*' 2>/dev/null | head -n ${Number(limit) || 500}`, { timeout: 30_000 });
    return res.stdout.split('\n').filter(Boolean);
  }

  async readText(p, max = 5 << 20) {
    const st = await this.p('stat', p);
    if (st.size > max) throw new Error(`File is too large to open in the editor (${(st.size / 1048576).toFixed(1)} MB)`);
    const chunks = [];
    await pipeline(this.sftp.createReadStream(p), async function* (src) {
      for await (const c of src) chunks.push(c);
    });
    const buf = Buffer.concat(chunks);
    const binary = buf.subarray(0, 8000).includes(0);
    return { content: binary ? '' : buf.toString('utf8'), binary, size: st.size, mtime: st.mtime };
  }

  async writeText(p, content) {
    await new Promise((resolve, reject) => {
      const ws = this.sftp.createWriteStream(p);
      ws.on('error', reject);
      ws.on('close', resolve);
      ws.end(Buffer.from(content, 'utf8'));
    });
    return true;
  }

  ticket(a) {
    const kinds = ['download', 'tar', 'upload', 'tunnel'];
    if (!kinds.includes(a.kind)) throw new Error('bad ticket kind');
    return issueTicket(this, { kind: a.kind, path: a.path, paths: a.paths, port: Number(a.port), inline: !!a.inline });
  }

  // ---------------------------------------------------- connection pool ---
  // sshd limits channels per connection (MaxSessions, default 10). Long-lived
  // channels (shells, X11 apps) are spread over extra connections that log in
  // again with the method that already worked, so the user signs in once no
  // matter how many terminals are open.
  async openExtraConn() {
    const { host, port, username, method, kbd } = this.reuse;
    if (!method) throw new Error('Cannot open another SSH connection (unknown auth method)');
    let m = method;
    if (method.type === 'keyboard-interactive') {
      const replay = kbd.map((x) => x.slice());
      m = { type: 'keyboard-interactive', username, prompt: (n, i, l, prompts, finish) => finish(replay.shift() || prompts.map(() => '')) };
    }
    let used = false;
    const conn = new Client();
    await new Promise((resolve, reject) => {
      conn.once('ready', resolve);
      conn.once('error', reject);
      conn.connect({
        host,
        port,
        username,
        authHandler: (left, partial, next) => (used ? next(false) : ((used = true), next(m))),
        hostVerifier: (key) => fingerprint(key) === this.hostFp,
        readyTimeout: 30_000,
        keepaliveInterval: 15_000,
      });
    }).catch((e) => {
      conn.end();
      throw new Error(`Could not open an additional SSH connection: ${e.message}`);
    });
    conn.on('x11', (info, accept, reject) => this.x11.handle(accept, reject));
    conn.on('error', () => {});
    const entry = { conn, chans: 0, max: EXTRA_CONN_CHANNELS };
    conn.on('close', () => {
      this.pool = this.pool.filter((p) => p !== entry);
    });
    this.pool.push(entry);
    return entry;
  }

  // Open a long-lived channel on the first connection with room for it.
  async openChannel(open) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let entry = this.pool.find((p) => p.chans < p.max);
      if (!entry) {
        this.pendingConn ??= this.openExtraConn().finally(() => (this.pendingConn = null));
        entry = await this.pendingConn;
      }
      entry.chans++;
      try {
        const ch = await new Promise((resolve, reject) => open(entry.conn, (err, c) => (err ? reject(err) : resolve(c))));
        ch.once('close', () => {
          entry.chans--;
          // drop idle extra connections
          if (entry.chans === 0 && entry.conn !== this.conn) entry.conn.end();
        });
        return ch;
      } catch (e) {
        entry.chans--;
        // server allows fewer sessions than we assumed: mark full and retry elsewhere
        if (/open failed|prohibited|channel/i.test(e.message)) entry.max = entry.chans;
        else throw e;
      }
    }
    throw new Error('Could not open a new SSH channel');
  }

  // ------------------------------------------------------------ terminal ---
  openTerm(a) {
    const useX11 = a.x11 !== false;
    const opts = useX11 ? { x11: this.x11.sshOption() } : {};
    const pty = { term: 'xterm-256color', cols: a.cols || 80, rows: a.rows || 24 };
    return this.openChannel((conn, cb) => conn.shell(pty, opts, cb)).then((ch) => {
      const tid = crypto.randomUUID();
      const dec = new StringDecoder('utf8');
      this.terms.set(tid, ch);
      const emit = (d) => this.send({ t: 'term-data', tid, data: dec.write(d) });
      ch.on('data', emit);
      ch.stderr.on('data', emit);
      ch.on('close', () => {
        this.terms.delete(tid);
        this.send({ t: 'term-exit', tid });
      });
      if (a.cwd) ch.write(`cd -- ${shq(a.cwd)} && clear\n`);
      if (a.command) ch.write(`${a.command}\n`);
      return { tid };
    });
  }

  // ---------------------------------------------------------------- apps ---
  // target "x11": run with X11 forwarding -> windows open on this computer.
  // target "desktop": run inside the remote virtual desktop shown in the browser.
  launchApp(a) {
    const command = String(a.command || '').trim();
    if (!command) throw new Error('No command');
    if (a.target === 'desktop') {
      const d = Number(a.display) || 0;
      return this.run(`DISPLAY=:${d} nohup sh -c ${shq(command)} >/dev/null 2>&1 &`, { timeout: 10_000 }).then(() => ({ detached: true }));
    }
    return this.openChannel((conn, cb) => conn.exec(command, { x11: this.x11.sshOption(), pty: true }, cb)).then((ch) => {
      const aid = crypto.randomUUID();
      const dec = new StringDecoder('utf8');
      this.apps.set(aid, ch);
      const emit = (d) => this.send({ t: 'app-out', aid, data: dec.write(d) });
      ch.on('data', emit);
      ch.stderr.on('data', emit);
      ch.on('exit', (code, signal) => this.send({ t: 'app-exit', aid, code, signal }));
      ch.on('close', () => {
        if (this.apps.delete(aid)) this.send({ t: 'app-exit', aid, closed: true });
      });
      return { aid };
    });
  }

  killApp(aid) {
    const ch = this.apps.get(aid);
    if (!ch) return false;
    try {
      ch.signal('KILL');
    } catch {}
    ch.close();
    return true;
  }

  // ------------------------------------------------------------- desktop ---
  async desktopStart(a) {
    const mode = a.mode === 'share' ? 'share' : 'virtual';
    const display = Number(a.display) || (mode === 'share' ? 0 : 7);
    const geo = /^\d{3,5}x\d{3,5}$/.test(a.geometry || '') ? a.geometry : '1600x900';
    const res = await this.runScript(DESKTOP_START, [mode, String(display), geo], { timeout: 60_000 });
    const vars = Object.fromEntries(
      res.stdout
        .split('\n')
        .map((l) => l.match(/^([A-Z]+)=(.*)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
    if (!vars.PORT) {
      const msg = (res.stdout.match(/ERROR:.*(\n.*)?/)?.[0] || res.stderr || 'Could not start the remote desktop').trim();
      throw new Error(msg);
    }
    return { port: Number(vars.PORT), password: vars.PASS, display: vars.DISPLAY, session: vars.SESSION || null, mode };
  }

  // -------------------------------------------------------------- system ---
  async sysinfo() {
    const res = await this.run(`sh -s`, { stdin: SYSINFO, timeout: 15_000 });
    const out = { df: [], ps: [] };
    let section = 'kv';
    for (const line of res.stdout.split('\n')) {
      if (line === '--DF--') section = 'df';
      else if (line === '--PS--') section = 'ps';
      else if (!line.trim()) continue;
      else if (section === 'kv') {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i).toLowerCase()] = line.slice(i + 1);
      } else if (section === 'df') {
        const p = line.trim().split(/\s+/);
        if (p.length >= 6) out.df.push({ fs: p[0], size: +p[1] * 1024, used: +p[2] * 1024, avail: +p[3] * 1024, mount: p.slice(5).join(' ') });
      } else {
        const p = line.trim().split(/\s+/);
        if (p.length >= 6) out.ps.push({ pid: +p[0], user: p[1], cpu: +p[2], mem: +p[3], time: p[4], cmd: p.slice(5).join(' ') });
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------- http ---

const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition');
    // Chrome Private/Local Network Access preflights
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function fail(res, code, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

const disposition = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

// One-click pairing. The web app opens this page in a popup; when the user
// clicks Allow, the token is handed to the opener with postMessage, pinned to
// the origin shown on screen. Never served to fetch() (no CORS, navigations
// only) and never framed, so other sites can't read or click it.
function pairPage(req, res, url) {
  const origin = url.searchParams.get('origin') || '';
  // where to send the user back if the popup lost its opener (opened as a tab)
  let back = '';
  try {
    const r = new URL(url.searchParams.get('return') || '');
    if (r.origin === origin) back = r.origin + r.pathname + r.search;
  } catch {}
  const valid = /^https?:\/\/[^/]+$/.test(origin) && originAllowed(origin);
  const nonce = crypto.randomBytes(16).toString('base64');
  const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  res.writeHead(valid ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair SSH Portal</title>
<style>
:root{color-scheme:dark light;--bg:#0b0d12;--card:#13161d;--line:#2e3442;--text:#e7eaf0;--muted:#8a93a3;--accent:#7c93ff}
@media (prefers-color-scheme:light){:root{--bg:#f5f6f8;--card:#fff;--line:#d3d8e0;--text:#141820;--muted:#5d6676;--accent:#4b63e6}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px;text-align:center}
.ic{width:52px;height:52px;border-radius:14px;margin:0 auto 14px;display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);font-size:26px}
h1{font-size:18px;margin:0 0 6px}p{margin:0 0 14px;color:var(--muted)}.origin{display:block;font:600 14px ui-monospace,Consolas,monospace;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px;margin:4px 0 16px;word-break:break-all}
.row{display:flex;gap:10px}button{flex:1;height:40px;border-radius:9px;border:1px solid var(--line);background:transparent;color:var(--text);font:600 14px system-ui,sans-serif;cursor:pointer}
button.primary{background:var(--accent);border-color:transparent;color:#fff}.fine{font-size:12px;margin:16px 0 0}
</style></head><body><main class="card">
${valid ? `<div class="ic">&#128279;</div><h1>Allow this website to use the bridge?</h1>
<p>This lets the page below open SSH connections from this computer.</p>
<span class="origin">${escHtml(origin)}</span>
<div class="row"><button id="no">Cancel</button><button id="yes" class="primary" autofocus>Allow</button></div>
<p class="fine">Only allow the SSH Portal page you opened yourself.</p>` : `<h1>Can't pair</h1><p>${escHtml(origin || 'No website')} isn't an allowed origin. Start the bridge with <code>--origin</code> to allow it.</p>`}
</main>
${valid ? `<script nonce="${nonce}">
const origin = ${JSON.stringify(origin)};
document.getElementById('yes').onclick = () => {
  if (!window.opener) {
    const back = ${JSON.stringify(back)};
    if (back) return location.replace(back + '#token=' + encodeURIComponent(${JSON.stringify(TOKEN)}));
    document.querySelector('main').innerHTML = '<h1>Open this from SSH Portal</h1><p>Use the Pair button on the SSH Portal page.</p>';
    return;
  }
  window.opener.postMessage({ type: 'ssh-portal-pair', token: ${JSON.stringify(TOKEN)} }, origin);
  document.querySelector('main').innerHTML = '<div class="ic">&#10003;</div><h1>Paired</h1><p>You can close this window.</p>';
  setTimeout(() => window.close(), 600);
};
document.getElementById('no').onclick = () => window.close();
</script>` : ''}</body></html>`);
}

const authorized = (req) => {
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/pair') {
    // only real page navigations, never fetch() from another site
    if (req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'navigate') return fail(res, 403, 'Forbidden');
    return pairPage(req, res, url);
  }
  if (url.pathname === '/local-token') {
    // the copy of the app served by the bridge itself pairs automatically
    if (req.headers['sec-fetch-site'] !== 'same-origin') return fail(res, 403, 'Forbidden');
    return json(res, 200, { token: TOKEN });
  }

  if (req.headers.origin && !originAllowed(req.headers.origin)) return fail(res, 403, 'Origin not allowed');
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ app: 'ssh-portal-bridge', version: VERSION, repo: BUILD_REPO || null, standalone: STANDALONE }));
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return json(res, 401, { error: 'Not paired' });
    if (url.pathname === '/api/info') return json(res, 200, { version: VERSION, standalone: STANDALONE, autostart: autostartEnabled(), platform: process.platform, logFile: LOG_FILE });
    if (url.pathname === '/api/autostart' && req.method === 'POST') {
      const enabled = url.searchParams.get('enabled') === '1';
      return json(res, 200, { autostart: setAutostart(enabled, launcher()) && enabled });
    }
    if (url.pathname === '/api/quit' && req.method === 'POST') {
      json(res, 200, { ok: true });
      console.log('Stopping (requested by the web app)');
      setTimeout(() => process.exit(0), 200);
      return;
    }
    return json(res, 404, { error: 'Unknown endpoint' });
  }

  if (url.pathname === '/download') {
    const t = tickets.get(url.searchParams.get('ticket'));
    const kind = t?.kind === 'tar' ? 'tar' : 'download';
    const ticket = takeTicket(url.searchParams.get('ticket'), kind);
    if (!ticket) return fail(res, 403, 'Invalid or expired ticket');
    const s = ticket.session;
    try {
      if (kind === 'download') {
        const st = await s.p('stat', ticket.path);
        const name = ticket.path.split('/').pop();
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          ...(ticket.inline ? {} : { 'Content-Disposition': disposition(name) }),
        });
        await pipeline(s.sftp.createReadStream(ticket.path), res);
      } else {
        const paths = ticket.paths;
        const parent = paths[0].slice(0, paths[0].lastIndexOf('/')) || '/';
        const names = paths.map((p) => p.slice(p.lastIndexOf('/') + 1));
        const archive = (paths.length === 1 ? names[0] : parent.split('/').pop() || 'files') + '.tar.gz';
        s.conn.exec(`tar -C ${shq(parent)} -czf - -- ${names.map(shq).join(' ')}`, (err, ch) => {
          if (err) return fail(res, 500, err.message);
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': disposition(archive) });
          ch.pipe(res);
          res.on('close', () => ch.close());
        });
      }
    } catch (e) {
      fail(res, 500, e.message);
    }
    return;
  }

  if (url.pathname === '/upload' && req.method === 'POST') {
    const ticket = takeTicket(url.searchParams.get('ticket'), 'upload');
    if (!ticket) return fail(res, 403, 'Invalid or expired ticket');
    try {
      await pipeline(req, ticket.session.sftp.createWriteStream(ticket.path));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e) {
      fail(res, 500, e.message);
    }
    return;
  }

  // Serve the web app itself, so it also works fully offline at http://127.0.0.1:PORT/
  if (req.method === 'GET') {
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(WEB_ROOT, '.' + rel);
    if (file.startsWith(WEB_ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  fail(res, 404, 'Not found');
}

const server = http.createServer((req, res) => handleHttp(req, res).catch((e) => fail(res, 500, e.message)));

// --------------------------------------------------------------- websocket ---

const wssControl = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
const wssTunnel = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!originAllowed(req.headers.origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  if (url.pathname === '/ws') {
    wssControl.handleUpgrade(req, socket, head, (ws) => new Session(ws));
  } else if (url.pathname === '/tunnel') {
    const ticket = takeTicket(url.searchParams.get('ticket'), 'tunnel');
    if (!ticket) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wssTunnel.handleUpgrade(req, socket, head, (ws) => tunnel(ws, ticket));
  } else {
    socket.destroy();
  }
});

// WebSocket <-> SSH direct-tcpip channel (used for the VNC desktop).
function tunnel(ws, ticket) {
  const queue = [];
  let stream = null;
  ws.on('message', (data) => (stream ? stream.write(data) : queue.push(data)));
  ws.on('close', () => stream?.close());
  ticket.session.conn.forwardOut('127.0.0.1', 0, '127.0.0.1', ticket.port, (err, s) => {
    if (err) return ws.close(1011, err.message.slice(0, 100));
    stream = s;
    for (const d of queue) s.write(d);
    s.on('data', (d) => ws.readyState === 1 && ws.send(d, { binary: true }));
    s.on('close', () => ws.close());
    s.on('error', () => ws.close());
  });
}

// ---------------------------------------------------------------- startup ---

// How to start this program again (login item, sshportal:// link):
// the downloaded build is a single executable; from source it's node + script.
function launcher() {
  return STANDALONE ? [process.execPath] : [process.execPath, path.resolve(process.argv[1])];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runningBridge() {
  try {
    const r = await fetch(`http://127.0.0.1:${opts.port}/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.app === 'ssh-portal-bridge' ? j : null;
  } catch {
    return null;
  }
}

const newer = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function stopRunningBridge() {
  await fetch(`http://127.0.0.1:${opts.port}/api/quit`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }).catch(() => {});
  for (let i = 0; i < 20 && (await runningBridge()); i++) await sleep(250);
}

function startServer() {
  server.listen(opts.port, opts.host, () => {
    const local = `http://127.0.0.1:${opts.port}`;
    if (opts.background) {
      console.log(`SSH Portal bridge v${VERSION} listening on ${local}${opts.fromUrl ? ' (started from the web app)' : ''}`);
      return;
    }
    const line = '─'.repeat(64);
    console.log(`\n ${line}\n  SSH Portal bridge v${VERSION} listening on ${local}\n ${line}`);
    console.log(`  Pair a browser: click "Pair this browser" in the web app.`);
    if (opts.appUrl) console.log(`  Web app       : ${opts.appUrl}`);
    console.log(`  Local app     : ${local}/  (pairs automatically)`);
    console.log(`  Manual token  : ${TOKEN}`);
    console.log(`  X11 display   : ${new X11Forwarder().display}  (windows from "ssh -Y" apps appear here)`);
    console.log(`  Allowed origins: *.github.io, localhost${opts.origins.length ? ', ' + opts.origins.join(', ') : ''}`);
    console.log(` ${line}\n  Keep this window open while you use the web app. Ctrl+C to stop.\n`);
  });
}

// First run of the downloaded app (or --install): copy it somewhere stable,
// start it at login, register sshportal://, and launch it in the background.
async function installAndLaunch() {
  const say = (s = '') => console.log(`  ${s}`);
  console.log(`\n  SSH Portal bridge v${VERSION}\n  ${'─'.repeat(40)}`);
  const running = await runningBridge();
  if (running && !newer(VERSION, running.version)) {
    say(`✓ Already installed and running (v${running.version}).`);
  } else {
    if (running) {
      say(`Updating v${running.version} → v${VERSION}…`);
      await stopRunningBridge();
    } else say('Installing…');
    const start = STANDALONE ? [installSelf()] : launcher();
    const autostart = opts.autostart && setAutostart(true, start);
    if (!opts.autostart) setAutostart(false, start);
    const link = registerProtocol(start);
    spawnDetached(start, ['--background', '--port', String(opts.port)]);
    let ok = false;
    for (let i = 0; i < 40 && !(ok = !!(await runningBridge())); i++) await sleep(250);
    if (!ok) {
      say(`✖ The bridge didn't start. Details: ${LOG_FILE}`);
      return finish(1);
    }
    say('✓ Running in the background');
    if (autostart) say('✓ Starts automatically when you log in');
    if (link) say('✓ The web app can start it with one click');
  }
  say();
  say('Go back to SSH Portal in your browser; it connects by itself.');
  if (opts.appUrl) say(`(${opts.appUrl})`);
  say();
  say('You can close this window.');
  return finish(0);
}

async function finish(code) {
  // keep a double-clicked console window readable for a moment
  if (process.platform === 'win32' && process.stdout.isTTY) await sleep(code ? 15000 : 6000);
  process.exit(code);
}

// One misbehaving SSH connection must never take down every session.
process.on('uncaughtException', (e) => console.error('[bridge] unexpected error:', e?.stack || e));

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${opts.port} is already in use. Try --port 4423` : e);
  process.exit(1);
});

async function main() {
  if (opts.uninstall) {
    await stopRunningBridge();
    uninstall();
    console.log('SSH Portal bridge removed (settings kept in ~/.ssh-portal).');
    return finish(0);
  }
  if (opts.install || (STANDALONE && !opts.background && !opts.foreground)) return installAndLaunch();

  // Launched by a login item or sshportal:// on Windows: a console window may
  // have opened; continue as a hidden child process instead.
  if (opts.background && process.platform === 'win32' && !process.env.SSH_PORTAL_DETACHED) {
    spawnDetached(launcher(), process.argv.slice(2));
    return process.exit(0);
  }

  const running = await runningBridge();
  if (running) {
    if (opts.background) return process.exit(0); // already up: nothing to do
    console.error(`A bridge (v${running.version}) is already running on port ${opts.port}. Stop it first, or use --port.`);
    return process.exit(1);
  }
  startServer();
  if (opts.fromUrl && opts.appUrl && !opts.background) openUrl(opts.appUrl);
}

main();
