// Sudo password prompt for bridge ops that need root.
//
//   withSudo(session, (pw) => session.req('svc.action', { ..., sudoPassword: pw }), { reason: 'Restart nginx' })
//
// run() is first called without a password. If the bridge answers
// SUDO_REQUIRED we ask for it (and SUDO_FAILED re-asks). The password is kept
// in memory only, and only if the user ticks "Remember for this session".

import { modal, esc } from './ui.js';

let remembered = null;

export const cachedSudo = () => remembered;
export const clearSudo = () => {
  remembered = null;
};
export const isCancelled = (e) => e?.message === 'Cancelled';

const SUDO_ERRORS = ['SUDO_REQUIRED', 'SUDO_FAILED', 'SUDO_UNAVAILABLE'];
const code = (e) => SUDO_ERRORS.find((c) => e?.message === c || e?.message?.startsWith?.(`${c}:`));

async function askPassword(reason, error) {
  const r = await modal({
    title: 'Administrator password needed',
    body: `<p>${reason ? `<b>${esc(reason)}</b><br>` : ''}This needs administrator rights on the remote machine. Enter the password you use for <code>sudo</code> there (usually your login password).</p>
      ${error ? `<p class="error small" role="alert">${esc(error)}</p>` : ''}
      <label class="field"><span>sudo password</span><input name="pw" type="password" autocomplete="current-password" autofocus required></label>
      <label class="chk small"><input type="checkbox" name="remember"><span>Remember for this session <span class="muted">(kept in memory only, forgotten on disconnect)</span></span></label>`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Continue', value: true, primary: true },
    ],
  });
  if (r.value !== true || !r.data.pw) throw new Error('Cancelled');
  return { password: r.data.pw, remember: r.data.remember === 'on' };
}

export async function withSudo(session, run, { reason = '' } = {}) {
  let error = '';
  let password;
  let tried = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await run(password);
    } catch (e) {
      const c = code(e);
      if (!c) throw e;
      if (c === 'SUDO_UNAVAILABLE') {
        const err = new Error("sudo isn't available for this account on the remote machine. Ask an administrator, or run the command as root.");
        err.code = c;
        throw err;
      }
      if (c === 'SUDO_FAILED') {
        remembered = null; // a stored password that stopped working is useless
        error = 'That password was not accepted. Try again.';
      }
      if (c === 'SUDO_REQUIRED' && remembered && !tried) {
        tried = true;
        password = remembered;
        continue;
      }
      tried = true;
      const ans = await askPassword(reason, error);
      password = ans.password;
      if (ans.remember) remembered = ans.password;
    }
  }
  throw new Error('Too many wrong passwords');
}
