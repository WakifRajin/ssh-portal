// Network tools for the bridge: diagnostic commands run on the remote host,
// SSH port forwarding (ssh -L) and a SOCKS5 proxy (ssh -D) on 127.0.0.1, and
// Wake-on-LAN magic packets sent from this computer.

import net from 'node:net';
import dgram from 'node:dgram';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Hostnames / IPv4 / IPv6 only; never something that could look like an option.
export function validTarget(t) {
  return typeof t === 'string' && /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/.test(t);
}

// Commands for streaming tools. Each falls back across common implementations.
export function toolCommand(tool, target, opts = {}) {
  if (tool === 'http') {
    if (typeof target !== 'string' || !/^https?:\/\/[^\s'"`\\$]{1,2000}$/.test(target)) throw new Error('Enter a URL starting with http:// or https://');
    const fmt = 'status   %{http_code}\\nremote   %{remote_ip}:%{remote_port}\\ndns      %{time_namelookup}s\\nconnect  %{time_connect}s\\ntls      %{time_appconnect}s\\nfirst byte %{time_starttransfer}s\\ntotal    %{time_total}s\\nsize     %{size_download} bytes\\nspeed    %{speed_download} B/s\\n';
    return `command -v curl >/dev/null 2>&1 || { echo 'curl is not installed on the remote'; exit 1; }; curl -sS -L -o /dev/null --max-time 20 -w ${shq(fmt)} ${shq(target)} 2>&1`;
  }
  if (!validTarget(target)) throw new Error('Enter a hostname or IP address');
  const t = shq(target);
  const n = Math.min(Math.max(Number(opts.count) || 5, 1), 100);
  switch (tool) {
    case 'ping':
      return `ping -c ${n} -i 0.5 ${t} 2>&1 || ping -c ${n} ${t} 2>&1`;
    case 'trace':
      return `if command -v traceroute >/dev/null 2>&1; then traceroute -w 2 -q 1 ${t} 2>&1; elif command -v tracepath >/dev/null 2>&1; then tracepath ${t} 2>&1; elif command -v mtr >/dev/null 2>&1; then mtr -r -c 3 ${t} 2>&1; else echo 'Install traceroute, tracepath or mtr on the remote'; exit 1; fi`;
    case 'dns':
      return `if command -v dig >/dev/null 2>&1; then for q in A AAAA CNAME MX NS TXT; do dig +noall +answer ${t} $q; done; echo; echo ';; reverse / resolver'; dig +noall +answer -x ${t} 2>/dev/null; grep -m3 ^nameserver /etc/resolv.conf; elif command -v host >/dev/null 2>&1; then host -a ${t} 2>&1; elif command -v nslookup >/dev/null 2>&1; then nslookup ${t} 2>&1; else getent ahosts ${t}; fi`;
    case 'whois':
      return `command -v whois >/dev/null 2>&1 && whois ${t} 2>&1 | head -n 80 || echo 'whois is not installed on the remote'`;
    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}

export const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 139, 143, 443, 445, 548, 631, 993, 995, 1883, 2049, 3000, 3306, 3389, 5000, 5432, 5900, 5901, 6379, 8000, 8080, 8443, 8888, 9000, 9090, 27017];

// TCP connect test performed *from the remote host* over direct-tcpip channels.
export async function checkPorts(conn, host, ports, { timeout = 2500, concurrency = 16 } = {}) {
  if (!validTarget(host)) throw new Error('Enter a hostname or IP address');
  const list = [...new Set(ports.map(Number).filter((p) => p > 0 && p < 65536))].slice(0, 1024);
  const results = [];
  let i = 0;
  const one = (port) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      const finish = (state, stream) => {
        if (done) return stream?.close();
        done = true;
        clearTimeout(timer);
        stream?.close();
        resolve({ port, state, ms: Date.now() - t0 });
      };
      const timer = setTimeout(() => finish('filtered'), timeout);
      conn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? finish(/refused/i.test(err.message) ? 'closed' : 'closed') : finish('open', stream)));
    });
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (i < list.length) results.push(await one(list[i++]));
    }),
  );
  return results.sort((a, b) => a.port - b.port);
}

