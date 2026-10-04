# SSH Portal

A browser workspace for the Linux machines on your local network: a **file explorer**, **terminals**, **GUI apps through `ssh -Y` X11 forwarding**, and a **full remote desktop**, all in one tab. The web app is static and can be hosted on GitHub Pages.

```
 Browser (GitHub Pages)          Your computer                     LAN machine
┌──────────────────────┐  WS/HTTP ┌──────────────────┐   SSH    ┌──────────────────┐
│ Files · Terminal     │ ───────► │  bridge (Node)   │ ───────► │ sshd             │
│ Desktop · Apps · Sys │ 127.0.0.1│  ssh2 + ws       │  :22     │  SFTP, shells,   │
└──────────────────────┘   :4422  │                  │ ◄─────── │  X11 channels,   │
                                  │  X11 ──► local X │  -Y      │  VNC on localhost│
                                  │  server (VcXsrv, │          └──────────────────┘
                                  │  XQuartz, Xorg)  │
                                  └──────────────────┘
```

**Why there's a bridge:** browsers can't open raw TCP connections, so no web page (on GitHub Pages or anywhere else) can speak SSH on its own. The bridge is one small Node.js process on *your* computer. It listens on `127.0.0.1` only and does the SSH work for the page.

## Features

| Tab | What it does |
|---|---|
| **Files** | SFTP explorer: breadcrumbs and a typed path bar, back/forward/up, list and grid views, sorting, hidden files, multi-select (Ctrl/Shift), copy/cut/paste, drag-to-move, rename, delete, new file/folder, chmod/properties, folder size, bookmarks, recursive search. Drag & drop files **or whole folders** from your desktop to upload. Download single files, or several items/folders as `.tar.gz`. |
| **Editor** | Opens text files in a tab with line numbers, Ctrl+S save, soft-wrap, and an unsaved-changes guard. Images open in a preview. |
| **Terminal** | Terminator-style: any number of tabs, each split into panes **side by side or stacked** as deep as you like. Drag dividers to resize, maximize a pane, move focus with Alt+arrows, and **broadcast** keystrokes to every pane in a tab or to all terminals. Includes find, clickable links, copy-on-select, middle-click paste, and 7 colour schemes (Terminator, Ubuntu, Dracula, Solarized, Nord, …). Every pane shares your one login; the bridge opens extra SSH channels and connections on its own, so you never sign in again. Shells request X11 forwarding, so `firefox` or `gedit` started from any pane opens **on your computer**, like `ssh -Y`. |
| **Apps** | A start menu built from the remote's installed `.desktop` applications, with categories and search, plus "run any command". Each app runs either on **This computer (ssh -Y)** or inside the **Browser desktop**. Output and a stop button for each launched app. |
| **Desktop** | The remote's full graphical desktop in the browser (noVNC). Start a **new virtual desktop** (TigerVNC, or Xvfb + x11vnc, auto-starts XFCE/LXQt/MATE/…), **share the physical screen** (x11vnc), or connect to an existing VNC port. The VNC server binds to the remote's localhost and is reached only through the SSH tunnel. Fit/resize/1:1 scaling, clipboard, Ctrl+Alt+Del, fullscreen. |
| **System** | Live CPU, memory, swap, uptime, disks and a filterable process list with "end process". |

## Quick start

1. **Open the web app**: `https://<you>.github.io/ssh-portal/`.
2. **Set up the bridge once.** The Bridge panel detects your system and walks you through it:
   * **Windows:** click **Download for Windows** and open the file. If SmartScreen appears: **More info → Run anyway**.
   * **macOS / Linux:** paste the one-line command it shows into a terminal (`curl -fsSL …/install.sh | sh -s <owner>/<repo>`).

   The bridge installs for your user only (no admin rights), starts in the background, and starts again at every login. The page notices it within a couple of seconds; no reload needed.
3. **Click "Pair this browser"**, then **Allow** in the small window that opens. That's once per browser.
4. **Connect**: host/IP, username, and a password, private key (paste, file, or a path on your computer), or your SSH agent / `~/.ssh/id_*` keys. On first connect you confirm the host key fingerprint (trust on first use); if that key ever changes, you'll see a warning.

