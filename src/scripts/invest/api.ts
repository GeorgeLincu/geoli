// Client for /vault/api/invest/<doc>. Optimistic concurrency: every save sends the ETag it loaded.
import type { DocName, InvestData, TaxRules, IpsDoc } from '../../lib/invest/types';

type DocMap = { data: InvestData; 'tax-rules': TaxRules; ips: IpsDoc };

export interface Loaded<N extends DocName> {
  doc: DocMap[N];
  exists: boolean;
  etag: string | null;
  saved?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) { super(message); }
}

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  const msg = res.status === 412
    ? 'Datele s-au schimbat între timp (alt tab sau alt dispozitiv). Reîncarcă pagina.'
    : res.status === 422 ? 'Date invalide: ' + (body.problems || []).slice(0, 3).join('; ')
    : res.status === 401 || res.status === 404 ? 'Sesiunea a expirat sau nu ai acces. Reîncarcă pagina.'
    : body.error || `Eroare ${res.status}`;
  throw new ApiError(res.status, msg, body.problems);
}

export async function loadDoc<N extends DocName>(name: N): Promise<Loaded<N>> {
  const res = await fetch(`/vault/api/invest/${name}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) return fail(res);
  const body = (await res.json()) as { exists: boolean; doc: DocMap[N]; saved?: string };
  return { ...body, etag: res.headers.get('ETag') };
}

/** Saves and returns the new state. Throws ApiError (412 = saved elsewhere in the meantime). */
export async function saveDoc<N extends DocName>(name: N, loaded: Loaded<N>, doc: DocMap[N]): Promise<Loaded<N>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (loaded.exists && loaded.etag) headers['If-Match'] = loaded.etag;
  else headers['If-None-Match'] = '*';
  const res = await fetch(`/vault/api/invest/${name}`, { method: 'PUT', headers, body: JSON.stringify(doc) });
  if (!res.ok) return fail(res);
  const body = (await res.json()) as { saved: string };
  return { doc, exists: true, etag: res.headers.get('ETag'), saved: body.saved };
}
