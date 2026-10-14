# CODEBASE: SSH Portal

Static web app (GitHub Pages, no build, plain ES modules) plus a local Node.js "bridge" (`bridge/`) that performs SSH, SFTP, X11 and port forwarding for the browser. Version 1.3.0 (bridge and web).

## 1. Architecture

```
Browser (web/, GitHub Pages or http://127.0.0.1:4422/)
   |  WebSocket  ws://127.0.0.1:4422/ws       JSON control protocol (section 5)
   |  HTTP       /api/*, /health, /pair, /local-token, /download, /upload
   |  WebSocket  /tunnel?ticket=...           raw bytes: noVNC over SSH direct-tcpip
   v
Bridge (bridge/server.js, listens on 127.0.0.1 only) --ssh2--> SSH server on the LAN
   + x11.js (X11 channels to local X server), net.js, install.js, remote-scripts.js
```

- The browser never speaks SSH. The bridge owns the SSH connections. Each browser session has one control WS.
- Pairing: the bridge makes a token in `~/.ssh-portal/config.json`. The browser stores it as `sshportal.token`. Compared with `crypto.timingSafeEqual`.
- Origins allowed by default: `https://*.github.io`, `localhost`, `127.0.0.1`, `[::1]`, plus `--origin` / `SSH_PORTAL_ORIGINS`.
- Token-free HTTP/WS paths (downloads, uploads, VNC tunnel) use one-time **tickets**. Issued over the WS with op `ticket`. Valid 60 s. Bound to one `kind`: `download|tar|upload|tunnel`.
- The bridge also serves `web/` at `/`, so the app works offline at `http://127.0.0.1:4422/`. `/local-token` returns the token only to same-origin requests.
- Third party: `web/index.html` loads a deferred analytics script (SitePulse, `wakifrajin.github.io/SitePulse/t.js`).

## 2. Directory tree

```
README.md                    user docs: quick start, X11, remote desktop, security model
.github/workflows/
  pages.yml                  deploys web/ to GitHub Pages on push to main (paths web/**)
  release-bridge.yml         builds 5 executables; runs on tag bridge-v* or manually; publishes release
bridge/
  server.js                  entry point: HTTP + WS server, Session class, all SSH ops (~1280 lines)
  x11.js                     X11Forwarder (ssh -Y)
  net.js                     diagnostic commands, port check, port forwarding, SOCKS5, Wake-on-LAN
  install.js                 per-user install: login item, sshportal:// link, uninstall, detached spawn
  remote-scripts.js          POSIX sh scripts that run on the remote host
  build.mjs                  esbuild + Node SEA + postject -> single executable in bridge/dist/
  package.json               deps ssh2, ws; dev esbuild, postject; "type": "module"; node >= 18
  start-bridge.sh / .bat     run from source (npm install on first run, then node server.js)
web/
  index.html                 connect view + #workspace shell
  css/app.css                all styles: tokens, themes, components
  js/*.js                    app modules (section 4)
  sw.js                      service worker: app-shell cache
  manifest.webmanifest       PWA manifest: shortcuts ?open=..., protocol_handlers web+ssh
  js/config.js               REPO (optional), BRIDGE_VERSION = '1.3.0'
  install.sh / install.ps1   one-line bridge installers (fetch the release asset and run it)
  icons/, favicon.svg        art; .nojekyll for Pages
```

## 3. Bridge (bridge/)

