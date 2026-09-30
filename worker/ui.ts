// Vault front end — served by the Worker so it is only reachable after sign-in.
// No inline scripts or styles: the vault CSP only allows 'self'.

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const head = (title: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(title)} — GeoLi Vault</title>
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
  <link rel="stylesheet" href="/vault/app.css" />
  <script src="/theme-init.js"></script>
</head>`;

const header = `
  <header class="v-top">
    <a href="/" class="v-logo">GeoLi<span>.</span></a>
    <span class="v-badge">Vault</span>
    <span class="v-spacer"></span>
    <span class="v-user" id="user"></span>
    <a class="v-btn v-btn--ghost" href="/cdn-cgi/access/logout">Sign out</a>
  </header>`;

/** A simple private page (Markdown pages, errors). `body` must already be safe HTML. */
export const pageHtml = (title: string, body: string) => `${head(title)}
<body>
${header}
  <main class="v-main v-prose">
    <p><a href="/vault/">← Vault</a></p>
    ${body}
  </main>
</body>
</html>`;

export const APP_HTML = `${head('Files')}
<body>
${header}
  <main class="v-main">
    <nav class="v-crumbs" id="crumbs" aria-label="Folder"></nav>

    <div class="v-toolbar" id="adminBar" hidden>
      <label class="v-btn v-btn--primary">
        Upload files<input type="file" id="fileInput" multiple hidden />
      </label>
      <button class="v-btn v-btn--ghost" id="newFolder" type="button">New folder</button>
      <span class="v-hint">…or drop files anywhere on this page</span>
    </div>

    <div id="uploads" class="v-uploads"></div>

    <table class="v-table">
      <thead><tr><th>Name</th><th class="v-num">Size</th><th>Modified</th><th class="v-actions-h"><span class="v-sr">Actions</span></th></tr></thead>
      <tbody id="rows"><tr><td colspan="4" class="v-empty">Loading…</td></tr></tbody>
    </table>
    <p class="v-foot">Folders under <code>people/&lt;email&gt;/</code> are visible only to that person. Markdown files (<code>.md</code>) open as pages.</p>
  </main>

  <div class="v-drop" id="drop" hidden><p>Drop to upload</p></div>

  <dialog id="shareDialog" class="v-dialog">
    <form method="dialog">
      <h2>Share link</h2>
      <p class="v-muted" id="shareName"></p>
      <label>Valid for
        <select id="shareHours">
          <option value="1">1 hour</option>
          <option value="24" selected>1 day</option>
          <option value="168">7 days</option>
          <option value="720">30 days</option>
        </select>
      </label>
      <button class="v-btn v-btn--primary" id="shareCreate" type="button">Create link</button>
      <div id="shareResult" hidden>
        <input id="shareUrl" readonly />
        <button class="v-btn v-btn--ghost" id="shareCopy" type="button">Copy</button>
        <p class="v-muted" id="shareExpires"></p>
      </div>
      <p class="v-muted v-small">Anyone with the link can download the file until it expires — no sign-in needed.</p>
      <button class="v-btn v-btn--ghost" value="close">Close</button>
    </form>
  </dialog>

  <script type="module" src="/vault/app.js"></script>
