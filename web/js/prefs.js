// App-wide preferences (persisted per browser) with change notifications.

const KEY = 'sshportal.prefs';
const DEFAULTS = {
  dataSaver: false, // SSH compression, lighter remote desktop, slower polling
  confirmCloseTerminals: true,
  notifyBell: false, // desktop notification on terminal bell while hidden
  snippets: [
    { name: 'Disk usage of this folder', command: 'du -sh * | sort -h' },
    { name: 'Top processes', command: 'top -b -n 1 | head -n 20' },
    { name: 'System update (Debian/Ubuntu)', command: 'sudo apt update && sudo apt upgrade' },
    { name: 'Follow system log', command: 'journalctl -f' },
  ],
};

let prefs = { ...DEFAULTS };
try {
  prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch {}

const listeners = new Set();

export const getPrefs = () => prefs;

export function setPrefs(patch) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
  for (const fn of listeners) fn(prefs, patch);
}

export function onPrefs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Polling intervals scale up in data-saver mode.
export const interval = (normalMs) => (prefs.dataSaver ? normalMs * 3 : normalMs);