### server.js sections (file order)
- **config / args** (`parseArgs`): flags `--port 4422 --host --origin --app-url --new-token --background --foreground --install --uninstall --no-autostart --from-url`. Env `SSH_PORTAL_PORT`, `SSH_PORTAL_ORIGINS`, `SSH_PORTAL_APP_URL`.
- `CONFIG_DIR = ~/.ssh-portal` (0700): `config.json` (token), `known_hosts.json` (TOFU fingerprints), `bridge.log` (rotated at 1 MB; written by `--background`).
- **constants**: `VERSION = '1.3.0'`, `BUILD_APP_URL` / `BUILD_REPO` (baked in by build.mjs), `STANDALONE = isSea()`, `MAIN_CONN_CHANNELS = 6`, `EXTRA_CONN_CHANNELS = 9`.
- **helpers**: `shq` (single-quote escaper), `expandHome`, `fingerprint` (SHA256 base64), `modeToString`, `typeOf`, `agentPath()` (SSH_AUTH_SOCK, Windows OpenSSH pipe, or pageant), `readJson` / `writeJson` (0600).
- **tickets**: `issueTicket(session, data)`, `takeTicket(id, kind)`, 30 s sweeper.
- **`class Session`** (one per control WS):
  - Fields: `conn` (main ssh2 Client), `sftp`, `pool` (`[{conn, chans, max}]`), `terms`, `apps`, `streams`, `forwards`, `waiting` (pending browser replies), `x11`, `traffic`, `compress`.
  - `onMessage(raw)`: the first message must be `auth`. Afterwards routes `req`, `reply`, `term-in`, `term-resize`.
  - `ask(t, payload)`: sends `hostkey` or `prompt` to the browser and waits for `reply` (180 s, then null).
  - `handle(op, a)`: the op switch (section 5). Ops above `needConn()` work without an SSH session.
  - `connect(a)`: auth chain is explicit `privateKey`, `keyPath`, `password`, ssh-agent, `~/.ssh/id_ed25519|id_ecdsa|id_rsa`, keyboard-interactive (answers via browser prompt), then a password prompt fallback. Host key checked in `hostVerifier`, using `ask('hostkey')` and `known_hosts.json`. Keepalive 15 s. The working method is kept in `this.reuse` for extra connections. Uses `dial()` (counts bytes) and `sshAlgorithms()` (zlib when data saver is on).
  - `run(command, {timeout, check, stdin, limit})` returns `{code, stdout, stderr}` via `conn.exec`. `runScript(script, args)` wraps `run` with `sh -s --` and the script as stdin.
  - SFTP: `p(method, ...)` promisifies sftp calls. Also `list`, `statEntry`, `touch`, `search`, `readText` (5 MB cap, binary sniff in first 8000 bytes), `writeText`.
  - **Connection pool**: `openExtraConn()` logs in again with the same method (sshd MaxSessions limit). `openChannel(open)` picks a connection with free slots. Idle extra connections are closed.
  - **Terminals**: `openTerm(a)` uses `openChannel(conn.shell)`. Emits `term-data` / `term-exit`. `a.cwd` and `a.command` are typed into the shell.
  - **Apps**: `launchApp(a)`. `target` x11 is `conn.exec` with X11 and a pty. `target` desktop is a detached `nohup sh -c` with `DISPLAY=:d`. `killApp`. Emits `app-out` / `app-exit`.
  - **Desktop**: `desktopStart(a)` runs `DESKTOP_START`. `desktop.stop` runs `DESKTOP_STOP`. VNC is reached through ticket kind `tunnel`, then `tunnel(ws, ticket)` (`forwardOut` to 127.0.0.1:port).
  - **sysinfo()**: runs `SYSINFO`, parses `key=value` lines plus the `--DF--` and `--PS--` tables.
  - **Net**: `lanScan()` (NET_SCAN), `netInfo()` (NET_INFO), `speedTest({direction, mb})`, `net.ports` (checkPorts), `net.bw` (/proc/net/dev), `net.publicip`.
  - **Forwarding**: `addForward(a)` calls `startForward` (net.js). `listForwards()`. `fwd.remove` closes one.
  - **Streams**: `startStream`, `stopStream(sid)` (section 5).
  - `dispose()` on WS close: closes forwards, streams, pool and main connection, and deletes this session's tickets.
  - `trafficStats()`: rx/tx bytes across all sockets (`traffic` op).
