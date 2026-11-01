# Contributing to SSH Portal

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

Open an [issue](https://github.com/WakifRajin/ssh-portal/issues) with:

- what you did, what you expected, and what happened instead
- your browser, your OS, and the bridge version (shown in the **Bridge** panel)
- the remote's distro, plus the error text from the app or `~/.ssh-portal/bridge.log`

Please report security problems privately through GitHub's **Report a vulnerability** button (Security tab), not in a public issue.

## Dev setup

You need Node.js 18+ and an SSH-reachable Linux machine (a VM, a Pi, or WSL with `sshd` all work).

```bash
git clone https://github.com/WakifRajin/ssh-portal.git
cd ssh-portal/bridge
npm install
npm start
```

Open `http://127.0.0.1:4422/`. The bridge serves `web/` straight from disk and pairs automatically, so web changes only need a reload. Bridge changes need a restart.

If the service worker serves stale files, hard-reload or unregister it in DevTools → Application.

## Project layout

```
web/       static app: index.html, css/app.css, one ES module per tab in js/
bridge/    Node.js server: server.js (HTTP + WebSocket + SSH session), net.js,
           x11.js, admin.js (services/docker/devices parsing), remote-scripts.js
```

[CODEBASE.md](CODEBASE.md) has the full map: the WebSocket protocol, the view contract every tab follows, and step-by-step recipes for adding a tab or a bridge operation. Read it before larger changes.

## Code conventions

- **No build step in `web/`.** Plain ES modules, no bundler, no npm dependencies. Third-party code comes from `cdn.jsdelivr.net` with a pinned version.
- **Style:** 2-space indent, single quotes, semicolons. A short header comment per file and brief "why" comments on non-obvious logic.
- **Names:** `createX()` returns a view, `openX()` opens or focuses a tab, `getX` / `setX` for prefs and state.
- **CSS:** flat kebab-case classes, state through `data-*` attributes and `.active` / `.on` / `.hidden`, and colours through `var(--...)` tokens so all three themes keep working.
- **Remote commands:** wrap every user-supplied value in `shq()`, put `--` before paths, and validate hosts, ports and PIDs. Multi-line remote logic belongs in `remote-scripts.js` as POSIX `sh`, not bash.
- **Nothing installed remotely.** Anything written on the remote goes under `~/.ssh-portal/`.

## Checklist before opening a PR

- [ ] Tested against a real (or VM) Linux host, in Chrome or Edge and in Firefox
- [ ] Checked the dark and light themes, and a narrow window
- [ ] New web module added to `ASSETS` in `web/sw.js`, and `VERSION` bumped there for any web change
- [ ] For bridge changes: `version` in `bridge/package.json`, `VERSION` in `bridge/server.js` and `BRIDGE_VERSION` in `web/js/config.js` all match
- [ ] README updated if you changed something user-visible

Keep PRs focused on one change, and explain the *why* in the description. Screenshots or a short clip help a lot for UI changes.
