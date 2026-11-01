# SSH Portal

Use a Linux machine on your network from a browser tab: browse and edit files, open terminals, run GUI apps, see its desktop, and check its system, services, logs, Docker and network.

## How it works

```
Browser tab (web/)  ──WebSocket──►  bridge (Node.js, on your PC)  ──SSH──►  Linux machine
                    127.0.0.1:4422
```

- **`web/`** is the app. It is static HTML/JS with no build step, so it can be hosted on GitHub Pages.
- **`bridge/`** is a small program that runs on **your own computer**. Browsers can't open SSH connections, so the page sends everything to the bridge, and the bridge talks SSH/SFTP to the Linux machine.
- The bridge listens on `127.0.0.1` only. A browser must be paired with it once (a click on **Allow**) before it can use it.
- GUI apps use X11 forwarding (`ssh -Y`) and show up on your PC. The remote desktop is VNC tunnelled over SSH.

## Use it

1. Open the hosted app: `https://<owner>.github.io/ssh-portal/`
2. In the **Bridge** panel, install the bridge (once per computer):
   - **Windows:** click **Download for Windows**, run it. If SmartScreen appears: More info → Run anyway.
   - **macOS / Linux:** paste the command the panel shows into a terminal.
3. Click **Pair this browser**, then **Allow** in the window that opens.
4. Enter host, username and a password or key, then **Connect**. Confirm the host key fingerprint the first time.

The bridge installs for your user only (no admin rights) and starts at every login. Chrome and Edge may ask to allow access to local network devices: click Allow.

To remove it, run the program with `--uninstall` (macOS/Linux: `~/.ssh-portal/bin/ssh-portal-bridge --uninstall`; Windows: `%LOCALAPPDATA%\Programs\SSH Portal\ssh-portal-bridge.exe --uninstall`).

## Run from source

Needs Node.js 18+.

```bash
cd bridge
npm install
npm start
```

Then open `http://127.0.0.1:4422/` (it pairs automatically), or use the hosted app and click **Pair this browser**.

## Optional setup

### GUI apps on your PC (X11)

You need an X server on your PC:

| OS | X server |
|---|---|
| Windows | [VcXsrv](https://sourceforge.net/projects/vcxsrv/) (XLaunch → Multiple windows) |
| macOS | [XQuartz](https://www.xquartz.org/) (log out and in after installing, start the bridge from an XQuartz terminal) |
| Linux | already running |

On the remote machine: set `X11Forwarding yes` in `/etc/ssh/sshd_config` and install `xauth` (`sudo apt install xauth`).

No X server? Use the **Desktop** tab instead.

### Remote desktop

Install one of these on the remote machine:

```bash
sudo apt install tigervnc-standalone-server xfce4    # new virtual desktop (recommended)
sudo apt install xvfb x11vnc xfce4                   # alternative
sudo apt install x11vnc                              # share the physical screen
```

SSH Portal starts and stops the VNC server itself.

### Other remote packages

- `lldpd` for the switch/port info in the Devices tab
- Docker or Podman for the Docker tab

## Host your own copy

1. Push the repo to GitHub (branch `main`).
2. **Settings → Pages → Source: GitHub Actions.** The `pages.yml` workflow publishes `web/`.
3. In **Actions**, run **Release bridge**. It builds the bridge executables (Windows, macOS, Linux) and attaches them to a release; the app's download buttons and install scripts use them.

The app finds the repo from `<owner>.github.io/<repo>`. For a custom domain, set `REPO` in `web/js/config.js` and start the bridge with `--origin https://your.domain`.

When you change the bridge, bump `version` in `bridge/package.json` and `VERSION` in `bridge/server.js`, set `BRIDGE_VERSION` in `web/js/config.js` to match, and run the release again.

To build an executable locally: `cd bridge && npm install && node build.mjs` (output in `bridge/dist/`).

## Bridge options

```
ssh-portal-bridge [--install | --uninstall | --background | --foreground] [--no-autostart]
                  [--port 4422] [--origin URL]... [--app-url URL] [--new-token]
```

| Option | Meaning |
|---|---|
| `--port` (`SSH_PORTAL_PORT`) | Listen port, default 4422. If changed, set the same URL under **Advanced** in the app. |
| `--origin` (`SSH_PORTAL_ORIGINS`) | Extra allowed web origins. `*.github.io` and localhost are allowed by default. |
| `--app-url` (`SSH_PORTAL_APP_URL`) | Your hosted URL, used to print a pairing link. |
| `--install` / `--uninstall` | Add or remove the per-user install and login item. |
| `--no-autostart` | With `--install`: don't start at login. |
| `--background` / `--foreground` | Run without a window (logs in `~/.ssh-portal/bridge.log`) / run in the terminal. |
| `--new-token` | Rotate the pairing token (un-pairs all browsers). |

## Troubleshooting

- **"No bridge found":** check the bridge is running, the port matches **Advanced → Bridge URL**, and you allowed the local-network prompt. Safari blocks this; use Chrome, Edge or Firefox. In Brave, turn off Shields for the page.
- **GUI app doesn't appear:** check the X server status in the Apps tab, `X11Forwarding yes` and `xauth` on the remote, and that `echo $DISPLAY` in an SSH Portal terminal prints something like `localhost:10.0`.
- **Desktop won't start:** the error names the missing package. Logs are in `~/.ssh-portal/` on the remote.