- **HTTP** (`handleHttp`): routes
  - `GET /pair`: consent page. Navigations only, CSP nonce, `frame-ancestors 'none'`. On Allow it posts `{type:'ssh-portal-pair', token}` to the opener, pinned to the origin.
  - `GET /local-token`: same-origin only, returns `{token}`.
  - `GET /health`: `{app:'ssh-portal-bridge', version, repo, standalone}`. Used for detection.
  - `/api/info`, `POST /api/autostart?enabled=1`, `POST /api/wol`, `POST /api/quit`: need `Authorization: Bearer <token>`.
  - `GET /download?ticket=`: kind download, or kind tar (archive via `tar -czf -`). `POST /upload?ticket=`: streams into `sftp.createWriteStream`.
  - Other GET: static file from `web/`, with a path-escape check.
- **WebSocket upgrade**: `/ws` creates `new Session(ws)`. `/tunnel?ticket=` calls `tunnel()`. Origin is checked on upgrade.
- **Startup / install flow** (`main()`):
  - `--uninstall`: stop the running bridge, then `uninstall()`.
  - `--install`, or a standalone exe started with no `--background` or `--foreground`: `installAndLaunch()`. It copies the exe (`installSelf`), sets autostart (`setAutostart`), registers `sshportal://` (`registerProtocol`), spawns a `--background` child (`spawnDetached`), then waits for `/health`.
  - Windows `--background` re-spawns itself detached (guarded by `SSH_PORTAL_DETACHED`).
  - If the port is already held by a bridge: exit quietly (background) or report an error. Otherwise `startServer()`.
  - `uncaughtException` is logged, not fatal.

### x11.js
- `class X11Forwarder`: `sshOption()` (passed as the `x11` option to `conn.shell` / `conn.exec`), `ensureCookie()`, `connectLocal()`, `probe()` (`x11.status` op), `handle(accept, reject)` (ssh2 x11 event), `pipe(channel, sock)`.
- Exports `localDisplay()` and `parseDisplay(display)`.
- Fake cookie: the remote gets a random MIT-MAGIC-COOKIE-1. The real cookie (from `xauth`, `readRealCookie`) is swapped in on the first packet of each connection, so it never leaves this machine.

### net.js
- `validTarget(t)`: regex `^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$`. Rejects anything that could read as an option or contains shell metacharacters.
- `toolCommand(tool, target, opts)`: builds the remote command for streaming tools `ping`, `trace`, `dns`, `whois`, `http`. The http URL regex rejects quotes, backslash, `$` and backtick. Every argument goes through `shq`. Falls back across implementations (traceroute, tracepath, mtr).
- `COMMON_PORTS`; `checkPorts(conn, host, ports, {timeout, concurrency})`: TCP connect probes through the remote.
- `startForward(getConn, spec, onChange)`: `local` (ssh -L) or `socks` (SOCKS5 via `socks5()`, ssh -D). Returns an object with `id`, `ready`, `close()`, and counters.
- `wakeOnLan(mac, broadcast)`: sends a magic packet via dgram. MAC is validated.

### install.js
- Exports `installDir`, `installedExe`, `installSelf()`, `setAutostart(enabled, launcher)`, `autostartEnabled()`, `registerProtocol(launcher)`, `uninstall()`, `spawnDetached(launcher, args)`, `openUrl(url)`.
- Windows: a Run value under the HKCU Run key, and the HKCU Classes entry for the sshportal scheme. macOS: LaunchAgent `io.sshportal.bridge.plist`. Linux: `~/.config/autostart/` and `~/.local/share/applications/*.desktop`. No admin rights needed.

