// SFTP file explorer.

import { icon, h, $, $$, esc, toast, modal, confirmBox, promptBox, contextMenu, formatBytes, formatDate, fileKind, isTextLike, joinPath, dirname, basename } from './ui.js';

let clipboard = null; // { op: 'copy' | 'cut', paths: [] }

export function createFileExplorer(session, info, actions) {
  const home = info.home;
  const bmKey = `sshportal.bookmarks.${info.username}@${info.host}`;
  const prefs = JSON.parse(localStorage.getItem('sshportal.filePrefs') || '{}');
  const state = {
    cwd: home,
    back: [],
    forward: [],
    entries: [],
    visible: [],
    selected: new Set(),
    anchor: null,
    showHidden: prefs.showHidden ?? false,
    view: prefs.view || 'list',
    sort: prefs.sort || { key: 'name', dir: 1 },
    filter: '',
    searchResults: null,
  };
  const savePrefs = () => localStorage.setItem('sshportal.filePrefs', JSON.stringify({ showHidden: state.showHidden, view: state.view, sort: state.sort }));

  const el = h(`<div class="files">
    <div class="toolbar">
      <div class="btn-group">
        <button class="icon-btn" data-act="back" title="Back (Alt+←)" aria-label="Back">${icon('back')}</button>
        <button class="icon-btn" data-act="forward" title="Forward (Alt+→)" aria-label="Forward">${icon('forward')}</button>
        <button class="icon-btn" data-act="up" title="Up (Backspace)" aria-label="Parent folder">${icon('up')}</button>
        <button class="icon-btn" data-act="refresh" title="Refresh (F5)" aria-label="Refresh">${icon('refresh')}</button>
      </div>
      <div class="pathbar" tabindex="0" title="Click to type a path"><div class="crumbs"></div><input class="path-input" spellcheck="false" aria-label="Path" hidden></div>
      <label class="search-box">${icon('search')}<input type="search" placeholder="Filter · Enter to search subfolders" aria-label="Filter files"></label>
      <div class="btn-group">
        <button class="icon-btn" data-act="newFolder" title="New folder" aria-label="New folder">${icon('folderPlus')}</button>
        <button class="icon-btn" data-act="newFile" title="New file" aria-label="New file">${icon('filePlus')}</button>
        <button class="icon-btn" data-act="upload" title="Upload files" aria-label="Upload">${icon('upload')}</button>
        <button class="icon-btn" data-act="terminal" title="Open terminal here" aria-label="Terminal here">${icon('terminal')}</button>
        <button class="icon-btn" data-act="view" title="Toggle list / grid" aria-label="Toggle view">${icon('grid')}</button>
        <button class="icon-btn" data-act="hidden" title="Show hidden files (Ctrl+H)" aria-label="Toggle hidden files">${icon('eye')}</button>
      </div>
    </div>
    <div class="files-body">
      <aside class="places" aria-label="Places"></aside>
      <div class="listing" tabindex="0" aria-label="Files"></div>
    </div>
    <div class="statusbar"><span class="st-left"></span><span class="st-right"></span></div>
    <div class="drop-overlay" hidden>${icon('upload')}<p>Drop to upload into <b class="drop-dir"></b></p></div>
    <input type="file" multiple hidden class="file-input">
  </div>`);

  const listing = $('.listing', el);
  const crumbs = $('.crumbs', el);
  const pathInput = $('.path-input', el);
  const filterInput = $('.search-box input', el);
  const fileInput = $('.file-input', el);
  const places = $('.places', el);

  // --------------------------------------------------------------- places ---
  function bookmarks() {
    return JSON.parse(localStorage.getItem(bmKey) || '[]');
  }
  function renderPlaces() {
    const std = [
      { name: 'Home', path: home, icon: 'home' },
      { name: 'Desktop', path: `${home}/Desktop`, icon: 'monitor' },
      { name: 'Documents', path: `${home}/Documents`, icon: 'folder' },
      { name: 'Downloads', path: `${home}/Downloads`, icon: 'download' },
      { name: 'Root  /', path: '/', icon: 'server' },
      { name: 'tmp', path: '/tmp', icon: 'folder' },
    ];
    const bms = bookmarks();
    places.innerHTML = `<h3>Places</h3>${std.map((p) => `<button data-path="${esc(p.path)}">${icon(p.icon)}<span>${esc(p.name)}</span></button>`).join('')}
      <h3>Bookmarks</h3>${bms.length ? bms.map((p) => `<button data-path="${esc(p)}" data-bm>${icon('star')}<span>${esc(basename(p))}</span></button>`).join('') : '<p class="muted small">Right-click a folder → Bookmark</p>'}`;
    for (const b of $$('button', places)) {
      b.classList.toggle('active', b.dataset.path === state.cwd);
      b.addEventListener('click', () => navigate(b.dataset.path));
      if (b.dataset.bm !== undefined) {
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [{ label: 'Remove bookmark', icon: 'trash', action: () => toggleBookmark(b.dataset.path) }]);
        });
      }
    }
  }
  function toggleBookmark(p) {
    const bms = bookmarks();
    const i = bms.indexOf(p);
    i >= 0 ? bms.splice(i, 1) : bms.push(p);
    localStorage.setItem(bmKey, JSON.stringify(bms));
    renderPlaces();
  }

  // ----------------------------------------------------------- navigation ---
  async function navigate(path, { push = true } = {}) {
    path = path.replace(/\/+$/, '') || '/';
    listing.classList.add('loading');
    try {
      const entries = await session.req('list', { path });
      if (push && path !== state.cwd) {
        state.back.push(state.cwd);
        state.forward = [];
      }
      state.cwd = path;
      state.entries = entries;
      state.selected.clear();
      state.anchor = null;
      state.searchResults = null;
      state.filter = '';
      filterInput.value = '';
      render();
      renderPlaces();
    } catch (e) {
      toast(e.message.replace(/^readdir: /, ''), 'error');
    } finally {
      listing.classList.remove('loading');
    }
  }
  const refresh = () => navigate(state.cwd, { push: false });

  // ------------------------------------------------------------- rendering ---
  function sorted() {
    const { key, dir } = state.sort;
    let list = state.searchResults ?? state.entries;
    if (!state.showHidden && !state.searchResults) list = list.filter((e) => !e.name.startsWith('.'));
    if (state.filter && !state.searchResults) {
      const f = state.filter.toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(f));
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const cmp =
      {
        size: (a, b) => a.size - b.size,
        mtime: (a, b) => a.mtime - b.mtime,
        mode: (a, b) => a.mode.localeCompare(b.mode),
        owner: (a, b) => (a.owner || '').localeCompare(b.owner || ''),
      }[key] || byName;
    // folders first, then the chosen column, then name as tie-breaker
    return [...list].sort((a, b) => (b.type === 'dir') - (a.type === 'dir') || dir * cmp(a, b) || byName(a, b));
  }

  function render() {
    renderCrumbs();
    state.visible = sorted();
    const head =
      state.view === 'list'
        ? `<div class="row head" role="row">${[
            ['name', 'Name'],
            ['size', 'Size'],
            ['mtime', 'Modified'],
            ['mode', 'Permissions'],
            ['owner', 'Owner'],
          ]
            .map(([k, l]) => `<button class="col-${k}" data-sort="${k}">${l}${state.sort.key === k ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>`)
            .join('')}</div>`
        : '';
    const rows = state.visible
      .map((e, i) => {
        const kind = fileKind(e);
        const name = state.searchResults ? e.path.replace(state.cwd === '/' ? '/' : state.cwd + '/', '') : e.name;
        const sel = state.selected.has(e.path) ? ' selected' : '';
        const ic = icon(kind === 'folder' ? 'folder' : kind, `k-${kind}`);
        return state.view === 'list'
          ? `<div class="row${sel}${e.name.startsWith('.') ? ' hidden-file' : ''}" role="row" data-i="${i}" draggable="true">
              <span class="col-name">${ic}<span class="nm">${esc(name)}</span>${e.link ? `<span class="badge">${icon('link')}</span>` : ''}</span>
              <span class="col-size">${e.type === 'dir' ? '' : formatBytes(e.size)}</span>
              <span class="col-mtime">${formatDate(e.mtime)}</span>
              <span class="col-mode mono">${esc(e.mode || '')}</span>
              <span class="col-owner">${esc(e.owner || e.uid || '')}</span>
            </div>`
          : `<div class="tile${sel}${e.name.startsWith('.') ? ' hidden-file' : ''}" data-i="${i}" draggable="true" title="${esc(name)}">${ic}<span class="nm">${esc(name)}</span></div>`;
      })
      .join('');
    listing.className = `listing view-${state.view}`;
    listing.innerHTML = state.visible.length
      ? `${head}<div class="rows">${rows}</div>`
      : `${head}<div class="empty">${icon('folder')}<p>${state.filter || state.searchResults ? 'No matches' : 'This folder is empty'}</p><p class="muted small">Drop files here to upload</p></div>`;
    $('[data-act="back"]', el).disabled = !state.back.length;
    $('[data-act="forward"]', el).disabled = !state.forward.length;
    $('[data-act="hidden"]', el).classList.toggle('on', state.showHidden);
    $('[data-act="view"]', el).innerHTML = icon(state.view === 'list' ? 'grid' : 'list');
    updateStatus();
  }

  function renderCrumbs() {
    const parts = state.cwd.split('/').filter(Boolean);
    let acc = '';
    crumbs.innerHTML =
      `<button data-path="/">${icon('server')}</button>` +
      parts
        .map((p) => {
          acc += '/' + p;
          return `<span class="sep">›</span><button data-path="${esc(acc)}">${esc(p)}</button>`;
        })
        .join('');
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function updateStatus() {
    const sel = state.visible.filter((e) => state.selected.has(e.path));
    const total = state.visible.length;
    $('.st-left', el).textContent = state.searchResults ? `${total} search results for “${state.filter}”` : `${total} item${total === 1 ? '' : 's'}`;
    $('.st-right', el).textContent = sel.length ? `${sel.length} selected · ${formatBytes(sel.reduce((s, e) => s + (e.type === 'dir' ? 0 : e.size), 0))}` : '';
    for (const node of $$('[data-i]', listing)) node.classList.toggle('selected', state.selected.has(state.visible[node.dataset.i].path));
  }

  const selection = () => state.visible.filter((e) => state.selected.has(e.path));
  const entryAt = (target) => {
    const node = target.closest('[data-i]');
    return node ? state.visible[node.dataset.i] : null;
  };

  // ---------------------------------------------------------------- open ---
  async function open(entry) {
    if (entry.type === 'dir') return navigate(entry.path);
    const kind = fileKind(entry);
    if (kind === 'image') return preview(entry);
    if (kind === 'code' || isTextLike(entry.name)) return actions.openEditor(entry.path);
    if (kind === 'archive' || kind === 'media') return session.download(entry.path).catch((e) => toast(e.message, 'error'));
    // unknown: try as text, fall back to download
    actions.openEditor(entry.path);
  }

  // Space: peek at a file without opening an editor tab.
  async function quickLook(entry) {
    if (entry.type === 'dir') return properties(entry);
    const kind = fileKind(entry);
    if (kind === 'image') return preview(entry);
    if (!(kind === 'code' || isTextLike(entry.name)) || entry.size > 1 << 20) return properties(entry);
    try {
      const r = await session.req('readText', { path: entry.path, max: 1 << 20 });
      if (r.binary) return properties(entry);
      const text = r.content.length > 200000 ? r.content.slice(0, 200000) + '\n…' : r.content;
      const res = await modal({
        title: entry.name,
        wide: true,
        body: `<pre class="quicklook mono">${esc(text)}</pre><p class="muted small">${formatBytes(entry.size)} · ${formatDate(entry.mtime)} · Space or Esc to close</p>`,
        buttons: [
          { label: 'Edit', value: 'edit' },
          { label: 'Close', value: true, primary: true },
        ],
        onOpen: (dlg) => dlg.addEventListener('keydown', (ev) => ev.key === ' ' && (ev.preventDefault(), $('button[type=submit]', dlg).click())),
      });
      if (res.value === 'edit') actions.openEditor(entry.path);
      listing.focus();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function preview(entry) {
    try {
      const blob = await session.fetchBlob(entry.path);
      const type = entry.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : blob.type;
      const url = URL.createObjectURL(new Blob([blob], { type }));
      await modal({
        title: entry.name,
        wide: true,
        body: `<div class="preview"><img src="${url}" alt="${esc(entry.name)}"></div><p class="muted small">${formatBytes(entry.size)} · ${formatDate(entry.mtime)}</p>`,
        buttons: [
          { label: 'Download', value: 'dl' },
          { label: 'Close', value: true, primary: true },
        ],
      }).then((r) => r.value === 'dl' && session.download(entry.path));
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // -------------------------------------------------------------- actions ---
  async function newFolder() {
    const name = await promptBox('New folder', 'Folder name', 'New Folder', { okLabel: 'Create' });
    if (!name) return;
    try {
      await session.req('mkdir', { path: joinPath(state.cwd, name) });
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function newFile() {
    const name = await promptBox('New file', 'File name', 'untitled.txt', { okLabel: 'Create', selectBase: true });
    if (!name) return;
    try {
      const p = joinPath(state.cwd, name);
      await session.req('touch', { path: p });
      await refresh();
      actions.openEditor(p);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function rename(entry) {
    const name = await promptBox('Rename', 'New name', entry.name, { okLabel: 'Rename', selectBase: entry.type !== 'dir' });
    if (!name || name === entry.name) return;
    try {
      await session.req('rename', { from: entry.path, to: joinPath(dirname(entry.path), name) });
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function remove(entries) {
    if (!entries.length) return;
    const what = entries.length === 1 ? `“${entries[0].name}”` : `${entries.length} items`;
    if (!(await confirmBox('Delete permanently?', `${what} will be permanently deleted from the remote machine. This cannot be undone.`, { okLabel: 'Delete', danger: true }))) return;
    try {
      await session.req('delete', { paths: entries.map((e) => e.path) });
      toast(`Deleted ${what}`);
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function paste() {
    if (!clipboard) return;
    try {
      await session.req(clipboard.op === 'cut' ? 'move' : 'copy', { paths: clipboard.paths, dest: state.cwd });
      if (clipboard.op === 'cut') clipboard = null;
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function moveInto(paths, dest) {
    paths = paths.filter((p) => p !== dest && dirname(p) !== dest);
    if (!paths.length) return;
    try {
      await session.req('move', { paths, dest });
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function properties(entry) {
    const body = h(`<div class="props">
      <dl>
        <dt>Name</dt><dd>${esc(entry.name)}</dd>
        <dt>Path</dt><dd class="mono">${esc(entry.path)}</dd>
        <dt>Type</dt><dd>${entry.type}${entry.link ? ' (symlink)' : ''}</dd>
        <dt>Size</dt><dd>${entry.type === 'dir' ? '<button type="button" class="btn btn-sm" data-du>Calculate</button>' : `${formatBytes(entry.size)} (${entry.size.toLocaleString()} bytes)`}</dd>
        <dt>Modified</dt><dd>${formatDate(entry.mtime)}</dd>
        <dt>Owner</dt><dd>${esc(entry.owner || entry.uid)} : ${esc(entry.group || entry.gid)}</dd>
      </dl>
      <label class="field"><span>Permissions (octal)</span><input name="mode" value="${modeToOctal(entry.mode)}" pattern="[0-7]{3,4}" class="mono"></label>
      <p class="muted small mono">${esc(entry.mode)}</p>
    </div>`);
    $('[data-du]', body)?.addEventListener('click', async (e) => {
      e.target.textContent = 'Calculating…';
      const r = await session.req('exec', { command: `du -sb -- '${entry.path.replace(/'/g, `'\\''`)}' 2>/dev/null | cut -f1` }).catch(() => null);
      e.target.replaceWith(r?.stdout.trim() ? formatBytes(+r.stdout.trim()) : 'unknown');
    });
    const r = await modal({ title: 'Properties', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
    if (r.value === true && r.data.mode && r.data.mode !== modeToOctal(entry.mode)) {
      try {
        await session.req('chmod', { path: entry.path, mode: r.data.mode });
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
  }

  // --------------------------------------------------------------- upload ---
  async function uploadFiles(items, destDir = state.cwd) {
    // items: [{ file, rel }] where rel may include sub-folders
    if (!items.length) return;
    const dirs = [...new Set(items.map((i) => i.rel.split('/').slice(0, -1).join('/')).filter(Boolean))].sort();
    for (const d of dirs) {
      const parts = d.split('/');
      for (let k = 1; k <= parts.length; k++) await session.req('mkdir', { path: joinPath(destDir, parts.slice(0, k).join('/')) }).catch(() => {});
    }
    const total = items.reduce((s, i) => s + i.file.size, 0);
    let done = 0;
    const t = toast('', 'info', 1e9);
    const label = $('span', t);
    try {
      for (const [n, it] of items.entries()) {
        await session.upload(it.file, joinPath(destDir, it.rel), (loaded) => {
          label.textContent = `Uploading ${n + 1}/${items.length} · ${it.rel} · ${Math.round(((done + loaded) / Math.max(total, 1)) * 100)}%`;
        });
        done += it.file.size;
      }
      label.textContent = `Uploaded ${items.length} file${items.length === 1 ? '' : 's'} (${formatBytes(total)})`;
      if (destDir === state.cwd) refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setTimeout(() => t.remove(), 2500);
    }
  }

  async function itemsFromDataTransfer(dt) {
    const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...dt.files].map((file) => ({ file, rel: file.name }));
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, rel: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }

  // -------------------------------------------------------- context menus ---
  function itemMenu(x, y, entry) {
    if (!state.selected.has(entry.path)) {
      state.selected = new Set([entry.path]);
      updateStatus();
    }
    const sel = selection();
    const many = sel.length > 1;
    const isDir = entry.type === 'dir';
    contextMenu(x, y, [
      { label: isDir ? 'Open' : 'Open', icon: isDir ? 'folder' : 'file', action: () => open(entry), disabled: many },
      !isDir && { label: 'Edit as text', icon: 'code', action: () => actions.openEditor(entry.path), disabled: many },
      { label: 'Open with remote app (X11)', icon: 'window', action: () => actions.openWithRemote(entry.path), disabled: many },
      isDir && { label: 'Open terminal here', icon: 'terminal', action: () => actions.openTerminal(entry.path), disabled: many },
      '-',
      { label: many || isDir ? 'Download as .tar.gz' : 'Download', icon: 'download', action: () => (many || isDir ? session.downloadTar(sel.map((e) => e.path)) : session.download(entry.path)).catch((e) => toast(e.message, 'error')) },
      { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', action: () => (clipboard = { op: 'copy', paths: sel.map((e) => e.path) }) },
      { label: 'Cut', icon: 'scissors', hint: 'Ctrl+X', action: () => (clipboard = { op: 'cut', paths: sel.map((e) => e.path) }) },
      { label: 'Rename', icon: 'edit', hint: 'F2', action: () => rename(entry), disabled: many },
      { label: 'Copy path', icon: 'clipboard', action: () => navigator.clipboard.writeText(sel.map((e) => e.path).join('\n')) },
      isDir && { label: bookmarks().includes(entry.path) ? 'Remove bookmark' : 'Bookmark', icon: 'star', action: () => toggleBookmark(entry.path), disabled: many },
      '-',
      { label: 'Properties', icon: 'info', action: () => properties(entry), disabled: many },
      { label: 'Delete', icon: 'trash', hint: 'Del', danger: true, action: () => remove(sel) },
    ]);
  }

  function backgroundMenu(x, y) {
    state.selected.clear();
    updateStatus();
    contextMenu(x, y, [
      { label: 'New folder', icon: 'folderPlus', action: newFolder },
      { label: 'New file', icon: 'filePlus', action: newFile },
      { label: 'Upload files…', icon: 'upload', action: () => fileInput.click() },
      { label: `Paste${clipboard ? ` (${clipboard.paths.length})` : ''}`, icon: 'clipboard', hint: 'Ctrl+V', action: paste, disabled: !clipboard },
      '-',
      { label: 'Open terminal here', icon: 'terminal', action: () => actions.openTerminal(state.cwd) },
      { label: 'Refresh', icon: 'refresh', hint: 'F5', action: refresh },
      { label: state.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: 'eye', hint: 'Ctrl+H', action: toggleHidden },
      { label: bookmarks().includes(state.cwd) ? 'Remove bookmark' : 'Bookmark this folder', icon: 'star', action: () => toggleBookmark(state.cwd) },
    ]);
  }

  function toggleHidden() {
    state.showHidden = !state.showHidden;
    savePrefs();
    render();
  }

  // --------------------------------------------------------------- events ---
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    ({
      back: () => state.back.length && (state.forward.push(state.cwd), navigate(state.back.pop(), { push: false })),
      forward: () => state.forward.length && (state.back.push(state.cwd), navigate(state.forward.pop(), { push: false })),
      up: () => navigate(dirname(state.cwd)),
      refresh,
      newFolder,
      newFile,
      upload: () => fileInput.click(),
      terminal: () => actions.openTerminal(state.cwd),
      view: () => {
        state.view = state.view === 'list' ? 'grid' : 'list';
        savePrefs();
        render();
      },
      hidden: toggleHidden,
    })[act]?.();
  });

  crumbs.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) {
      e.stopPropagation();
      navigate(b.dataset.path);
    }
  });
  const editPath = () => {
    crumbs.hidden = true;
    pathInput.hidden = false;
    pathInput.value = state.cwd;
    pathInput.focus();
    pathInput.select();
  };
  $('.pathbar', el).addEventListener('click', (e) => !e.target.closest('button') && editPath());
  $('.pathbar', el).addEventListener('keydown', (e) => e.target === e.currentTarget && e.key === 'Enter' && editPath());
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = pathInput.value.trim().replace(/^~(?=\/|$)/, home);
      pathInput.blur();
      if (v) navigate(v.startsWith('/') ? v : joinPath(state.cwd, v));
    } else if (e.key === 'Escape') pathInput.blur();
  });
  pathInput.addEventListener('blur', () => {
    pathInput.hidden = true;
    crumbs.hidden = false;
  });

  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value;
    state.searchResults = null;
    render();
  });
  filterInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && filterInput.value.trim()) {
      const t = toast(`Searching ${state.cwd} …`, 'info', 1e9);
      try {
        const paths = await session.req('search', { path: state.cwd, query: filterInput.value.trim() });
        const stats = await Promise.all(paths.slice(0, 300).map((p) => session.req('stat', { path: p }).catch(() => null)));
        state.searchResults = stats.filter(Boolean);
        render();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        t.remove();
      }
    } else if (e.key === 'Escape') {
      filterInput.value = '';
      state.filter = '';
      state.searchResults = null;
      render();
      listing.focus();
    }
  });

  listing.addEventListener('click', (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const k = sortBtn.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
      savePrefs();
      return render();
    }
    const entry = entryAt(e.target);
    if (!entry) {
      state.selected.clear();
      return updateStatus();
    }
    if (e.shiftKey && state.anchor) {
      const a = state.visible.findIndex((x) => x.path === state.anchor);
      const b = state.visible.indexOf(entry);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!e.ctrlKey && !e.metaKey) state.selected.clear();
      for (let i = lo; i <= hi; i++) state.selected.add(state.visible[i].path);
    } else if (e.ctrlKey || e.metaKey) {
      state.selected.has(entry.path) ? state.selected.delete(entry.path) : state.selected.add(entry.path);
      state.anchor = entry.path;
    } else {
      state.selected = new Set([entry.path]);
      state.anchor = entry.path;
    }
    updateStatus();
  });
  listing.addEventListener('dblclick', (e) => {
    const entry = entryAt(e.target);
    if (entry) open(entry);
  });
  listing.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const entry = entryAt(e.target);
    entry ? itemMenu(e.clientX, e.clientY, entry) : backgroundMenu(e.clientX, e.clientY);
  });

  listing.addEventListener('keydown', (e) => {
    if (e.target !== listing) return;
    const sel = selection();
    const idx = state.visible.findIndex((x) => x.path === state.anchor);
    const move = (d) => {
      const n = Math.max(0, Math.min(state.visible.length - 1, (idx < 0 ? -1 : idx) + d));
      const entry = state.visible[n];
      if (!entry) return;
      if (e.shiftKey) state.selected.add(entry.path);
      else state.selected = new Set([entry.path]);
      state.anchor = entry.path;
      updateStatus();
      $(`[data-i="${n}"]`, listing)?.scrollIntoView({ block: 'nearest' });
    };
    const cols = state.view === 'grid' ? Math.max(1, Math.floor(($('.rows', listing)?.clientWidth || 1) / 116)) : 1;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowDown') move(cols);
    else if (e.key === 'ArrowUp') move(-cols);
    else if (e.key === 'ArrowRight' && state.view === 'grid') move(1);
    else if (e.key === 'ArrowLeft' && state.view === 'grid') move(-1);
    else if (e.key === 'Enter' && sel.length === 1) open(sel[0]);
    else if (e.key === ' ' && sel.length === 1) quickLook(sel[0]);
    else if (e.key === 'Backspace') navigate(dirname(state.cwd));
    else if (e.key === 'Delete') remove(sel);
    else if (e.key === 'F2' && sel.length === 1) rename(sel[0]);
    else if (e.key === 'F5') refresh();
    else if (ctrl && e.key === 'a') {
      state.selected = new Set(state.visible.map((x) => x.path));
      updateStatus();
    } else if (ctrl && e.key === 'c' && sel.length) clipboard = { op: 'copy', paths: sel.map((x) => x.path) };
    else if (ctrl && e.key === 'x' && sel.length) clipboard = { op: 'cut', paths: sel.map((x) => x.path) };
    else if (ctrl && e.key === 'v') paste();
    else if (ctrl && e.key === 'h') toggleHidden();
    else return;
    e.preventDefault();
  });
  el.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft') $('[data-act="back"]', el).click();
    if (e.altKey && e.key === 'ArrowRight') $('[data-act="forward"]', el).click();
  });

  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files].map((file) => ({ file, rel: file.name })));
    fileInput.value = '';
  });

  // drag & drop: OS files -> upload; rows -> move into folder
  const overlay = $('.drop-overlay', el);
  let dragDepth = 0;
  let draggingPaths = null;
  listing.addEventListener('dragstart', (e) => {
    const entry = entryAt(e.target);
    if (!entry) return;
    if (!state.selected.has(entry.path)) {
      state.selected = new Set([entry.path]);
      updateStatus();
    }
    draggingPaths = selection().map((x) => x.path);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggingPaths.join('\n'));
  });
  listing.addEventListener('dragend', () => (draggingPaths = null));
  el.addEventListener('dragenter', (e) => {
    if (draggingPaths || !e.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    $('.drop-dir', overlay).textContent = state.cwd;
    overlay.hidden = false;
  });
  el.addEventListener('dragleave', () => {
    if (draggingPaths) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      overlay.hidden = true;
    }
  });
  el.addEventListener('dragover', (e) => {
    if (draggingPaths) {
      const target = entryAt(e.target);
      $$('.drop-target', listing).forEach((n) => n.classList.remove('drop-target'));
      if (target?.type === 'dir' && !draggingPaths.includes(target.path)) {
        e.preventDefault();
        e.target.closest('[data-i]').classList.add('drop-target');
      }
    } else if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    $$('.drop-target', listing).forEach((n) => n.classList.remove('drop-target'));
    if (draggingPaths) {
      const target = entryAt(e.target);
      if (target?.type === 'dir') moveInto(draggingPaths, target.path);
      draggingPaths = null;
      return;
    }
    const target = entryAt(e.target);
    const dest = target?.type === 'dir' ? target.path : state.cwd;
    uploadFiles(await itemsFromDataTransfer(e.dataTransfer), dest);
  });

  let loaded = false;
  return {
    el,
    show() {
      if (!loaded) {
        loaded = true;
        navigate(home, { push: false });
      }
      listing.focus({ preventScroll: true });
    },
    navigate,
    refresh,
    get cwd() {
      return state.cwd;
    },
  };
}

function modeToOctal(mode = '') {
  const s = mode.slice(1);
  if (s.length !== 9) return '';
  let out = '';
  for (let i = 0; i < 9; i += 3) out += (s[i] !== '-' ? 4 : 0) + (s[i + 1] !== '-' ? 2 : 0) + (s[i + 2] !== '-' ? 1 : 0);
  return out;
}
