// Year-end snapshots for the yearly reports (owner only; routed from invest.ts).
//
//   GET /vault/api/invest/snapshots          → { snapshots: YearSnapshot[], etags: { <year>: etag } }
//   GET /vault/api/invest/snapshots/<year>   → { exists, doc } + ETag
//   PUT /vault/api/invest/snapshots/<year>   → save (If-Match <etag> or If-None-Match: *), validated, backed up
//
// Files: invest/snapshots/<year>-12-31.json. The values are computed in the browser (same code as the report
// page) and saved here; the Worker only validates and stores them.
import type { Env } from './index';
import { error, json } from './http';
import { validateSnapshot, MAX_SNAPSHOT_BYTES } from '../src/lib/invest/validate';
import { snapshotKey, SNAPSHOT_PREFIX } from '../src/lib/invest/snapshots';
import type { YearSnapshot } from '../src/lib/invest/types';

const BACKUPS_KEPT = 20;

export async function handleSnapshotsApi(request: Request, env: Env, sub: string): Promise<Response> {
  const method = request.method;

  if (sub === '' && method === 'GET') {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.VAULT.list({ prefix: SNAPSHOT_PREFIX, cursor });
      keys.push(...page.objects.map(o => o.key).filter(k => /\/\d{4}-12-31\.json$/.test(k)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const snapshots: YearSnapshot[] = [];
    const etags: Record<string, string> = {};
    await Promise.all(keys.map(async k => {
      const obj = await env.VAULT.get(k);
      if (!obj) return;
      try {
        const doc = JSON.parse(await obj.text()) as YearSnapshot;
        snapshots.push(doc);
        etags[String(doc.year)] = obj.httpEtag;
      } catch { /* skip a broken file */ }
    }));
    snapshots.sort((a, b) => a.year - b.year);
    return json({ snapshots, etags });
  }

  const m = /^(\d{4})$/.exec(sub);
  if (!m) return error(404, 'Not found');
  const year = Number(m[1]);
  if (year < 1990 || year > 2200) return error(404, 'Not found');
  const key = snapshotKey(year);

  if (method === 'GET') {
    const obj = await env.VAULT.get(key);
    if (!obj) return json({ exists: false, doc: null });
    const res = json({ exists: true, doc: JSON.parse(await obj.text()) });
    res.headers.set('ETag', obj.httpEtag);
    return res;
  }

  if (method === 'PUT') {
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) return error(415, 'JSON expected');
    const ifMatch = request.headers.get('If-Match');
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (!ifMatch && ifNoneMatch !== '*') return error(428, 'If-Match or If-None-Match: * required');
    const text = await request.text();
    if (text.length > MAX_SNAPSHOT_BYTES) return error(413, 'Document too large');
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { return error(400, 'Invalid JSON'); }
    const problems = validateSnapshot(year, doc);
    if (problems.length) return json({ error: 'Invalid document', problems }, 422);

    const current = await env.VAULT.head(key);
    if (current && ifMatch !== current.httpEtag) return error(412, 'The snapshot changed since you loaded it — reload and try again');
    if (!current && ifMatch) return error(412, 'The snapshot changed since you loaded it — reload and try again');
    const body = JSON.stringify(doc);
    const put = await env.VAULT.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
      ...(current ? { onlyIf: { etagMatches: current.etag } } : {}),
    });
    if (!put) return error(412, 'The snapshot changed since you loaded it — reload and try again');
    await backup(env, year, body);
    const res = json({ ok: true, saved: put.uploaded.toISOString() });
    res.headers.set('ETag', put.httpEtag);
    return res;
  }

  return error(405, 'Method not allowed');
}

async function backup(env: Env, year: number, body: string) {
  const prefix = `invest/backups/snapshots/${year}/`;
  await env.VAULT.put(`${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}.json`, body, { httpMetadata: { contentType: 'application/json' } });
  const page = await env.VAULT.list({ prefix });
  const keys = page.objects.map(o => o.key).sort();
  if (keys.length > BACKUPS_KEPT) await env.VAULT.delete(keys.slice(0, keys.length - BACKUPS_KEPT));
}
