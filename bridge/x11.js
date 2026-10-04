// X11 forwarding (the "-Y" in `ssh -Y`).
//
// Remote X clients connect back through the SSH connection; each of those
// channels is piped to the X server running on *this* machine (VcXsrv / X410
// on Windows, XQuartz on macOS, the native server on Linux).
//
// Like OpenSSH we hand the remote side a random "fake" MIT-MAGIC-COOKIE and
// swap it for the real local cookie (from `xauth`) on the first packet of each
// connection, so the real cookie never leaves this machine.

import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const COOKIE_PROTO = 'MIT-MAGIC-COOKIE-1';

export function localDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  return process.platform === 'win32' ? 'localhost:0.0' : ':0';
}

export function parseDisplay(display) {
  // macOS / XQuartz launchd socket: /private/tmp/com.apple.launchd.xxx/org.xquartz:0
  if (display.startsWith('/')) {
    const path = display.replace(/\.\d+$/, '');
    return { path, num: Number(/:(\d+)$/.exec(path)?.[1] ?? 0) };
  }
  const m = /^(.*):(\d+)(?:\.\d+)?$/.exec(display);
  if (!m) throw new Error(`Cannot parse DISPLAY "${display}"`);
  const host = m[1];
  const num = Number(m[2]);
  if (!host || host === 'unix') {
    if (process.platform === 'win32') return { host: '127.0.0.1', port: 6000 + num, num };
    return { path: `/tmp/.X11-unix/X${num}`, num };
  }
  return { host, port: 6000 + num, num };
}

function readRealCookie(display) {
  return new Promise((resolve) => {
    execFile('xauth', ['list', display], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[1] === COOKIE_PROTO && /^[0-9a-f]+$/i.test(parts[2])) {
          return resolve(Buffer.from(parts[2], 'hex'));
        }
      }
      resolve(null);
    });
  });
}

const pad4 = (n) => (n + 3) & ~3;

export class X11Forwarder {
  constructor() {
    this.fakeCookie = crypto.randomBytes(16);
    this.display = localDisplay();
    this.target = null;
    this.realCookie = undefined; // undefined = not looked up yet, null = none
    this.connections = 0;
    try {
      this.target = parseDisplay(this.display);
    } catch {
      this.target = null;
    }
  }

  sshOption() {
    return { single: false, screen: 0, protocol: COOKIE_PROTO, cookie: this.fakeCookie.toString('hex') };
  }

  async ensureCookie() {
    if (this.realCookie === undefined) this.realCookie = await readRealCookie(this.display);
    return this.realCookie;
  }

  connectLocal() {
    return this.target.path ? net.connect(this.target.path) : net.connect(this.target.port, this.target.host);
  }

  probe() {
    return new Promise((resolve) => {
      if (!this.target) return resolve({ ok: false, display: this.display, error: 'Invalid DISPLAY' });
      const sock = this.connectLocal();
      const done = (res) => {
        sock.destroy();
        resolve({ display: this.display, ...res });
      };
      sock.setTimeout(1500, () => done({ ok: false, error: 'Timed out connecting to local X server' }));
      sock.once('connect', async () => {
        const cookie = await this.ensureCookie();
        done({ ok: true, auth: !!cookie });
      });
      sock.once('error', (e) => done({ ok: false, error: `No X server at ${this.display} (${e.code || e.message})` }));
    });
  }

  async handle(accept, reject) {
    if (!this.target) return reject();
    await this.ensureCookie();
    const sock = this.connectLocal();
    let channel = null;
    sock.once('error', () => {
      if (!channel) reject();
      else channel.destroy();
    });
    sock.once('connect', () => {
      channel = accept();
      this.connections++;
      this.pipe(channel, sock);
    });
  }

  // Rewrite the X11 connection-setup packet, then splice the two streams.
  pipe(channel, sock) {
    let buf = Buffer.alloc(0);
    const close = () => {
      sock.destroy();
      channel.destroy();
    };
    channel.on('close', () => sock.destroy());
    sock.on('close', () => channel.destroy());
    channel.on('error', close);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 12) return;
      const le = buf[0] === 0x6c; // 'l' = little endian, 'B' = big endian
      if (!le && buf[0] !== 0x42) return close();
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const nameLen = u16(6);
      const dataLen = u16(8);
      const total = 12 + pad4(nameLen) + pad4(dataLen);
      if (buf.length < total) return;

      const name = buf.subarray(12, 12 + nameLen).toString('latin1');
      const data = buf.subarray(12 + pad4(nameLen), 12 + pad4(nameLen) + dataLen);
      if (name !== COOKIE_PROTO || data.length !== this.fakeCookie.length || !crypto.timingSafeEqual(data, this.fakeCookie)) {
        return close(); // not our cookie: refuse, as OpenSSH does
      }

      const realName = this.realCookie ? Buffer.from(COOKIE_PROTO, 'latin1') : Buffer.alloc(0);
      const realData = this.realCookie || Buffer.alloc(0);
      const header = Buffer.alloc(12 + pad4(realName.length) + pad4(realData.length));
      buf.copy(header, 0, 0, 6); // byte order, pad, protocol major/minor
      if (le) {
        header.writeUInt16LE(realName.length, 6);
        header.writeUInt16LE(realData.length, 8);
      } else {
        header.writeUInt16BE(realName.length, 6);
        header.writeUInt16BE(realData.length, 8);
      }
      realName.copy(header, 12);
      realData.copy(header, 12 + pad4(realName.length));

      channel.removeListener('data', onData);
      sock.write(header);
      if (buf.length > total) sock.write(buf.subarray(total));
      channel.pipe(sock);
      sock.pipe(channel);
    };
    channel.on('data', onData);
  }
}
