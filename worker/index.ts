// geoli.eu Worker — serves the static site (Astro build in ./dist) and the private /vault.
//
//   /vault/*  private area behind Cloudflare Access (login) — files live in the R2 bucket VAULT
//   /s/<tok>  public, time-limited share links signed with SHARE_SECRET
//   /api/contact  contact form → e-mail via Cloudflare Email Routing (send_email binding)
//   /media/*  public images for articles (uploaded from the vault's article editor, stored in R2 under media/)
//   anything else → static assets (the Worker only runs for the paths in wrangler.jsonc "run_worker_first")
//
// Permissions
//   - any signed-in user may browse and download everything EXCEPT people/<email>/ folders
//   - people/<email>/ is visible only to that person (and admins) — use it for per-person sharing
//   - only ADMIN_EMAILS may upload, delete, create folders and create share links
//   - EDITOR_EMAILS (and admins) may write, publish and unpublish articles and add images to them;
//     deleting an article is admin-only. For files, editors are like invited guests.
import { marked } from 'marked';
import { getUser, type User } from './auth';
import { createShareToken, verifyShareToken, MAX_SHARE_HOURS } from './share';
import { APP_HTML, APP_CSS, APP_JS, pageHtml } from './ui';
import { listPosts, getPost, savePost, deletePost, validate, HttpError } from './posts';
import { handleContact } from './contact';

export interface Env {
  ASSETS: Fetcher;
  VAULT: R2Bucket;
  ACCESS_TEAM_DOMAIN: string; // e.g. "geoli.cloudflareaccess.com"
  ACCESS_AUD: string;         // Access application "Audience (AUD) tag"
  ADMIN_EMAILS: string;       // comma-separated
  EDITOR_EMAILS?: string;     // comma-separated — article writers
  SHARE_SECRET?: string;      // secret — `wrangler secret put SHARE_SECRET`
  DEV_EMAIL?: string;         // local development only (.dev.vars)
  GITHUB_TOKEN?: string;      // secret — fine-grained token: this repo only, Contents read/write
  GITHUB_REPO?: string;       // default GeorgeLincu/geoli
  GITHUB_BRANCH?: string;     // default main
  CONTACT_EMAIL?: SendEmail;  // send_email binding (destination must be a verified Email Routing address)
  CONTACT_FROM?: string;      // sender on geoli.eu, e.g. formular@geoli.eu
  CONTACT_TO?: string;        // where messages go
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // Workers request-body limit on the free plan
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const PEOPLE = 'people/';

// Types that are safe to render inline on our origin. Everything else is forced to download
// (HTML/SVG/XML could otherwise run script as geoli.eu).
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|text\/plain|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav|webm))$/;

const baseHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function respond(body: BodyInit | null, init: ResponseInit & { csp?: string } = {}) {
  const headers = new Headers({ ...baseHeaders, ...(init.headers as Record<string, string>) });
  if (init.csp) headers.set('Content-Security-Policy', init.csp);
  return new Response(body, { ...init, headers });
}
const json = (data: unknown, status = 200) =>
  respond(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const error = (status: number, message: string) => json({ error: message }, status);
const html = (body: string, status = 200) =>
  respond(body, { status, csp: APP_CSP, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

/** Object keys: relative, no traversal, no control characters. Folders end with "/". */
function cleanKey(raw: string, { folder = false } = {}): string | null {
  let key: string;
  try { key = decodeURIComponent(raw); } catch { return null; }
  key = key.replace(/^\/+/, '');
  if (!key || key.length > 512) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return null;
  if (key.split('/').some(seg => seg === '..' || seg === '.')) return null;
  if (!folder && key.endsWith('/')) return null;
  if (folder && !key.endsWith('/')) key += '/';
  return key;
}

// people/<email>/ folders: compare case-insensitively (emails are lower-cased at sign-in)
const ownFolder = (user: User, key: string) => key.toLowerCase().startsWith(`${PEOPLE}${user.email}/`);

function canRead(user: User, key: string) {
  if (user.admin) return true;
  if (!key.startsWith(PEOPLE)) return true;
  return ownFolder(user, key);
}

function fileName(key: string) {
  return key.split('/').filter(Boolean).pop() || 'download';
}
function disposition(kind: 'inline' | 'attachment', key: string) {
  const name = fileName(key);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream an R2 object with range support. */
async function serveObject(env: Env, request: Request, key: string, opts: { forceDownload?: boolean } = {}) {
  const obj = await env.VAULT.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return error(404, 'Not found');

  const headers = new Headers(baseHeaders);
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');

  const type = (headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const inline = !opts.forceDownload && INLINE_TYPES.test(type);
  headers.set('Content-Disposition', disposition(inline ? 'inline' : 'attachment', key));
  if (!inline) headers.set('Content-Type', 'application/octet-stream');
  if (type === 'text/plain') headers.set('Content-Type', 'text/plain; charset=utf-8');
  // Sandbox everything except PDFs (Chrome's PDF viewer refuses to run sandboxed)
  if (type !== 'application/pdf') headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");

  if (!('body' in obj)) return new Response(null, { status: 304, headers }); // onlyIf precondition matched
  const range = (obj as R2ObjectBody & { range?: { offset: number; length: number } }).range;
  if (range && request.headers.has('Range')) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}

async function list(env: Env, user: User, prefix: string) {
  // Non-admins inside people/ only ever see their own folder
  if (!user.admin && prefix.startsWith(PEOPLE) && !ownFolder(user, prefix)) {
    if (prefix !== PEOPLE) return error(403, 'Forbidden');
    return json({ prefix, folders: [`${PEOPLE}${user.email}/`], files: [] });
  }

  const folders = new Set<string>();
  const files: { key: string; size: number; uploaded: string; type: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VAULT.list({ prefix, delimiter: '/', cursor, include: ['httpMetadata'] });
    page.delimitedPrefixes.forEach(p => folders.add(p));
    for (const o of page.objects) {
      if (o.key.endsWith('/.keep')) continue;
      files.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString(), type: o.httpMetadata?.contentType || '' });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && files.length < 5000);

  let visible = [...folders];
  if (!user.admin && prefix === '') visible = visible.filter(f => f !== PEOPLE).concat(`${PEOPLE}${user.email}/`);
  return json({ prefix, folders: [...new Set(visible)].sort(), files: files.sort((a, b) => a.key.localeCompare(b.key)) });
}

async function deletePrefix(env: Env, prefix: string) {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.VAULT.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) {
      await env.VAULT.delete(page.objects.map(o => o.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

async function renderMarkdownPage(env: Env, key: string) {
  const obj = await env.VAULT.get(key);
  if (!obj) return html(pageHtml('Not found', '<p>This page does not exist.</p>'), 404);
  const md = await obj.text();
  const title = md.match(/^#\s+(.+)$/m)?.[1] ?? fileName(key).replace(/\.md$/, '');
  // Only admins can upload, and the page CSP blocks inline script, so raw HTML in Markdown is contained
  const body = await marked.parse(md, { gfm: true });
  return html(pageHtml(title, body));
}

async function handleVault(request: Request, env: Env, url: URL) {
  const user = await getUser(request, env);
  if (!user) {
    return html(pageHtml('Sign-in required',
      '<p>This area is private. If you were invited, open <a href="/vault/">geoli.eu/vault</a> and sign in with the e-mail address the invitation was sent to.</p>'), 401);
  }

  const path = url.pathname;
  const method = request.method;

  // CSRF: state-changing requests must come from our own pages
  if (method !== 'GET' && method !== 'HEAD') {
    if (request.headers.get('Origin') !== url.origin) return error(403, 'Bad origin');
  }

  if (path === '/vault/app.css') return respond(APP_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
  if (path === '/vault/app.js')  return respond(APP_JS,  { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });

  if (path === '/vault/api/me') {
    const role = user.admin ? 'admin' : user.editor ? 'editor' : 'guest';
    return json({ email: user.email, role, admin: user.admin, sharing: !!env.SHARE_SECRET, publishing: user.editor && !!env.GITHUB_TOKEN });
  }

  // ─── Article publishing (admin) ───
  if (path.startsWith('/vault/api/posts') || path === '/vault/api/preview' || path.startsWith('/vault/api/media/')) {
    if (!user.editor) return error(403, 'Only editors and admins can manage articles');
    try {
      return await handlePublishing(request, env, url, user);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message);
      throw e;
    }
  }

  if (path === '/vault/api/list' && method === 'GET') {
    const raw = url.searchParams.get('prefix') || '';
    const prefix = raw === '' ? '' : cleanKey(raw, { folder: true });
    if (prefix === null) return error(400, 'Bad path');
    return list(env, user, prefix);
  }

  // /vault/api/files/<key>   PUT = upload (admin), DELETE = delete file or folder (admin)
  if (path.startsWith('/vault/api/files/')) {
    if (!user.admin) return error(403, 'Only admins can change files');
    const rawKey = path.slice('/vault/api/files/'.length);
    const isFolder = rawKey.endsWith('/') || rawKey.endsWith('%2F');

    if (method === 'PUT') {
      if (isFolder) {
        const folder = cleanKey(rawKey, { folder: true });
        if (!folder) return error(400, 'Bad folder name');
        await env.VAULT.put(`${folder}.keep`, '');
        return json({ ok: true, key: folder });
      }
      const key = cleanKey(rawKey);
      if (!key) return error(400, 'Bad file name');
      const length = Number(request.headers.get('Content-Length') || NaN);
      if (!Number.isFinite(length)) return error(411, 'Content-Length required');
      if (length > MAX_UPLOAD_BYTES) return error(413, 'File too large (max 100 MB)');
      const type = (request.headers.get('Content-Type') || 'application/octet-stream').slice(0, 200);
      await env.VAULT.put(key, request.body, { httpMetadata: { contentType: type }, customMetadata: { uploadedBy: user.email } });
      return json({ ok: true, key });
    }

    if (method === 'DELETE') {
      if (isFolder) {
        const folder = cleanKey(rawKey, { folder: true });
        if (!folder) return error(400, 'Bad folder name');
        return json({ ok: true, deleted: await deletePrefix(env, folder) });
      }
      const key = cleanKey(rawKey);
      if (!key) return error(400, 'Bad file name');
      await env.VAULT.delete(key);
      return json({ ok: true, deleted: 1 });
    }
    return error(405, 'Method not allowed');
  }

  if (path === '/vault/api/share' && method === 'POST') {
    if (!user.admin) return error(403, 'Only admins can share');
    if (!env.SHARE_SECRET || env.SHARE_SECRET.length < 32) return error(503, 'Sharing is not configured (SHARE_SECRET)');
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) return error(415, 'JSON expected');
    const body = (await request.json().catch(() => ({}))) as { key?: string; hours?: number };
    const key = cleanKey(body.key || '');
    const hours = Math.min(Math.max(Number(body.hours) || 24, 1), MAX_SHARE_HOURS);
    if (!key) return error(400, 'Bad file');
    if (!(await env.VAULT.head(key))) return error(404, 'Not found');
    const { token, expires } = await createShareToken(key, hours, env.SHARE_SECRET);
    return json({ url: `${url.origin}/s/${token}`, expires: new Date(expires * 1000).toISOString() });
  }

  // /vault/f/<key> — download or view a file
  if (path.startsWith('/vault/f/') && (method === 'GET' || method === 'HEAD')) {
    const key = cleanKey(path.slice('/vault/f/'.length));
    if (!key || !canRead(user, key)) return error(404, 'Not found');
    return serveObject(env, request, key, { forceDownload: url.searchParams.has('download') });
  }

  // /vault/p/<key>.md — a private page written in Markdown
  if (path.startsWith('/vault/p/') && method === 'GET') {
    const key = cleanKey(path.slice('/vault/p/'.length));
    if (!key || !key.endsWith('.md') || !canRead(user, key)) return html(pageHtml('Not found', '<p>This page does not exist.</p>'), 404);
    return renderMarkdownPage(env, key);
  }

  if (path === '/vault' ) return Response.redirect(`${url.origin}/vault/`, 301);
  if (path === '/vault/' && method === 'GET') return html(APP_HTML);
  return error(404, 'Not found');
}

async function handlePublishing(request: Request, env: Env, url: URL, user: User) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/vault/api/preview' && method === 'POST') {
    const { body } = (await request.json().catch(() => ({}))) as { body?: string };
    return json({ html: await marked.parse(String(body || '').slice(0, 300_000), { gfm: true }) });
  }

  // PUT /vault/api/media/<slug>/<file.ext> — image for an article, public at /media/blog/<slug>/<unique-name>
  if (path.startsWith('/vault/api/media/') && method === 'PUT') {
    const [slug, ...rest] = path.slice('/vault/api/media/'.length).split('/');
    const raw = decodeURIComponent(rest.join('/'));
    const ext = (raw.split('.').pop() || '').toLowerCase();
    if (!/^[a-z0-9-]{1,90}$/.test(slug) || !IMAGE_TYPES[ext]) return error(400, 'Images only: PNG, JPG, WebP, GIF, AVIF');
    const length = Number(request.headers.get('Content-Length') || NaN);
    if (!Number.isFinite(length)) return error(411, 'Content-Length required');
    if (length > MAX_IMAGE_BYTES) return error(413, 'Image too large (max 8 MB)');
    const base = raw.replace(/\.[^.]+$/, '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'image';
    const key = `media/blog/${slug}/${Date.now().toString(36)}-${base}.${ext}`;
    await env.VAULT.put(key, request.body, { httpMetadata: { contentType: IMAGE_TYPES[ext] }, customMetadata: { uploadedBy: user.email } });
    return json({ ok: true, url: `/${key}` });
  }

  if (path === '/vault/api/posts' && method === 'GET') return json({ posts: await listPosts(env) });

  const slug = decodeURIComponent(path.slice('/vault/api/posts/'.length));
  if (!slug) return error(404, 'Not found');

  if (method === 'GET') {
    const post = await getPost(env, slug);
    return post ? json(post) : error(404, 'Not found');
  }
  if (method === 'PUT') {
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) return error(415, 'JSON expected');
    const post = validate({ ...((await request.json().catch(() => ({}))) as object), slug });
    return json({ ok: true, ...(await savePost(env, post, user.email)) });
  }
  if (method === 'DELETE') {
    if (!user.admin) return error(403, 'Only admins can delete articles — unpublish it instead (tick Draft)');
    await deletePost(env, slug, url.searchParams.get('sha') || '', user.email);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

/** Public article images from R2 (media/…). Unique file names → cache forever. */
async function handleMedia(request: Request, env: Env, url: URL) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'Method not allowed');
  const key = cleanKey(url.pathname.slice(1));
  if (!key || !key.startsWith('media/')) return error(404, 'Not found');
  const obj = await env.VAULT.get(key, { onlyIf: request.headers });
  if (!obj) return error(404, 'Not found');
  const type = obj.httpMetadata?.contentType || '';
  if (!Object.values(IMAGE_TYPES).includes(type)) return error(404, 'Not found');
  const headers = new Headers({
    'Content-Type': type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    ETag: obj.httpEtag,
  });
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : (obj as R2ObjectBody).body, { headers });
}

async function handleShare(request: Request, env: Env, url: URL) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'Method not allowed');
  const expired = () => html(pageHtml('Link expired', '<p>This share link is invalid or has expired. Ask the sender for a new one.</p>'), 410);
  if (!env.SHARE_SECRET) return expired();
  const key = await verifyShareToken(url.pathname.slice('/s/'.length), env.SHARE_SECRET);
  if (!key) return expired();
  const res = await serveObject(env, request, key, { forceDownload: !url.searchParams.has('view') });
  return res.status === 404 ? expired() : res;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/vault' || url.pathname.startsWith('/vault/')) return await handleVault(request, env, url);
      if (url.pathname.startsWith('/s/')) return await handleShare(request, env, url);
      if (url.pathname.startsWith('/media/')) return await handleMedia(request, env, url);
      if (url.pathname === '/api/contact') return await handleContact(request, env, url);
    } catch (err) {
      console.error(err);
      return error(500, 'Something went wrong');
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