</body>
</html>`;

export const APP_CSS = `
@font-face { font-family: 'Inter'; font-weight: 100 900; font-display: swap; src: url('/assets/fonts/inter.woff2') format('woff2'); }
@font-face { font-family: 'Syne'; font-weight: 400 800; font-display: swap; src: url('/assets/fonts/syne.woff2') format('woff2'); }
:root {
  color-scheme: dark;
  --bg: #08090f; --card: rgba(255,255,255,0.03); --border: rgba(255,255,255,0.08); --border-h: rgba(255,255,255,0.16);
  --text: #f1f5f9; --soft: #94a3b8; --muted: #7d8aa1; --accent: #818cf8; --indigo: #6366f1; --cyan: #22d3ee;
  --danger: #f87171; --row-h: rgba(255,255,255,0.03);
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  color-scheme: light; --bg: #f7f8fc; --card: #fff; --border: rgba(15,23,42,0.09); --border-h: rgba(15,23,42,0.2);
  --text: #0f172a; --soft: #334155; --muted: #556173; --accent: #4f46e5; --danger: #b91c1c; --row-h: rgba(15,23,42,0.03);
} }
:root[data-theme="light"] {
  color-scheme: light; --bg: #f7f8fc; --card: #fff; --border: rgba(15,23,42,0.09); --border-h: rgba(15,23,42,0.2);
  --text: #0f172a; --soft: #334155; --muted: #556173; --accent: #4f46e5; --danger: #b91c1c; --row-h: rgba(15,23,42,0.03);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 Inter, system-ui, sans-serif; }
a { color: var(--accent); }
[hidden] { display: none !important; }
.v-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.v-top { display: flex; align-items: center; gap: 0.75rem; padding: 1rem clamp(1rem, 4vw, 2.5rem); border-bottom: 1px solid var(--border); }
.v-logo { font: 700 1.35rem Syne, sans-serif; color: var(--text); text-decoration: none; }
.v-logo span { color: var(--indigo); }
.v-badge { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--border-h); border-radius: 100px; padding: 0.15rem 0.6rem; }
.v-spacer { flex: 1; }
.v-user { color: var(--muted); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40vw; }
.v-main { max-width: 1000px; margin: 0 auto; padding: 2rem clamp(1rem, 4vw, 2.5rem) 4rem; }
.v-crumbs { font-size: 1.05rem; margin-bottom: 1.25rem; display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
.v-crumbs a { text-decoration: none; }
.v-crumbs span { color: var(--muted); }
.v-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem; }
.v-hint, .v-muted, .v-foot { color: var(--muted); font-size: 0.85rem; }
.v-small { font-size: 0.78rem; }
.v-btn { display: inline-flex; align-items: center; gap: 0.4rem; border-radius: 100px; padding: 0.55rem 1.1rem; font: 500 0.85rem Inter, sans-serif; cursor: pointer; border: 1px solid transparent; text-decoration: none; }
.v-btn--primary { background: linear-gradient(135deg, var(--indigo), var(--cyan)); color: #fff; }
.v-btn--ghost { background: var(--card); color: var(--soft); border-color: var(--border); }
.v-btn--ghost:hover { border-color: var(--border-h); color: var(--text); }
.v-btn--sm { padding: 0.25rem 0.7rem; font-size: 0.78rem; }
.v-btn--danger { color: var(--danger); }
.v-btn:focus-visible, a:focus-visible { outline: 2px solid var(--indigo); outline-offset: 2px; }
.v-table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.v-table th { text-align: left; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); }
.v-table td { padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
.v-table tr:last-child td { border-bottom: 0; }
.v-table tbody tr:hover { background: var(--row-h); }
.v-num { text-align: right; white-space: nowrap; }
.v-date { color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
.v-name { word-break: break-word; }
.v-name a { color: var(--text); text-decoration: none; }
.v-name a:hover { color: var(--accent); }
.v-icon { display: inline-block; width: 1.4rem; color: var(--muted); }
.v-actions { display: flex; gap: 0.35rem; justify-content: flex-end; flex-wrap: wrap; }
.v-empty { text-align: center; color: var(--muted); padding: 2.5rem 1rem !important; }
.v-uploads { display: grid; gap: 0.5rem; margin-bottom: 1rem; }
.v-upload { display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 1rem; font-size: 0.85rem; }
.v-upload progress { grid-column: 1 / -1; width: 100%; height: 6px; accent-color: var(--indigo); }
.v-upload.error { color: var(--danger); }
.v-drop { position: fixed; inset: 0; background: rgba(99,102,241,0.18); border: 3px dashed var(--indigo); display: grid; place-items: center; font: 700 1.5rem Syne, sans-serif; z-index: 10; pointer-events: none; }
.v-dialog { background: var(--bg); color: var(--text); border: 1px solid var(--border-h); border-radius: 16px; padding: 1.5rem; width: min(480px, 92vw); }
.v-dialog::backdrop { background: rgba(0,0,0,0.55); }
.v-dialog form { display: grid; gap: 0.9rem; }
.v-dialog h2 { margin: 0; font: 700 1.2rem Syne, sans-serif; }
.v-dialog select, .v-dialog input { width: 100%; margin-top: 0.3rem; padding: 0.55rem 0.75rem; border-radius: 10px; border: 1px solid var(--border-h); background: var(--card); color: var(--text); font: inherit; }
#shareResult { display: grid; gap: 0.5rem; }
.v-prose { max-width: 760px; }
.v-prose h1, .v-prose h2, .v-prose h3 { font-family: Syne, sans-serif; line-height: 1.25; }
.v-prose p, .v-prose li { color: var(--soft); }
.v-prose pre { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; overflow-x: auto; }
.v-prose img { max-width: 100%; border-radius: 12px; }
.v-prose table { border-collapse: collapse; } .v-prose td, .v-prose th { border: 1px solid var(--border); padding: 0.4rem 0.7rem; }
@media (max-width: 640px) {
  .v-table th:nth-child(3), .v-table td:nth-child(3) { display: none; }
  .v-user { display: none; }
}
`;

export const APP_JS = `
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};
const encKey = (k) => k.split('/').map(encodeURIComponent).join('/');
const size = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const date = (s) => new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const base = (k) => k.replace(/\\/$/, '').split('/').pop();

let me = { admin: false, sharing: false };
const prefix = () => decodeURIComponent(location.hash.replace(/^#\\/?/, ''));
const go = (p) => { location.hash = '/' + p; };

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function crumbs(p) {
  const nav = $('#crumbs');
  nav.replaceChildren(el('a', { href: '#/', textContent: 'Vault' }));
  let acc = '';
  for (const part of p.split('/').filter(Boolean)) {
    acc += part + '/';
    nav.append(el('span', { textContent: '/' }), el('a', { href: '#/' + acc, textContent: part }));
  }
}

function actionBtn(label, onClick, extra = '') {
  return el('button', { type: 'button', className: 'v-btn v-btn--ghost v-btn--sm ' + extra, textContent: label, onclick: onClick });
}

async function load() {
  const p = prefix();
  crumbs(p);
  const rows = $('#rows');
  let data;
  try {
    data = await api('/vault/api/list?prefix=' + encodeURIComponent(p));
  } catch (e) {
    rows.replaceChildren(el('tr', {}, el('td', { colSpan: 4, className: 'v-empty', textContent: e.message })));
    return;
  }
  const out = [];
  if (p) {
    const up = p.split('/').filter(Boolean).slice(0, -1).join('/');
    out.push(el('tr', {}, el('td', { className: 'v-name', colSpan: 4 }, el('a', { href: '#/' + (up ? up + '/' : ''), textContent: '↩ ..' }))));
  }
  for (const f of data.folders) {
    const actions = el('div', { className: 'v-actions' });
    if (me.admin) actions.append(actionBtn('Delete', () => remove(f, true), 'v-btn--danger'));
    out.push(el('tr', {},
      el('td', { className: 'v-name' }, el('span', { className: 'v-icon', textContent: '📁' }), el('a', { href: '#/' + f, textContent: base(f) })),
      el('td', { className: 'v-num', textContent: '—' }), el('td', { className: 'v-date', textContent: '' }), el('td', {}, actions)));
  }
  for (const f of data.files) {
    const isPage = f.key.endsWith('.md');
    const href = (isPage ? '/vault/p/' : '/vault/f/') + encKey(f.key);
    const actions = el('div', { className: 'v-actions' },
      el('a', { className: 'v-btn v-btn--ghost v-btn--sm', href: '/vault/f/' + encKey(f.key) + '?download', textContent: 'Download' }));
    if (me.admin && me.sharing) actions.append(actionBtn('Share', () => openShare(f.key)));
    if (me.admin) actions.append(actionBtn('Delete', () => remove(f.key, false), 'v-btn--danger'));
    out.push(el('tr', {},
      el('td', { className: 'v-name' }, el('span', { className: 'v-icon', textContent: isPage ? '📄' : '▫️' }),
        el('a', { href, target: isPage ? '' : '_blank', rel: 'noopener', textContent: base(f.key) })),
      el('td', { className: 'v-num', textContent: size(f.size) }),
      el('td', { className: 'v-date', textContent: date(f.uploaded) }),
      el('td', {}, actions)));
  }
  if (!data.folders.length && !data.files.length) out.push(el('tr', {}, el('td', { colSpan: 4, className: 'v-empty', textContent: me.admin ? 'Empty — upload something.' : 'Nothing here yet.' })));
  rows.replaceChildren(...out);
}

async function remove(key, folder) {
  const msg = folder ? 'Delete the folder "' + base(key) + '" and EVERYTHING in it?' : 'Delete "' + base(key) + '"?';
  if (!confirm(msg)) return;
  try { await api('/vault/api/files/' + encKey(key) + (folder && !key.endsWith('/') ? '/' : ''), { method: 'DELETE' }); }
  catch (e) { alert(e.message); }
  load();
}

function upload(file) {
  const key = prefix() + file.name;
  const row = el('div', { className: 'v-upload' }, el('span', { textContent: file.name }), el('span', { textContent: size(file.size) }), el('progress', { max: 100, value: 0 }));
  $('#uploads').append(row);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/vault/api/files/' + encKey(key));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) row.querySelector('progress').value = (e.loaded / e.total) * 100; };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) row.remove();
      else { row.classList.add('error'); row.children[1].textContent = (JSON.parse(xhr.responseText || '{}').error) || 'Failed'; }
      resolve();
    };
    xhr.onerror = () => { row.classList.add('error'); row.children[1].textContent = 'Network error'; resolve(); };
    xhr.send(file);
  });
}
async function uploadAll(files) {
  for (const f of files) await upload(f); // sequential keeps memory and rate limits sane
  load();
}