// ------------------------------------------------------------ forwarding ---
// type 'local': 127.0.0.1:localPort -> (via SSH) remoteHost:remotePort
// type 'socks': 127.0.0.1:localPort is a SOCKS5 proxy that exits at the remote
export function startForward(getConn, spec, onChange) {
  const fwd = { id: Math.random().toString(36).slice(2, 10), type: spec.type, localPort: 0, remoteHost: spec.remoteHost, remotePort: Number(spec.remotePort) || 0, connections: 0, total: 0, bytes: 0 };
  if (fwd.type === 'local' && (!validTarget(fwd.remoteHost) || !(fwd.remotePort > 0 && fwd.remotePort < 65536))) throw new Error('Enter the remote host and port');
  const sockets = new Set();

  const pipe = (sock, stream) => {
    stream.on('data', (d) => (fwd.bytes += d.length));
    sock.on('data', (d) => (fwd.bytes += d.length));
    sock.pipe(stream).pipe(sock);
    const end = () => {
      sock.destroy();
      stream.close?.();
    };
    sock.on('error', end);
    stream.on('error', end);
    stream.on('close', end);
  };

  const server = net.createServer((sock) => {
    sockets.add(sock);
    fwd.connections++;
    fwd.total++;
    onChange?.();
    sock.on('close', () => {
      sockets.delete(sock);
      fwd.connections--;
      onChange?.();
    });
    const conn = getConn();
    if (!conn) return sock.destroy();
    if (fwd.type === 'local') {
      sock.pause();
      conn.forwardOut('127.0.0.1', sock.remotePort || 0, fwd.remoteHost, fwd.remotePort, (err, stream) => {
        if (err) return sock.destroy();
        pipe(sock, stream);
        sock.resume();
      });
    } else socks5(sock, conn, pipe);
  });

  fwd.close = () => {
    server.close();
    for (const s of sockets) s.destroy();
  };
  fwd.ready = new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${spec.localPort} is already in use on this computer` : e.message)));
    server.listen(Number(spec.localPort) || 0, '127.0.0.1', () => {
      fwd.localPort = server.address().port;
      resolve(fwd);
    });
  });
  return fwd;
}

// Minimal SOCKS5 (RFC 1928): no authentication, CONNECT only.
function socks5(sock, conn, pipe) {
  let buf = Buffer.alloc(0);
  let stage = 'greet';
  const fail = (code) => {
    sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 'greet') {
      if (buf.length < 2) return;
      if (buf[0] !== 5) return sock.destroy();
      const n = buf[1];
      if (buf.length < 2 + n) return;
      const methods = buf.subarray(2, 2 + n);
      buf = buf.subarray(2 + n);
      if (!methods.includes(0)) return sock.end(Buffer.from([5, 0xff]));
      sock.write(Buffer.from([5, 0]));
      stage = 'request';
    }
    if (stage === 'request') {
      if (buf.length < 5) return;
      const [ver, cmd, , atyp] = buf;
      if (ver !== 5) return sock.destroy();
      let host;
      let off;
      if (atyp === 1) {
        if (buf.length < 10) return;
        host = [...buf.subarray(4, 8)].join('.');
        off = 8;
      } else if (atyp === 3) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('latin1');
        off = 5 + len;
      } else if (atyp === 4) {
        if (buf.length < 22) return;
        host = buf.subarray(4, 20).toString('hex').match(/.{4}/g).join(':');
        off = 20;
      } else return fail(8);
      const port = buf.readUInt16BE(off);
      const rest = buf.subarray(off + 2);
      if (cmd !== 1) return fail(7);
      stage = 'connecting';
      sock.removeListener('data', onData);
      sock.pause();
      conn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) return fail(/refused/i.test(err.message) ? 5 : 4);
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) stream.write(rest);
        pipe(sock, stream);
        sock.resume();
      });
    }
  };
  sock.on('data', onData);
  sock.on('error', () => sock.destroy());
}

// --------------------------------------------------------------- wake-on-lan ---
export function wakeOnLan(mac, broadcast = '255.255.255.255') {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('Enter a MAC address like aa:bb:cc:dd:ee:ff');
  if (!/^[0-9.]+$/.test(broadcast)) throw new Error('Invalid broadcast address');
  const macBuf = Buffer.from(hex, 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => {
      s.close();
      reject(e);
    });
    s.bind(() => {
      s.setBroadcast(true);
      let pending = 2;
      const done = (err) => {
        if (err) {
          s.close();
          return reject(err);
        }
        if (--pending === 0) {
          s.close();
          resolve(true);
        }
      };
      s.send(packet, 9, broadcast, done);
      s.send(packet, 7, broadcast, done);
    });
  });
}