### remote-scripts.js
Each export is a POSIX `sh` script, run as `sh -s -- <args>` with the script on stdin. Nothing is written on the remote except under `~/.ssh-portal/`.
- `DESKTOP_START` (args: `share` or `virtual`, display number, `WxH`): starts or reuses a VNC server bound to 127.0.0.1. Virtual mode uses port 5900+D (Xvnc, or Xvfb + x11vnc). Share mode uses port 5950+D (x11vnc on the real display). Password is random, kept in `~/.ssh-portal/pass-D.txt`. Starts a session (xfce4, lxqt, ... or xterm). Prints `PORT=`, `PASS=`, `DISPLAY=`, `SESSION=`, or `ERROR: ...`.
- `DESKTOP_STOP` (args: mode, display): pkills x11vnc / Xvnc / Xvfb for that display. Prints `stopped`.
- `SYSINFO`: `HOST=`, `OS=`, `KERNEL=`, `UPTIME=`, `LOAD=`, `CPUS=`, `CPU=`, `MEM=`, `USERS=`, then `--DF--` (df table) and `--PS--` (top 60 processes by CPU).
- `NET_SCAN`: ping-sweeps the remote's /24, then reads `ip neigh`. Prints `IFACE name addr/prefix`, `SELF ip`, `HOST ip mac name`. The self line uses `self` in the MAC slot. Prints `ERROR:` if `ip` is missing.
- `NET_INFO`: sections `--ADDR--`, `--ROUTE--`, `--DNS--`, `--LISTEN--`, `--CONN--`, with `ip`/`ss`/`netstat` fallbacks. Parsed by `netInfo()`.

### build.mjs
- `node build.mjs` must run on the target OS (the CI matrix does this). esbuild bundles `server.js` to CJS (node20). `define` bakes `APP_URL` and `REPO` from env. Then it generates a SEA blob, copies `process.execPath`, injects the blob with postject (sentinel fuse), and runs codesign on macOS.
- Output: `bridge/dist/ssh-portal-bridge-<os>-<arch>[.exe]`.

## 4. Web app (web/)

### index.html
- `#connect-view.connect-view`: `.cv-top` (brand, install and theme buttons). `.cv-main` holds `.cv-intro` (features list and `#bridge-card.bridge-panel` with `#bridge-status`, `#bp-body`, and the `#bridge-advanced` manual token/URL form). Also `.cv-card` with `#connect-form`: host, port, username, `.segmented` auth radios (password / key / agent), `[data-auth]` blocks, `.opts` switches (x11, save), `.more-opts` (data saver, MAC for Wake-on-LAN), and `#connect-btn`.
- `#workspace.shell` (hidden until connected):
  - `nav#dock.rail`: buttons `data-open="files|terminal|desktop|apps|system|network"`, then a spacer, then `data-action="palette|install|settings|theme|disconnect"`. `data-icon` and `data-tip` are hydrated by main.js.
  - `.app-main` contains `header.appbar` (`#tabstrip.tabstrip`, `.tab-add[data-open=terminal]`, `.cmdk` palette button, `#session-chip.host-chip`), `#panes.panes` (view elements are appended here), and `footer.appstatus` (`#st-conn`, `#st-view`, `#st-bcast`, `#st-saver`, `#st-x11`, `#st-traffic`, `#st-latency`).
- `#toasts.toasts`. An inline head script applies `sshportal.theme` before first paint.

### css/app.css (~913 lines)
- Sections, each opened by a `/* ==== */` banner: design tokens, Base, Controls, Connect screen, App shell, Terminals, Files, Editor, Desktop, Apps, System, Overlays (dialogs, palette, menus, toasts), Network tools, Preferences/snippets/shortcuts/quick look, Installed app (PWA), View transitions, Responsive, Liquid glass theme.
- Tokens: `:root` = dark defaults. `:root:not([data-theme="dark"])` = light via media query. `:root[data-theme="light"]` = light explicit. `:root[data-theme="glass"]` (~L800) overrides surfaces with `--glass-*` vars.
- Component classes: `.btn` with `.btn-primary|.btn-danger|.btn-sm|.btn-lg`, `.icon-btn` (`.sm`), `.card`, `.field`, `.switch`, `.segmented`, `.pill`, `.muted`, `.small`, `.mono`, `.stack`, `.grid-2`, `.bar`, `.table-wrap`, `.modal`, `.palette`, `.ctxmenu`, `.toast`, `.tab`, `.tab-x`, `.pane` (view root), `.net-nav`, `.net-main`, `.net-sec`, `.term-layout`, `.tsplit`, `.tpane`, `.gutter`.
- State via attributes and classes: `data-kind="ok|err|busy"`, `data-auth`, `data-sec`, `data-act`, `data-copy`, `data-theme`, `data-vt` (view transition type), and `.active`, `.on`, `.hidden`.

