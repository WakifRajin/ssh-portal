// Plain-text editor tab for remote files.

import { h, $, icon, esc, toast, confirmBox, formatBytes, basename } from './ui.js';

export function createEditor(session, path, { onDirty } = {}) {
  const el = h(`<div class="editor">
    <div class="toolbar">
      <span class="ed-path mono" title="${esc(path)}">${esc(path)}</span>
      <span class="ed-info muted small"></span>
      <div class="btn-group">
        <label class="chk small"><input type="checkbox" class="ed-wrap"> Wrap</label>
        <button class="icon-btn" data-act="reload" title="Reload from disk" aria-label="Reload">${icon('refresh')}</button>
        <button class="icon-btn" data-act="download" title="Download" aria-label="Download">${icon('download')}</button>
        <button class="btn btn-primary btn-sm" data-act="save" title="Save (Ctrl+S)">${icon('save')} Save</button>
      </div>
    </div>
    <div class="ed-body">
      <pre class="ed-gutter" aria-hidden="true"></pre>
      <textarea class="ed-text mono" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Contents of ${esc(basename(path))}"></textarea>
    </div>
  </div>`);
  const ta = $('.ed-text', el);
  const gutter = $('.ed-gutter', el);
  const info = $('.ed-info', el);
  let saved = '';
  let dirty = false;

  const setDirty = (d) => {
    if (d === dirty) return;
    dirty = d;
    onDirty?.(d);
  };
  let lineCount = 0;
  const lines = () => {
    const n = ta.value.split('\n').length;
    if (n !== lineCount) {
      lineCount = n;
      gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    }
  };

  async function load() {
    ta.disabled = true;
    try {
      const r = await session.req('readText', { path });
      if (r.binary) {
        ta.value = '';
        info.textContent = 'binary file';
        el.querySelector('.ed-body').innerHTML = `<div class="empty">${icon('file')}<p>This looks like a binary file (${formatBytes(r.size)}).</p><button class="btn" data-act="download">${icon('download')} Download it</button></div>`;
        return;
      }
      ta.value = saved = r.content;
      info.textContent = formatBytes(r.size);
      setDirty(false);
      lines();
    } catch (e) {
      toast(e.message, 'error');
      info.textContent = e.message;
    } finally {
      ta.disabled = false;
    }
  }

  async function save() {
    try {
      await session.req('writeText', { path, content: ta.value });
      saved = ta.value;
      setDirty(false);
      info.textContent = `saved ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    }
  }

  ta.addEventListener('input', () => {
    setDirty(ta.value !== saved);
    lines();
  });
  ta.addEventListener('scroll', () => (gutter.scrollTop = ta.scrollTop));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Tab' && !e.ctrlKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t') || ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
    }
  });
  $('.ed-wrap', el).addEventListener('change', (e) => {
    ta.wrap = e.target.checked ? 'soft' : 'off';
    gutter.hidden = e.target.checked;
  });
  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') save();
    if (act === 'download') session.download(path).catch((err) => toast(err.message, 'error'));
    if (act === 'reload' && (!dirty || (await confirmBox('Reload file?', 'Discard your unsaved changes and reload from the remote?', { okLabel: 'Reload', danger: true })))) load();
  });

  let loaded = false;
  return {
    el,
    show() {
      if (!loaded) {
        loaded = true;
        load();
      }
      ta.focus();
    },
    async canClose() {
      return !dirty || confirmBox('Unsaved changes', `Close ${basename(path)} without saving?`, { okLabel: 'Discard', danger: true });
    },
  };
}