Afterwards there's nothing to do: the bridge is already running when you log in. If it isn't (you stopped it), **Start bridge** in the panel, or simply **Connect**, wakes it through the `sshportal://` link on Windows and Linux. On macOS, run `~/.ssh-portal/bin/ssh-portal-bridge --install` again.

Chrome and Edge may ask to **allow access to devices on your local network**. Click Allow: that's how the page reaches the bridge.

The panel's switch turns **start at login** on or off; its buttons stop the bridge or unpair the browser. To remove it completely, run the program with `--uninstall` (Windows: `%LOCALAPPDATA%ProgramsSSH Portalssh-portal-bridge.exe --uninstall`; macOS/Linux: `~/.ssh-portal/bin/ssh-portal-bridge --uninstall`).

### Running the bridge from source instead

Needs Node.js 18+. This is the way to go while developing.

```bash
cd bridge
npm install
npm start
```

It runs in that terminal. The copy of the app it serves at `http://127.0.0.1:4422/` pairs automatically; the hosted app pairs with the same **Pair this browser** button. `node server.js --install` sets up the login item from source as well.

## Setting up X11 forwarding (`ssh -Y`)

GUI windows from the remote are drawn by an **X server on your computer**:

| Your OS | X server | Notes |
|---|---|---|
| Windows | [VcXsrv](https://sourceforge.net/projects/vcxsrv/) (XLaunch → Multiple windows) or X410 | The bridge uses `DISPLAY=localhost:0.0` by default. |
| macOS | [XQuartz](https://www.xquartz.org/) | Log out and back in after installing; start the bridge from an XQuartz terminal so `DISPLAY` is set. |
| Linux | already running | Start the bridge from your desktop session. |

On the **remote**, `/etc/ssh/sshd_config` needs `X11Forwarding yes`, and `xauth` must be installed (`sudo apt install xauth`).

The Apps tab shows whether the bridge can reach your X server. Like OpenSSH, the bridge gives the remote a random fake MIT-MAGIC-COOKIE and swaps in your real cookie (from `xauth`) locally, so your real cookie never leaves your machine.

No X server? Use the **Desktop** tab and launch apps with **Browser desktop** instead.

## Setting up the remote desktop

Install one of these on the remote:

```bash
# new virtual desktops (recommended)
sudo apt install tigervnc-standalone-server xfce4
# or
sudo apt install xvfb x11vnc xfce4
# sharing the physical monitor
sudo apt install x11vnc
```

SSH Portal starts the VNC server for you (bound to `localhost`, with a random password kept in `~/.ssh-portal/` on the remote) and tunnels it over SSH. **Stop server** shuts it down again.

## Hosting on GitHub Pages

The web app lives in `web/` and needs no build step.

1. Push this repository to GitHub (branch `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** The workflow in `.github/workflows/pages.yml` publishes `web/` on every push that touches it.
3. **Publish the bridge downloads:** in the **Actions** tab, run **Release bridge** (or push a tag such as `bridge-v1.2.0`). It builds standalone executables for Windows x64, macOS (Apple Silicon and Intel), and Linux (x64 and ARM64) and attaches them to the latest GitHub release. That's where the app's download buttons and install scripts fetch them from.

The app works out the repository from `<owner>.github.io/<repo>`. On a custom domain, set `REPO` in `web/js/config.js` and start the bridge with `--origin https://ssh.example.com` (or set `SSH_PORTAL_ORIGINS`); the bridge accepts `https://*.github.io` and `localhost` origins by default.

When you change the bridge, bump `version` in `bridge/package.json` and `VERSION` in `bridge/server.js`, set `BRIDGE_VERSION` in `web/js/config.js` to match, and run the release again. Pages with an older bridge then show an **Update available** prompt.

To build an executable locally for the OS you're on: `cd bridge && npm install && node build.mjs` (the output goes to `bridge/dist/`).

## Bridge options

```
ssh-portal-bridge [--install | --uninstall | --background | --foreground] [--no-autostart]
                  [--port 4422] [--origin URL]... [--app-url URL] [--new-token]
```

| Option / env | Meaning |
|---|---|
| `--port`, `SSH_PORTAL_PORT` | Listen port (always on 127.0.0.1). Default 4422. If you change it, set the same URL under **Advanced** in the app. |
| `--origin`, `SSH_PORTAL_ORIGINS` | Extra allowed web origins (comma-separated in the env var). |
| `--app-url`, `SSH_PORTAL_APP_URL` | Your hosted URL, used to print a one-click pairing link. |
| `--install` / `--uninstall` | Set up (or remove) the per-user install, the login item and the `sshportal://` link. Running the downloaded program with no options does `--install`. |
| `--no-autostart` | With `--install`: don't start at login. |
| `--background` | No window; logs go to `~/.ssh-portal/bridge.log`. |
| `--foreground` | Run the downloaded program in the terminal instead of installing. |
| `--new-token` | Rotate the pairing token, which un-pairs every browser. |
| `DISPLAY` | Local X server used for `-Y` windows. |

sshd allows about 10 channels per connection (`MaxSessions`). The bridge keeps up to 6 terminals on your main connection and opens extra connections (9 terminals each) as needed. These reuse the authentication method that already worked, and close themselves when their last terminal does.

## Security model

* The bridge binds to **127.0.0.1** only. Other machines on the network can't use it.
* Each request is checked twice: the browser **Origin** must be allowed, and the control socket must present the **pairing token**. Browsers get the token only when you click **Allow** on the bridge's own pairing page, which shows the requesting site, hands the token only to that origin (`postMessage`), can't be framed, and can't be read with `fetch`. Downloads, uploads and VNC tunnels use **single-use tickets** that expire after 60 seconds, so the token never appears in a URL.
* Host keys are verified (TOFU) and stored in `~/.ssh-portal/known_hosts.json`.
* Passwords and keys are never saved by the web app. Saved connections keep only host, port, username, auth type and an optional key *path*.
* VNC servers listen on the remote's localhost, use a VNC password, and are reachable only through SSH.

## Keyboard shortcuts

Press **Ctrl+K** (or Ctrl+Shift+P) anywhere for the command palette, which lists every action.

**Terminals** (Terminator bindings where the browser allows):

| Keys | Action |
|---|---|
| Ctrl+Shift+E | Split the focused pane side by side |
| Ctrl+Shift+O | Split the focused pane top / bottom |
| Ctrl+Shift+X | Maximize / restore the focused pane (or double-click its title bar) |
| Alt+Shift+W | Close the focused pane (`exit` / Ctrl+D also closes it) |
| Alt+Shift+T | New terminal tab |
| Alt+←/→/↑/↓ | Move focus to the neighbouring pane |
| Ctrl+Shift+←/→/↑/↓ | Resize the focused pane |
| Alt+G / Alt+A / Alt+O | Broadcast to this tab / to all terminals / off |
| Ctrl+Shift+C / V | Copy / paste |
| Ctrl+Shift+F | Find in scrollback |
| Ctrl+Shift+G | Clear scrollback |
| Ctrl + = / − / 0 | Font size bigger / smaller / reset |

Browsers reserve Ctrl+Shift+W and Ctrl+Shift+T, so SSH Portal uses Alt+Shift+W and Alt+Shift+T instead.

**Everywhere else:**

| Keys | Action |
|---|---|
| Ctrl+PageUp / PageDown, Alt+1…9 | Switch tabs (you can also drag tabs to reorder them) |
| Files: Enter, Backspace, Del, F2, F5, Ctrl+A/C/X/V, Ctrl+H, Alt+←/→ | Open, up, delete, rename, refresh, select all, copy/cut/paste, hidden files, history |
| Editor: Ctrl+S | Save |

## Troubleshooting

* **"No bridge found"**: check that the bridge window is still running, that the port matches **Advanced → Bridge URL**, and that you allowed the local-network prompt. Safari blocks secure pages from talking to localhost, so use Chrome, Edge or Firefox, or use `http://127.0.0.1:4422/`. Brave: turn off Shields for the page.
* **GUI app doesn't appear**: the Apps tab shows the X server status. Also check `X11Forwarding yes` and `xauth` on the remote, and run `echo $DISPLAY` in an SSH Portal terminal (it should print something like `localhost:10.0`).
* **Desktop won't start**: the error message names the missing package. Logs are in `~/.ssh-portal/` on the remote.