### JS modules (web/js/)
- **main.js** (~937 lines): app controller.
  - `LS` helper (localStorage keys `sshportal.<key>`, JSON values). `hydrateIcons`.
  - Theme: `THEME_NAMES`, `THEME_CYCLE`, `setTheme(t)` (dark, light, glass, or system, where system removes the attribute), `toggleTheme`, `syncThemeIcons` (also updates `meta[name=theme-color]`).
  - Pairing: reads `#token=` from the URL hash and stores it.
  - Connect: `openSession(args)` (ensureReady, then `new BridgeSession`, `open()`, `req('connect')`), `renderProfiles`, `hostKeyDialog`, `promptDialog`.
  - Tabs: `tabs` Map (id to `{id, title, iconName, view, tabEl, kind, closable}`). `addTab({id, title, iconName, view, closable, kind})`, `activate(id)`, `closeTab(id)` (honours `view.canClose`, confirms multi-pane terminals), `closeTabNow`, `setTabTitle`, tab drag, tab context menu.
  - Openers: `openTerminal(cwd, command, title)` (ids `terminal:N`, dynamic import of terminals.js), `openEditor(path)`, `openDesktop()` (dynamic import of desktop.js), `openFiles()` (not closable), `openApps()`, `openSystem()`, `openNetwork(section)`.
  - `actions` object passed to views: `openTerminal`, `openEditor`, `showDesktop`, `openWithRemote`.
  - `commands()`: palette list, entries `{group, title, icon, hint, when, run}`.
  - `openSettings()`, `SHORTCUTS` and `showShortcuts()`, snippets (`runSnippet`, `manageSnippets`), PWA install (`installApp`), SW registration and update toast.
  - Status bar: `updateStatus`, `pollLatency`, `pollTraffic` (`traffic` op), `pollX11` (`x11.status`), `syncDataSaver`, `formatRate`.
  - Lifecycle: `enterWorkspace(restore)` opens Files and applies the pending deep link. `onSessionLost` handles the `closed` event: reconnect modal, up to 3 tries, restores cwd and terminal count. Then `leaveWorkspace()` and `disconnect()`.
  - Global keys: keydown handler (Ctrl+K and Ctrl+Shift+P palette, Alt+Shift+T new terminal, Alt+Shift+W close, Ctrl+PageUp/Down, Alt+1..9, question mark for shortcuts).
  - Deep links: `?connect=user@host:port` (also `web+ssh://`), and `?open=terminal|files|network|desktop|apps|system`.
- **bridge.js**: `DEFAULT_BRIDGE`, `probeBridge(base)` (GET /health, 2.5 s timeout), `class BridgeSession extends EventTarget`.
  - `open()` (auth handshake), `req(op, args)` (promise per id), `onMessage` router, `openTerminal`, `launchApp`, `startTool` (streams), `downloadUrl`, `download`, `downloadTar`, `fetchBlob`, `upload(file, path, onProgress)` (XHR), `tunnelUrl(port)`.
  - Emits DOM events `closed` and `event` kinds (`error`, `forwards`).
