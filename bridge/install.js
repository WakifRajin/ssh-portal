// OS integration for the standalone bridge: install the executable once,
// start it at login, and register the sshportal:// link so the web app can
// wake it up. Everything is per-user; nothing needs admin rights.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();
const APP_ID = 'ssh-portal-bridge';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'SSH Portal Bridge';
const PROTO_KEY = 'HKCU\\Software\\Classes\\sshportal';
const MAC_PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'io.sshportal.bridge.plist');
const LINUX_AUTOSTART = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'autostart', `${APP_ID}.desktop`);
const LINUX_HANDLER = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'applications', `${APP_ID}.desktop`);

export function installDir() {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'SSH Portal');
  return path.join(HOME, '.ssh-portal', 'bin');
}
export const installedExe = () => path.join(installDir(), IS_WIN ? `${APP_ID}.exe` : APP_ID);

const quoteWin = (s) => `"${s}"`;
const quoteSh = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function reg(args) {
  try {
    execFileSync('reg', args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

// Copy the running executable to a stable per-user location.
export function installSelf() {
  const target = installedExe();
  const same = (() => {
    try {
      return fs.realpathSync(process.execPath).toLowerCase() === fs.realpathSync(target).toLowerCase();
    } catch {
      return false;
    }
  })();
  if (!same) {
    fs.mkdirSync(installDir(), { recursive: true });
    const tmp = `${target}.new`;
    fs.copyFileSync(process.execPath, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
  }
  return target;
}

// launcher = [executable, ...fixed args] (a standalone build is just [exe];
// running from source it is [node, server.js]).
const cmdline = (launcher, extra) => [...launcher.map(quoteWin), ...extra].join(' ');

export function setAutostart(enabled, launcher) {
  if (IS_WIN) {
    return enabled ? reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmdline(launcher, ['--background']), '/f']) : reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  }
  if (IS_MAC) {
    if (!enabled) {
      fs.rmSync(MAC_PLIST, { force: true });
      return true;
    }
    const argsXml = [...launcher, '--background'].map((a) => `    <string>${xmlEsc(a)}</string>`).join('\n');
    writeFile(
      MAC_PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.sshportal.bridge</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`,
    );
    return true;
  }
  if (!enabled) {
    fs.rmSync(LINUX_AUTOSTART, { force: true });
    return true;
  }
  writeFile(
    LINUX_AUTOSTART,
    `[Desktop Entry]
Type=Application
Name=SSH Portal Bridge
Comment=Lets the SSH Portal web app reach machines on your network
Exec=${[...launcher, '--background'].map(quoteSh).join(' ')}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`,
  );
  return true;
}

export function autostartEnabled() {
  if (IS_WIN) return reg(['query', RUN_KEY, '/v', RUN_VALUE]);
  return fs.existsSync(IS_MAC ? MAC_PLIST : LINUX_AUTOSTART);
}

// sshportal:// lets the web page start the bridge with one click. macOS only
// supports URL schemes for .app bundles, so there the login item covers it.
export function registerProtocol(launcher) {
  if (IS_WIN) {
    return (
      reg(['add', PROTO_KEY, '/ve', '/d', 'URL:SSH Portal Bridge', '/f']) &&
      reg(['add', PROTO_KEY, '/v', 'URL Protocol', '/d', '', '/f']) &&
      reg(['add', `${PROTO_KEY}\\shell\\open\\command`, '/ve', '/d', cmdline(launcher, ['--background', '--from-url', '"%1"']), '/f'])
    );
  }
  if (IS_MAC) return false;
  writeFile(
    LINUX_HANDLER,
    `[Desktop Entry]
Type=Application
Name=SSH Portal Bridge
Exec=${[...launcher, '--background', '--from-url'].map(quoteSh).join(' ')} %u
MimeType=x-scheme-handler/sshportal;
Terminal=false
NoDisplay=true
`,
  );
  try {
    execFileSync('xdg-mime', ['default', `${APP_ID}.desktop`, 'x-scheme-handler/sshportal'], { stdio: 'ignore' });
  } catch {}
  return true;
}

export function uninstall() {
  setAutostart(false, []);
  if (IS_WIN) reg(['delete', PROTO_KEY, '/f']);
  else fs.rmSync(LINUX_HANDLER, { force: true });
  const exe = installedExe();
  if (!fs.existsSync(exe)) return;
  if (IS_WIN) {
    // a running .exe can't delete itself; remove it a moment after we exit
    spawn('cmd', ['/c', `ping 127.0.0.1 -n 3 >nul & del /f /q ${quoteWin(exe)}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else fs.rmSync(exe, { force: true });
}

export function spawnDetached(launcher, args) {
  const [cmd, ...pre] = launcher;
  spawn(cmd, [...pre, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SSH_PORTAL_DETACHED: '1' },
  }).unref();
}

export function openUrl(url) {
  if (!/^https?:\/\//.test(url)) return;
  const [cmd, args] = IS_WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : IS_MAC ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}
