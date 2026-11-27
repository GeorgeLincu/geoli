// Private investment section — owner only (INVEST_EMAILS).
//
//   /vault/invest/*            pages built by Astro (dist/vault/invest/), served only after the owner check
//   /vault/api/invest/<doc>    GET / PUT one JSON document in R2: invest/<doc>.json  (doc = data | tax-rules | ips)
//
// Everyone else (other admins, editors) gets the same 404 as an unknown path.
// R2 keys under invest/ are hidden from the Files view (see index.ts).
import type { Env } from './index';
import type { User } from './auth';
import { emailList } from './auth';
import { baseHeaders, error, json } from './http';
import { isDocName, validateDoc, MAX_DOC_BYTES } from '../src/lib/invest/validate';
import { emptyDoc } from '../src/lib/invest/types';
import { handleMarketApi } from './market';
import { handleAlertsApi } from './alerts';

export const INVEST_PREFIX = 'invest/';
const BACKUPS_KEPT = 50;

const INVEST_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const isInvestPath = (path: string) =>
  path === '/vault/invest' || path.startsWith('/vault/invest/') || path.startsWith('/vault/api/invest/');

export const isInvestOwner = (user: User, env: Env) => emailList(env.INVEST_EMAILS).includes(user.email);

export async function handleInvest(request: Request, env: Env, url: URL, user: User): Promise<Response> {
  const path = url.pathname;
  if (!isInvestOwner(user, env)) return error(404, 'Not found');

  if (path === '/vault/api/invest/market' || path.startsWith('/vault/api/invest/market/')) {
    return handleMarketApi(request, env, path.slice('/vault/api/invest/market'.length).replace(/^\//, ''));
  }
  if (path === '/vault/api/invest/alerts' || path.startsWith('/vault/api/invest/alerts/')) {
    return handleAlertsApi(request, env, path.slice('/vault/api/invest/alerts'.length).replace(/^\//, ''), url.origin);
  }
  if (path.startsWith('/vault/api/invest/')) return handleApi(request, env, path.slice('/vault/api/invest/'.length));

  if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'Method not allowed');
  return servePage(request, env);
}

/** Serve a built page from static assets, with private headers instead of the public site's. */
async function servePage(request: Request, env: Env) {
  const res = await env.ASSETS.fetch(request);
  const headers = new Headers(baseHeaders);
  for (const h of ['Content-Type', 'Content-Length', 'ETag', 'Last-Modified', 'Location']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Content-Security-Policy', INVEST_CSP);
  return new Response(res.body, { status: res.status, headers });
}

async function handleApi(request: Request, env: Env, name: string) {
  if (!isDocName(name)) return error(404, 'Not found');
  const key = `${INVEST_PREFIX}${name}.json`;

  if (request.method === 'GET') {
    const obj = await env.VAULT.get(key);
    if (!obj) return withEtag(json({ exists: false, doc: emptyDoc(name) }), null);
    return withEtag(json({ exists: true, doc: JSON.parse(await obj.text()), saved: obj.uploaded.toISOString() }), obj.httpEtag);
  }

  if (request.method === 'PUT') {
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) return error(415, 'JSON expected');
    const ifMatch = request.headers.get('If-Match');
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (!ifMatch && ifNoneMatch !== '*') return error(428, 'If-Match or If-None-Match: * required');

    const length = Number(request.headers.get('Content-Length') || NaN);
    if (Number.isFinite(length) && length > MAX_DOC_BYTES) return error(413, 'Document too large');
    const text = await request.text();
    if (text.length > MAX_DOC_BYTES) return error(413, 'Document too large');

    let doc: unknown;
    try { doc = JSON.parse(text); } catch { return error(400, 'Invalid JSON'); }
    const problems = validateDoc(name, doc);
    if (problems.length) return json({ error: 'Invalid document', problems }, 422);

    // Optimistic concurrency: the client must prove it saw the current version
    const current = await env.VAULT.head(key);
    if (current && ifMatch !== current.httpEtag) return conflict();
    if (!current && ifMatch) return conflict();

    const body = JSON.stringify(doc);
    const put = await env.VAULT.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
      ...(current ? { onlyIf: { etagMatches: current.etag } } : {}),
    });
    if (!put) return conflict();

    await backup(env, name, body);
    return withEtag(json({ ok: true, saved: put.uploaded.toISOString() }), put.httpEtag);
  }

  return error(405, 'Method not allowed');
}

const conflict = () => error(412, 'The document changed since you loaded it — reload and try again');

function withEtag(res: Response, etag: string | null) {
  if (etag) res.headers.set('ETag', etag);
  return res;
}

/** Keep a copy of every save; prune to the newest BACKUPS_KEPT per document. */
async function backup(env: Env, name: string, body: string) {
  const prefix = `${INVEST_PREFIX}backups/${name}/`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await env.VAULT.put(`${prefix}${stamp}.json`, body, { httpMetadata: { contentType: 'application/json' } });

  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VAULT.list({ prefix, cursor });
    keys.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (keys.length > BACKUPS_KEPT) {
    keys.sort(); // ISO timestamps sort chronologically
    await env.VAULT.delete(keys.slice(0, keys.length - BACKUPS_KEPT));
  }
}