- **bridge-setup.js**: `createBridgeSetup({settings, LS})` returns `{check, state, ensureReady}`. Detects the bridge, OS and version (`older()`), offers the download or install command (install.sh / install.ps1), the sshportal link launch, and the pairing popup to `/pair`.
- **ui.js**: `icon(name, cls)` (SVG from map P, 24px stroke icons), `$`, `$$`, `h(html)` (returns the first element), `esc`, `toast(msg, type, ms)`, `modal({title, body, buttons, wide, onOpen})` (returns Promise of `{value}`), `confirmBox(title, msg, {okLabel, danger})` (returns bool), `promptBox(title, label, value, opts)` (returns string or null), `contextMenu(x, y, items)`, `fileKind`, `isTextLike`, `formatBytes`, `formatDate`, `formatDuration`, `joinPath`, `dirname`, `basename`.
- **prefs.js**: `getPrefs()`, `setPrefs(patch)` (persists `sshportal.prefs`, notifies listeners), `onPrefs(fn)`, `interval(ms)` (x3 in data saver). Keys: `dataSaver`, `confirmCloseTerminals`, `notifyBell`, `snippets`.
- **files.js**: `createFileExplorer(session, info, actions)`: listing, path bar, bookmarks, upload and download, copy/cut/paste, quick look, search. View exposes `navigate`, `refresh`, `cwd`.
- **editor.js**: `createEditor(session, path, {onDirty})`: textarea editor over `readText` / `writeText`. `canClose()` asks before discarding unsaved changes.
- **terminals.js**: `createTerminalLayout(session, info, {cwd, command, title, onTitle, onEmpty, onNewTab, onActivity})` returns a view with `el`, `paneCount`, `split(dir)`, `zoom()`, `closeFocused()`, `show`, `hide`, `dispose`. Splits are a DOM tree (`.tsplit` / `.tpane`). Uses xterm 6 plus fit, search and web-links addons from jsDelivr. Exports `THEMES`, `terminalSettings`, `getBroadcast`, `setBroadcast(mode)`, `onTerminalStateChange`, `applyTerminalSettings`, `openTerminalSettings`, `refreshTerminalAppearance`. Settings live in `sshportal.term`.
- **desktop.js**: `createDesktop(session, info, appState)`: calls `desktop.start`, then connects noVNC (`@novnc/novnc@1.7.0`) to `tunnelUrl(port)`. Modes: virtual or share. `dispose()` disconnects.
- **apps.js**: `createApps(session, info, appState, actions)`: scans remote `.desktop` files (`LIST_APPS`), categories, launches via `app.launch` (x11 or desktop target), kills via `app.kill`.
- **system.js**: `createSystem(session)`: polls `sysinfo`, cards, disks, process table with kill (`kill` op).
- **network.js**: the multi-section template (section 6). `createNetwork(session, info, actions)` returns `{el, show(sec), hide, open(sec)}`.
- **palette.js**: `openPalette(getCommands, placeholder)`: fuzzy command list.
- **config.js**: `REPO` (empty on Pages, derived from `<owner>.github.io/<name>`), `BRIDGE_VERSION`.
- **sw.js**: `VERSION` is currently v7, `SHELL` is the shell cache name, `RUNTIME` the runtime cache, `ASSETS` the app-shell list. Pages are network-first. CDN hosts (jsdelivr, Google Fonts) are cache-first. Own files are served from cache and refreshed in the background. It never intercepts 127.0.0.1 or localhost on other ports.
- **manifest.webmanifest**: standalone display, `web+ssh` protocol handler, shortcuts to `./?open=terminal|files|network`.

## 5. Protocol (browser <-> bridge, one WebSocket at /ws)

All messages are JSON with a `t` field.

Handshake:
- client `{t:'auth', token}`; server replies `{t:'authed', version, platform, display}` or `{t:'auth-failed'}` and closes with 4001.

Requests (browser calls `BridgeSession.req(op, args)`):
- client `{t:'req', id, op, args}`; server replies `{t:'res', id, ok:true, data}` or `{ok:false, error}`.
- Ops before a session exists: `connect`, `disconnect`, `x11.status`, `wol`, `traffic`, `ping`.
- Ops after connect (guarded by `needConn()`): `list`, `stat`, `realpath`, `mkdir`, `rename`, `touch`, `chmod`, `delete`, `copy`, `move`, `search`, `readText`, `writeText`, `exec`, `ticket`, `term.open`, `term.close`, `app.launch`, `app.kill`, `desktop.start`, `desktop.stop`, `sysinfo`, `kill`, `stream.start`, `stream.stop`, `net.ports`, `net.scan`, `net.info`, `net.bw`, `net.speed`, `net.publicip`, `fwd.list`, `fwd.add`, `fwd.remove`.
- Unknown op: error `Unknown op X`.

