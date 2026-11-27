// Client for /vault/api/invest/<doc>. Optimistic concurrency: every save sends the ETag it loaded.
import type { DocName, InvestData, TaxRules, IpsDoc, YearSnapshot } from '../../lib/invest/types';
import type { FxYear, PricesYear } from '../../lib/invest/market';

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

// ─── Market data (Phase 3 store) ───

async function getYear<T>(kind: 'fx' | 'prices', year: number): Promise<T | null> {
  const res = await fetch(`/vault/api/invest/market/${kind}/${year}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) return fail(res);
  const body = (await res.json()) as T & { missing?: boolean };
  return body.missing ? null : body;
}

/** BNR rates and price documents for the given years (missing years are skipped). */
export async function loadMarket(years: number[]): Promise<{ fx: FxYear[]; prices: PricesYear[] }> {
  const [fx, prices] = await Promise.all([
    Promise.all(years.map(y => getYear<FxYear>('fx', y))),
    Promise.all(years.map(y => getYear<PricesYear>('prices', y))),
  ]);
  return { fx: fx.filter((d): d is FxYear => !!d), prices: prices.filter((d): d is PricesYear => !!d) };
}

/** Sets (close > 0) or removes (close = null) a manual price in the price store. */
export async function setManualPrice(body: { instrumentId: string; date: string; close: number | null; currency: string }) {
  const res = await fetch('/vault/api/invest/market/override', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) return fail(res);
}

// ─── Year-end snapshots (Phase 7) ───

export interface SnapshotList { snapshots: YearSnapshot[]; etags: Record<string, string> }

export async function loadSnapshots(): Promise<SnapshotList> {
  const res = await fetch('/vault/api/invest/snapshots', { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) return fail(res);
  return (await res.json()) as SnapshotList;
}

/** Creates (etag null) or replaces a snapshot; returns the new ETag. */
export async function saveSnapshot(doc: YearSnapshot, etag: string | null): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (etag) headers['If-Match'] = etag; else headers['If-None-Match'] = '*';
  const res = await fetch(`/vault/api/invest/snapshots/${doc.year}`, { method: 'PUT', headers, body: JSON.stringify(doc) });
  if (!res.ok) return fail(res);
  return res.headers.get('ETag');
}

// ─── Read-only, once per page load (the dashboard cards share these instead of fetching the same files) ───

const docOnce = new Map<DocName, Promise<Loaded<DocName>>>();
/** Same as loadDoc, but every caller on the page shares one request. Don't use it for documents you save. */
export function loadDocOnce<N extends DocName>(name: N): Promise<Loaded<N>> {
  if (!docOnce.has(name)) docOnce.set(name, loadDoc(name));
  return docOnce.get(name) as Promise<Loaded<N>>;
}

const fxOnce = new Map<number, Promise<FxYear | null>>();
const pricesOnce = new Map<number, Promise<PricesYear | null>>();
/** Same as loadMarket, shared per year across the page; a failed year counts as missing. */
export async function loadMarketOnce(years: number[]): Promise<{ fx: FxYear[]; prices: PricesYear[] }> {
  for (const y of years) {
    if (!fxOnce.has(y)) fxOnce.set(y, getYear<FxYear>('fx', y).catch(() => null));
    if (!pricesOnce.has(y)) pricesOnce.set(y, getYear<PricesYear>('prices', y).catch(() => null));
  }
  const [fx, prices] = await Promise.all([
    Promise.all(years.map(y => fxOnce.get(y)!)),
    Promise.all(years.map(y => pricesOnce.get(y)!)),
  ]);
  return { fx: fx.filter((d): d is FxYear => !!d), prices: prices.filter((d): d is PricesYear => !!d) };
}

let summaryOnce: Promise<unknown> | null = null;
/** GET /vault/api/invest/market (dashboard summary), shared by the cards on the page. `fresh` refetches. */
export function loadMarketSummary<T>(fresh = false): Promise<T> {
  if (fresh || !summaryOnce) {
    summaryOnce = fetch('/vault/api/invest/market', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(res => (res.ok ? res.json() : fail(res)));
  }
  return summaryOnce as Promise<T>;
}
