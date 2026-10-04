// Client for the local SSH Portal bridge (bridge/server.js).

export const DEFAULT_BRIDGE = 'http://127.0.0.1:4422';

export async function probeBridge(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(`${base}/health`, { signal: ctrl.signal, cache: 'no-store' });
    const j = await r.json();
    return j.app === 'ssh-portal-bridge' ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class BridgeSession extends EventTarget {
  constructor(base, token) {
    super();
    this.base = base.replace(/\/+$/, '');
    this.wsBase = this.base.replace(/^http/, 'ws');
    this.token = token;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.termHandlers = new Map();
    this.appHandlers = new Map();
    this.streamHandlers = new Map();
    // async (payload) => reply value; set by the app
    this.onHostKey = async () => false;
    this.onPrompt = async () => null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsBase}/ws`);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token }));
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not reach the bridge'));
        }
      };
      ws.onclose = (e) => {
        for (const p of this.pending.values()) p.reject(new Error('Bridge connection closed'));
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error(e.code === 4001 ? 'The pairing token was rejected' : 'Bridge connection closed'));
        }
        this.dispatchEvent(new CustomEvent('closed', { detail: { code: e.code } }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === 'authed') {
          settled = true;
          this.bridgeInfo = msg;
          resolve(msg);
        } else this.onMessage(msg);
      };
    });
  }

  async onMessage(msg) {
    switch (msg.t) {
      case 'res': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
        break;
      }
      case 'hostkey':
        this.reply(msg.id, await this.onHostKey(msg));
        break;
      case 'prompt':
        this.reply(msg.id, await this.onPrompt(msg));
        break;
      case 'term-data':
        this.termHandlers.get(msg.tid)?.data(msg.data);
        break;
      case 'term-exit':
        this.termHandlers.get(msg.tid)?.exit();
        this.termHandlers.delete(msg.tid);
        break;
      case 'app-out':
        this.appHandlers.get(msg.aid)?.data(msg.data);
        break;
      case 'app-exit':
        this.appHandlers.get(msg.aid)?.exit(msg);
        break;
      case 'stream-data':
        this.streamHandlers.get(msg.sid)?.data(msg.data);
        break;
      case 'stream-exit':
        this.streamHandlers.get(msg.sid)?.exit(msg.code);
        this.streamHandlers.delete(msg.sid);
        break;
      case 'event':
        this.dispatchEvent(new CustomEvent(msg.kind, { detail: msg }));
        break;
    }
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  reply(id, value) {
    this.send({ t: 'reply', id, value });
  }

  req(op, args = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Bridge is not connected'));
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.send({ t: 'req', id, op, args });
    });
  }

  close() {
    this.ws?.close();
  }

  // ------------------------------------------------------------ terminals ---
  async openTerminal({ cols, rows, cwd, command, x11 = true }, onData, onExit) {
    const { tid } = await this.req('term.open', { cols, rows, cwd, command, x11 });
    this.termHandlers.set(tid, { data: onData, exit: onExit });
    return {
      tid,
      write: (data) => this.send({ t: 'term-in', tid, data }),
      resize: (cols, rows) => this.send({ t: 'term-resize', tid, cols, rows }),
      close: () => this.req('term.close', { tid }).catch(() => {}),
    };
  }

  // ----------------------------------------------------------------- apps ---
  async launchApp(command, target, display, onData, onExit) {
    const res = await this.req('app.launch', { command, target, display });
    if (res.aid) this.appHandlers.set(res.aid, { data: onData, exit: onExit });
    return res;
  }

  // -------------------------------------------------------------- streams ---
  // Runs a network diagnostic on the remote and streams its output.
  async startTool(tool, target, opts, onData, onExit) {
    const { sid, command } = await this.req('stream.start', { tool, target, ...opts });
    this.streamHandlers.set(sid, { data: onData, exit: onExit });
    return { sid, command, stop: () => this.req('stream.stop', { sid }).catch(() => {}) };
  }

  // ---------------------------------------------------------------- files ---
  async downloadUrl(path, inline = false) {
    const ticket = await this.req('ticket', { kind: 'download', path, inline });
    return `${this.base}/download?ticket=${encodeURIComponent(ticket)}`;
  }

  async download(path) {
    triggerDownload(await this.downloadUrl(path));
  }

  async downloadTar(paths) {
    const ticket = await this.req('ticket', { kind: 'tar', paths });
    triggerDownload(`${this.base}/download?ticket=${encodeURIComponent(ticket)}`);
  }

  async fetchBlob(path) {
    const r = await fetch(await this.downloadUrl(path, true));
    if (!r.ok) throw new Error(await r.text());
    return r.blob();
  }

  async upload(file, path, onProgress) {
    const ticket = await this.req('ticket', { kind: 'upload', path });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.base}/upload?ticket=${encodeURIComponent(ticket)}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
      xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Upload failed (network error)'));
      xhr.send(file);
    });
  }

  async tunnelUrl(port) {
    const ticket = await this.req('ticket', { kind: 'tunnel', port });
    return `${this.wsBase}/tunnel?ticket=${encodeURIComponent(ticket)}`;
  }
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