Bridge prompts (bridge sends, browser answers):
- `{t:'hostkey', id, host, fingerprint, previous}` and `{t:'prompt', id, title, instructions, prompts}`.
- Browser answers `{t:'reply', id, value}`. No answer within 180 s gives `null`.

Streams and I/O (bridge pushes, no reply):
- Terminal: bridge sends `term-data {tid, data}` and `term-exit {tid}`. Browser sends `term-in {tid, data}` and `term-resize {tid, rows, cols}`.
- Apps: `app-out {aid, data}`, `app-exit {aid, code, signal}` or `{aid, closed:true}`.
- Streaming tools: `stream-data {sid, data}`, `stream-exit {sid, code}`.
- Events: `{t:'event', kind:'closed'|'error'|'forwards', ...}`.

### Adding a new bridge op
1. In `Session.handle()` (server.js, the switch around line 290), add `case 'my.op': return this.myMethod(a);`. Put it above `this.needConn()` if it needs no SSH session.
2. Implement the method on `Session`. Run remote commands with `this.run(cmd, {...})`, wrapping every user value in `shq()`. Use `runScript` plus a constant in remote-scripts.js for multi-line remote logic. Validate input (`validTarget`, regexes, `Number()`).
3. Browser: call `await session.req('my.op', {...})` from a view, or add a helper method to `BridgeSession`.
4. Nothing else is needed unless you add a web file (then update `sw.js` ASSETS).

### Streaming commands
- `startStream(a)` in server.js: `toolCommand(a.tool, a.target, a)` builds the command, then `openChannel(conn.exec)`. Returns `{sid, command}`. Output goes out as `stream-data` (stdout and stderr merged). On channel close it sends `stream-exit {code}`.
- `stopStream(sid)`: sends SIGINT, then closes the channel after 300 ms.
- Browser: `session.startTool(tool, target, opts, onData, onExit)` in bridge.js registers handlers in `streamHandlers` and returns `{sid, command, stop}`. network.js uses it for diagnostics. `onExit(code)` receives `null` when stopped.

## 6. View contract and tabs

Every tab view is a plain object:

    {
      el,                 // root element; addTab() adds class "pane" and hides it
      show?(),            // tab became active (lazy load, focus)
      hide?(),            // tab deactivated (pause timers and polling)
      dispose?(),         // tab closed (disconnect, remove listeners)
      canClose?(),        // async, returns false to block closing (editor unsaved changes)
      // plus extras such as navigate(), refresh(), cwd, open(section), paneCount
    }

Registering a new tab (main.js):
1. Write an opener: `function openX() { if (tabs.has('x')) return activate('x'); xView = createX(session, info, actions); addTab({ id: 'x', title: 'X', iconName: 'grid', view: xView }); }`.
2. Use a dynamic import for large modules (see `openDesktop`, `loadTermMod`).
3. Add a rail button in index.html: `<button data-open="x" data-icon="grid" data-tip="X" aria-label="X"></button>`.
4. Map it in the document click handler (main.js, around line 476) by adding `x: openX` to the object keyed by `open`. Without this the button does nothing.
5. Optional: a deep link in `enterWorkspace` (`?open=x`), a `commands()` entry, a `SHORTCUTS` row.
6. Add the module to `ASSETS` in `web/sw.js` and bump `VERSION`.
- The part of `id` before `:` is the tab `kind` (`terminal:3` gives `terminal`). It drives dock highlighting and palette filtering.

### Section / sub-nav template: network.js
- `SECTIONS = [[key, label, iconName], ...]`: overview, bandwidth, tools, ports, lan, forward, speed, wol.
- `createNetwork` builds `.network`, which holds `.net-nav` (buttons with `data-sec`) and `.net-main`.
- `builders = {key: buildKey, ...}` create each section lazily into `views[key] = {el, enter?, leave?}`.
- `show(sec)` swaps sections: `leave` on the old one, `enter` on the new one.
- Section markup comes from `section(title, desc, body)`, which produces `.net-sec` with a header. Copy buttons use `data-copy`.
- Copy this pattern for any multi-section panel.

## 7. Conventions