let shareKey = '';
function openShare(key) {
  shareKey = key;
  $('#shareName').textContent = key;
  $('#shareResult').hidden = true;
  $('#shareDialog').showModal();
}

async function init() {
  try { me = await api('/vault/api/me'); } catch { $('#rows').replaceChildren(el('tr', {}, el('td', { colSpan: 4, className: 'v-empty', textContent: 'Please sign in again.' }))); return; }
  $('#user').textContent = me.email + (me.admin ? ' · admin' : '');
  if (me.admin) {
    $('#adminBar').hidden = false;
    $('#fileInput').onchange = (e) => { uploadAll([...e.target.files]); e.target.value = ''; };
    $('#newFolder').onclick = async () => {
      const name = (prompt('Folder name') || '').trim().replace(/\\//g, '-');
      if (!name) return;
      try { await api('/vault/api/files/' + encKey(prefix() + name) + '/', { method: 'PUT' }); } catch (e) { alert(e.message); }
      load();
    };
    let depth = 0;
    const drop = $('#drop');
    addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; drop.hidden = false; } });
    addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('drop', (e) => { e.preventDefault(); depth = 0; drop.hidden = true; if (e.dataTransfer?.files.length) uploadAll([...e.dataTransfer.files]); });

    $('#shareCreate').onclick = async () => {
      try {
        const r = await api('/vault/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: shareKey, hours: Number($('#shareHours').value) }) });
        $('#shareUrl').value = r.url;
        $('#shareExpires').textContent = 'Expires ' + date(r.expires);
        $('#shareResult').hidden = false;
        $('#shareUrl').select();
      } catch (e) { alert(e.message); }
    };
    $('#shareCopy').onclick = async () => {
      try { await navigator.clipboard.writeText($('#shareUrl').value); $('#shareCopy').textContent = 'Copied'; setTimeout(() => $('#shareCopy').textContent = 'Copy', 1500); }
      catch { $('#shareUrl').select(); }
    };
  }
  addEventListener('hashchange', load);
  load();
}
init();
`;
