// Full remote desktop in the browser: a VNC server on the remote, bound to
// its localhost, reached through an SSH port-forward and rendered by noVNC.

import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/core/rfb.js';
import { h, $, icon, esc, toast, modal } from './ui.js';

export function createDesktop(session, info, appState) {
  const prefKey = 'sshportal.desktop';
  const pref = JSON.parse(localStorage.getItem(prefKey) || '{}');
  const el = h(`<div class="desktop">
    <div class="toolbar">
      <span class="dt-status"><span class="dot"></span><span class="dt-text">Not connected</span></span>
      <div class="btn-group dt-connected" hidden>
        <select class="dt-scale" aria-label="Scaling">
          <option value="fit">Scale to fit</option>
          <option value="resize">Resize remote to fit</option>
          <option value="none">1:1 (scroll)</option>
        </select>
        <button class="icon-btn" data-act="clipboard" title="Send text to remote clipboard" aria-label="Clipboard">${icon('clipboard')}</button>
        <button class="icon-btn" data-act="cad" title="Send Ctrl+Alt+Del" aria-label="Ctrl Alt Del">${icon('keyboard')}</button>
        <button class="icon-btn" data-act="fullscreen" title="Fullscreen" aria-label="Fullscreen">${icon('maximize')}</button>
        <button class="btn btn-sm" data-act="disconnect">${icon('x')} Disconnect</button>
        <button class="btn btn-sm btn-danger" data-act="stop" title="Disconnect and stop the VNC server on the remote">${icon('power')} Stop server</button>
      </div>
    </div>
    <div class="dt-stage">
      <div class="dt-screen"></div>
      <div class="dt-setup">
        <div class="card">
          <h2>${icon('monitor')} Remote desktop</h2>
          <p class="muted">See and control the remote machine's graphical desktop right here in the browser. The VNC server only listens on the remote's localhost; all traffic goes through your SSH connection.</p>
          <form class="dt-form">
            <fieldset class="seg">
              <legend>Mode</legend>
              <label><input type="radio" name="mode" value="virtual" ${pref.mode !== 'share' && pref.mode !== 'port' ? 'checked' : ''}><span><b>New virtual desktop</b><small>Separate session (TigerVNC or Xvfb + x11vnc)</small></span></label>
              <label><input type="radio" name="mode" value="share" ${pref.mode === 'share' ? 'checked' : ''}><span><b>Share physical screen</b><small>Mirror the monitor attached to the remote (x11vnc)</small></span></label>
              <label><input type="radio" name="mode" value="port" ${pref.mode === 'port' ? 'checked' : ''}><span><b>Existing VNC server</b><small>Connect to a VNC port already running on the remote</small></span></label>
            </fieldset>
            <div class="grid-2">
              <label class="field" data-for="virtual share"><span>Display number</span><input name="display" type="number" min="0" max="99" value="${pref.display ?? ''}" placeholder="auto"></label>
              <label class="field" data-for="virtual"><span>Resolution</span>
                <select name="geometry">
                  ${['auto', '1280x720', '1366x768', '1600x900', '1920x1080', '2560x1440'].map((g) => `<option ${pref.geometry === g ? 'selected' : ''}>${g}</option>`).join('')}
                </select></label>
              <label class="field" data-for="port"><span>VNC port on remote</span><input name="port" type="number" min="1" max="65535" value="${pref.port || 5901}"></label>
              <label class="field" data-for="port"><span>VNC password</span><input name="password" type="password" autocomplete="off"></label>
            </div>
            <button class="btn btn-primary">${icon('play')} Start desktop</button>
            <p class="dt-error error" hidden></p>
          </form>
        </div>
      </div>
    </div>
  </div>`);

  const screen = $('.dt-screen', el);
  const setup = $('.dt-setup', el);
  const form = $('.dt-form', el);
  const errBox = $('.dt-error', el);
  let rfb = null;
  let current = null; // { mode, display }

  const status = (text, kind = '') => {
    $('.dt-text', el).textContent = text;
    $('.dt-status', el).dataset.kind = kind;
  };

  function syncMode() {
    const mode = form.mode.value;
    for (const f of el.querySelectorAll('[data-for]')) f.hidden = !f.dataset.for.split(' ').includes(mode);
  }
  form.addEventListener('change', syncMode);
  syncMode();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const mode = form.mode.value;
    const btn = form.querySelector('button');
    const values = { mode, display: form.display.value, geometry: form.geometry.value, port: form.port.value };
    localStorage.setItem(prefKey, JSON.stringify(values));
    btn.disabled = true;
    try {
      let port, password, display;
      if (mode === 'port') {
        port = Number(form.port.value);
        password = form.password.value;
      } else {
        status('Starting VNC server on the remote…', 'busy');
        let geometry = form.geometry.value;
        if (geometry === 'auto') {
          const r = screen.getBoundingClientRect();
          geometry = `${Math.max(800, Math.round(r.width / 8) * 8)}x${Math.max(600, Math.round(r.height / 8) * 8)}`;
        }
        const res = await session.req('desktop.start', { mode, display: form.display.value || undefined, geometry });
        ({ port, password } = res);
        display = Number(res.display.slice(1));
        if (res.session) toast(`Started ${res.session} session on ${res.display}`);
      }
      current = { mode, display };
      appState.desktopDisplay = mode === 'port' ? null : display;
      await connect(port, password);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      status('Not connected');
    } finally {
      btn.disabled = false;
    }
  });

  async function connect(port, password) {
    status('Connecting…', 'busy');
    const url = await session.tunnelUrl(port);
    screen.innerHTML = '';
    rfb = new RFB(screen, url, { credentials: { password: password || '' }, shared: true });
    applyScale();
    rfb.focusOnClick = true;
    rfb.addEventListener('connect', () => {
      status(`Connected · ${info.host}${current.display != null ? ` :${current.display}` : ''}`, 'ok');
      setup.hidden = true;
      $('.dt-connected', el).hidden = false;
      rfb.focus();
    });
    rfb.addEventListener('disconnect', (e) => {
      status(e.detail.clean ? 'Disconnected' : 'Connection lost', e.detail.clean ? '' : 'err');
      setup.hidden = false;
      $('.dt-connected', el).hidden = true;
      rfb = null;
    });
    rfb.addEventListener('credentialsrequired', async () => {
      const r = await modal({ title: 'VNC password', body: '<label class="field"><span>Password</span><input name="pw" type="password" autofocus></label>', buttons: [{ label: 'Cancel', value: false }, { label: 'Connect', value: true, primary: true }] });
      r.value ? rfb.sendCredentials({ password: r.data.pw }) : rfb.disconnect();
    });
    rfb.addEventListener('securityfailure', (e) => toast(`VNC authentication failed: ${e.detail.reason || e.detail.status}`, 'error'));
    rfb.addEventListener('clipboard', (e) => navigator.clipboard?.writeText(e.detail.text).catch(() => {}));
    rfb.addEventListener('desktopname', (e) => status(`Connected · ${e.detail.name}`, 'ok'));
  }

  function applyScale() {
    if (!rfb) return;
    const v = $('.dt-scale', el).value;
    rfb.scaleViewport = v === 'fit';
    rfb.resizeSession = v === 'resize';
    rfb.clipViewport = v === 'none';
  }
  $('.dt-scale', el).addEventListener('change', applyScale);

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'disconnect') rfb?.disconnect();
    if (act === 'cad') rfb?.sendCtrlAltDel();
    if (act === 'fullscreen') screen.requestFullscreen?.();
    if (act === 'clipboard') {
      const r = await modal({ title: 'Send to remote clipboard', body: '<label class="field"><span>Text</span><textarea name="text" rows="6" autofocus></textarea></label>', buttons: [{ label: 'Cancel', value: false }, { label: 'Send', value: true, primary: true }] });
      if (r.value && rfb) rfb.clipboardPasteFrom(r.data.text);
    }
    if (act === 'stop') {
      rfb?.disconnect();
      if (current && current.mode !== 'port') {
        await session.req('desktop.stop', { mode: current.mode, display: current.display }).catch((err) => toast(err.message, 'error'));
        appState.desktopDisplay = null;
        toast('Remote VNC server stopped');
      }
    }
  });

  return {
    el,
    show() {
      rfb?.focus();
    },
    dispose() {
      rfb?.disconnect();
    },
  };
}