- **Code style**: ES modules, 2-space indent, single quotes, semicolons. No build step and no bundler in web/. CDN imports only from `cdn.jsdelivr.net`, pinned (`@xterm/xterm@6.0.0`, `@novnc/novnc@1.7.0`). Fonts from Google Fonts.
- **Bridge**: Node ESM, `node:`-prefixed built-ins, ssh2 callbacks wrapped in promises. Errors are thrown as short messages; the browser shows `e.message`.
- **Comments**: a short header comment per file saying what it is. Section banners `// ---- name ----`. Brief "why" comments on non-obvious logic (security, workarounds). Dense code is fine; avoid restating code.
- **Names**: `createX(...)` returns a view. `openX()` opens or focuses a tab. `buildX` for network sections. `onX` for subscriptions. `getX` / `setX` for prefs and state.
- **CSS**: flat kebab-case classes, no BEM. State via `data-*` attributes and `.active`, `.on`, `.hidden`. Use tokens (`var(--...)`) instead of hard-coded colours outside theme blocks.
- **Themes**: `<html data-theme="dark|light|glass">`. Absent means follow the system. Only `setTheme()` in main.js sets it. The inline head script applies it before paint. Terminal colour themes are separate (`THEMES` in terminals.js).
- **Storage**: localStorage keys (all `sshportal.*`):
  - `theme`, `token`, `bridge`, `profiles`, `repo`, `bridgeSeen` (main.js and bridge-setup.js)
  - `prefs` (prefs.js), `term` (terminal settings), `filePrefs`, `bookmarks.<host>`, `desktop`, `netTargets`, `wol`
  - Use `LS.get` / `LS.set` in main.js, which add the prefix and JSON-encode.
- **Versions to keep in sync**:
  - Bridge change: `bridge/server.js` `VERSION`, `bridge/package.json` `version` (also used for the release tag), and `web/js/config.js` `BRIDGE_VERSION`.
  - Any web change: `web/sw.js` `VERSION`.
- **Security conventions**:
  - `shq()` single-quote escaping for every remote shell argument (server.js, net.js, x11.js).
  - `validTarget()` for hosts. `toolCommand` rejects quotes in URLs. Regex check on desktop geometry. Numeric coercion for pid, signal, display and port.
  - `--` before user paths in rm, cp, mv and tar.
  - Token compared with `timingSafeEqual`. Origin allowlist on HTTP and WS. Tickets are one-time and bound to a kind.
  - Host keys are trust-on-first-use (`known_hosts.json`). A changed key triggers a prompt.
  - The browser stores only the bridge token. Passwords and keys are not saved.

## 8. Build, run, release

- Web: no build. Serve `web/` with any static server, or use the bridge at `http://127.0.0.1:4422/`. Pages deploys `web/` on push to main.
- Bridge from source: `cd bridge && npm install && node server.js` (or `start-bridge.sh` / `start-bridge.bat`).
- Standalone build: `cd bridge && npm ci && APP_URL=https://<owner>.github.io/<repo>/ REPO=<owner>/<repo> node build.mjs`. Output in `bridge/dist/`. Build on the target OS.
- Release: push a tag `bridge-v<version>`, or run the "Release bridge" workflow manually. It publishes 5 assets to the latest release. The web app downloads `releases/latest/download/<asset>`.
- Tests: none in the repo. Testing so far used an out-of-repo mock SSH server (ssh2-based, in a scratch directory) and out-of-repo headless Edge + puppeteer-core UI scripts. Keep them out of the repo unless asked.

## 9. Gotchas

- A new rail button does nothing until its `data-open` is mapped in main.js (section 6).
- A new web module must be listed in `sw.js` ASSETS, or it will be missing offline.
- `term.close` is a request. `term-exit` is pushed when the shell ends. Both paths clean up `terms`.
- `openChannel` retries on "open failed" or "prohibited" by lowering the per-connection cap (sshd MaxSessions).
- Put SSH-independent ops above `needConn()` in `handle()`.
- Data saver (`prefs.dataSaver`) sets compression at connect time and scales polling via `interval()`. It does not change a live connection.
