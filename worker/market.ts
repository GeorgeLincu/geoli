// Automatic prices and exchange rates for /vault/invest/ (Phase 3).
//
//   cron (wrangler.jsonc triggers)              → runMarketUpdate(env, 'cron')
//   GET  /vault/api/invest/market               → summary for the dashboard (latest FX, latest price per instrument, status)
//   GET  /vault/api/invest/market/fx/<year>     → invest/fx/<year>.json
//   GET  /vault/api/invest/market/prices/<year> → invest/prices/<year>.json
//   POST /vault/api/invest/market/refresh       → "Actualizează acum" (owner only, at most once per REFRESH_COOLDOWN_MS)
//   POST /vault/api/invest/market/override      → set or remove a manual price {instrumentId, date, close|null, currency}
//
// Outbound requests carry only public identifiers (BNR file names, exchange tickers) and a generic User-Agent.
// Nothing personal (no quantities, no account data, no e-mail) ever leaves the Worker.
import type { Env } from './index';
import { error, json } from './http';
import type { InvestData } from '../src/lib/invest/types';
import {
  MARKET_VERSION, BNR_DAILY_URL, bnrYearUrl, parseBnrXml, mergeFxDays, latestFx, emptyStatus,
  parsePriceSource, yahooChartUrl, parseYahooChart, mergePrices, setManualPrice, latestPrice, emptyPricesYear,
  isStale, fxYearsNeeded, validateOverride, isIsoDate,
  type FxYear, type PricesYear, type MarketStatus, type OverrideInput,
} from '../src/lib/invest/market';

// Same prefix as INVEST_PREFIX in invest.ts (not imported, to avoid a circular import)
const INVEST_PREFIX = 'invest/';
const FX_KEY = (y: number) => `${INVEST_PREFIX}fx/${y}.json`;
const PRICES_KEY = (y: number) => `${INVEST_PREFIX}prices/${y}.json`;
const STATUS_KEY = `${INVEST_PREFIX}market-status.json`;
const DATA_KEY = `${INVEST_PREFIX}data.json`;

export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** Free plan: 50 subrequests per invocation. 1 BNR + backfills + one per instrument (+1 retry host each). */
const MAX_INSTRUMENTS = 20;
const MAX_BACKFILL_YEARS_PER_RUN = 2;
/** Days re-fetched on every run for instruments that already have prices. */
const RECENT_DAYS = 14;
const FETCH_TIMEOUT_MS = 15_000;
/** Generic UA: Yahoo rejects requests without one; nothing that identifies the site or the owner. */
const UA = 'Mozilla/5.0';

const today = () => new Date().toISOString().slice(0, 10);

// ───────────── R2 helpers ─────────────

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.VAULT.get(key);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()) as T; } catch { return null; }
}
const putJson = (env: Env, key: string, value: unknown) =>
  env.VAULT.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

async function loadYears<T extends { year: number }>(env: Env, keyFn: (y: number) => string, years: number[]) {
  const map = new Map<number, T>();
  await Promise.all(years.map(async y => { const d = await getJson<T>(env, keyFn(y)); if (d) map.set(y, d); }));
  return map;
}

async function fetchWithTimeout(url: string, accept: string) {
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'manual', // BNR answers moved files with a redirect to its home page: treat that as an error
  });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// ───────────── Update job ─────────────

export interface UpdateResult { status: MarketStatus; fxYearsWritten: number[]; priceYearsWritten: number[] }

export async function runMarketUpdate(env: Env, trigger: 'cron' | 'manual'): Promise<UpdateResult> {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const currentYear = Number(day.slice(0, 4));
  const data = await getJson<InvestData>(env, DATA_KEY);
  const instruments = data?.instruments ?? [];
  const transactions = data?.transactions ?? [];
  const prev = (await getJson<MarketStatus>(env, STATUS_KEY)) ?? emptyStatus();
  const status: MarketStatus = { ...emptyStatus(), lastManualRun: prev.lastManualRun, lastRun: now, lastTrigger: trigger };
  if (trigger === 'manual') status.lastManualRun = now;

  // ── FX: last 10 BNR days, plus yearly files for years with transactions that are missing ──
  const fxYears = fxYearsNeeded(transactions.map(t => t.date), day);
  const fxDocs = await loadYears<FxYear>(env, FX_KEY, [...new Set([...fxYears, currentYear - 1])]);
  const fxChanged = new Set<number>();
  try {
    const res = await fetchWithTimeout(BNR_DAILY_URL, 'application/xml');
    if (!res.ok) throw new Error(`BNR: HTTP ${res.status}`);
    for (const y of mergeFxDays(fxDocs, parseBnrXml(await res.text()), now)) fxChanged.add(y);
    status.fx = { ok: true, checkedAt: now };
  } catch (e) {
    status.fx = { ok: false, message: errMsg(e), checkedAt: now };
  }
  // A year needs BNR's yearly file once (history before the 10-day window); past years until marked complete.
  const toBackfill = fxYears.filter(y => {
    const doc = fxDocs.get(y);
    return !doc?.backfilled || (y < currentYear && !doc.complete);
  }).slice(0, MAX_BACKFILL_YEARS_PER_RUN);
  for (const y of toBackfill) {
    try {
      const res = await fetchWithTimeout(bnrYearUrl(y), 'application/xml');
      if (!res.ok) throw new Error(`BNR ${y}: HTTP ${res.status}`);
      const days = parseBnrXml(await res.text());
      if (!days.length) throw new Error(`BNR ${y}: empty file`);
      for (const c of mergeFxDays(fxDocs, days, now)) fxChanged.add(c);
      const doc = fxDocs.get(y);
      if (doc) { doc.backfilled = true; if (y < currentYear) doc.complete = true; fxChanged.add(y); }
      status.backfilled.push(y);
    } catch (e) {
      status.fx = { ...status.fx, ok: false, message: errMsg(e) };
    }
  }
  status.fx.latestDate = latestFx([...fxDocs.values()])?.date;
  await Promise.all([...fxChanged].map(y => putJson(env, FX_KEY(y), fxDocs.get(y))));

  // ── Prices ──
  const priceDocs = await loadYears<PricesYear>(env, PRICES_KEY, [currentYear - 1, currentYear]);
  const priceChanged = new Set<number>();
  const firstTx = new Map<string, string>();
  for (const t of transactions) {
    if (!t.instrumentId || !isIsoDate(t.date)) continue;
    const f = firstTx.get(t.instrumentId);
    if (!f || t.date < f) firstTx.set(t.instrumentId, t.date);
  }
  // History older than last year is loaded lazily, only for instruments that need it.
  const fetchable = instruments.filter(i => parsePriceSource(i.priceSource)).slice(0, MAX_INSTRUMENTS);
  for (const inst of instruments) {
    if (!parsePriceSource(inst.priceSource)) {
      status.instruments[inst.id] = { ok: false, message: inst.priceSource ? 'Sursă de preț invalidă' : 'Fără sursă automată (preț manual)', checkedAt: now };
    }
  }
  for (const inst of instruments.filter(i => parsePriceSource(i.priceSource)).slice(MAX_INSTRUMENTS)) {
    status.instruments[inst.id] = { ok: false, message: `Peste limita de ${MAX_INSTRUMENTS} instrumente pe rulare`, checkedAt: now };
  }

  const period2 = Math.floor(Date.now() / 1000);
  for (const inst of fetchable) {
    const src = parsePriceSource(inst.priceSource)!;
    const hasRecent = !!latestPrice([...priceDocs.values()], inst.id);
    const start = hasRecent
      ? new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10)
      : (firstTx.get(inst.id) ?? `${currentYear}-01-01`);
    const period1 = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000) - 7 * 86_400; // a week before: the close before the first buy
    try {
      const series = await fetchYahoo(src.symbol, period1, period2);
      // Prices are stored in the listing's currency; a different instrument currency is allowed but flagged.
      const note = series.currency !== inst.currency
        ? `Cotat în ${series.currency}, instrumentul e setat în ${inst.currency}`
        : undefined;
      // Load older year files this instrument's history touches
      const years = [...new Set(series.points.map(p => Number(p.date.slice(0, 4))))].filter(y => !priceDocs.has(y));
      for (const [y, d] of await loadYears<PricesYear>(env, PRICES_KEY, years)) priceDocs.set(y, d);
      for (const y of mergePrices(priceDocs, inst.id, series, now)) priceChanged.add(y);
      status.instruments[inst.id] = { symbol: src.symbol, ok: true, message: note, lastDate: series.points.at(-1)?.date, checkedAt: now };
    } catch (e) {
      status.instruments[inst.id] = { symbol: src.symbol, ok: false, message: errMsg(e), checkedAt: now };
    }
  }
  await Promise.all([...priceChanged].map(y => putJson(env, PRICES_KEY(y), priceDocs.get(y))));
  await putJson(env, STATUS_KEY, status);

  return { status, fxYearsWritten: [...fxChanged].sort(), priceYearsWritten: [...priceChanged].sort() };
}

/** Yahoo's public chart endpoint; on 429/5xx tries the second host once. */
async function fetchYahoo(symbol: string, period1: number, period2: number) {
  let lastErr = '';
  for (const host of ['query1', 'query2']) {
    const res = await fetchWithTimeout(yahooChartUrl(symbol, period1, period2, host), 'application/json');
    if (res.ok || res.status === 404) {
      const body = await res.json().catch(() => null);
      return parseYahooChart(body); // 404 bodies carry Yahoo's "No data found" message
    }
    lastErr = `Yahoo: HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(lastErr);
}

// ───────────── API ─────────────

export async function handleMarketApi(request: Request, env: Env, sub: string): Promise<Response> {
  const method = request.method;

  if (sub === '' && method === 'GET') return summary(env);

  const m = /^(fx|prices)\/(\d{4})$/.exec(sub);
  if (m && method === 'GET') {
    const y = Number(m[2]);
    const doc = await getJson(env, m[1] === 'fx' ? FX_KEY(y) : PRICES_KEY(y));
    return json(doc ?? { version: MARKET_VERSION, year: y, missing: true });
  }

  if (sub === 'refresh' && method === 'POST') {
    const st = await getJson<MarketStatus>(env, STATUS_KEY);
    const last = st?.lastManualRun ? Date.parse(st.lastManualRun) : 0;
    const wait = last + REFRESH_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      const res = json({ error: 'Prea des — încearcă din nou peste câteva minute.', retryAfter: Math.ceil(wait / 1000) }, 429);
      res.headers.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res;
    }
    // Claim the slot first so parallel clicks don't both run
    await putJson(env, STATUS_KEY, { ...(st ?? emptyStatus()), lastManualRun: new Date().toISOString() });
    const r = await runMarketUpdate(env, 'manual');
    return json({ ok: true, status: r.status, fxYearsWritten: r.fxYearsWritten, priceYearsWritten: r.priceYearsWritten });
  }

  if (sub === 'override' && method === 'POST') {
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) return error(415, 'JSON expected');
    const text = await request.text();
    if (text.length > 2000) return error(413, 'Too large');
    let body: unknown;
    try { body = JSON.parse(text); } catch { return error(400, 'Invalid JSON'); }
    const problems = validateOverride(body, today());
    if (problems.length) return json({ error: 'Invalid price', problems }, 422);
    const o = body as OverrideInput;
    const data = await getJson<InvestData>(env, DATA_KEY);
    const inst = data?.instruments.find(i => i.id === o.instrumentId);
    if (!inst) return json({ error: 'Invalid price', problems: ['instrumentId: unknown instrument'] }, 422);

    const y = Number(o.date.slice(0, 4));
    // Read-modify-write guarded by the ETag so a concurrent cron run isn't lost
    for (let attempt = 0; attempt < 3; attempt++) {
      const obj = await env.VAULT.get(PRICES_KEY(y));
      const doc: PricesYear = obj ? JSON.parse(await obj.text()) : emptyPricesYear(y);
      setManualPrice(doc, o.instrumentId, o.date, o.close, o.currency);
      const put = await env.VAULT.put(PRICES_KEY(y), JSON.stringify(doc), {
        httpMetadata: { contentType: 'application/json' },
        ...(obj ? { onlyIf: { etagMatches: obj.etag } } : {}),
      });
      if (put) return json({ ok: true, price: doc.prices[o.instrumentId]?.[o.date] ?? null });
    }
    return error(409, 'Prețurile se actualizau chiar acum — încearcă din nou.');
  }

  return error(404, 'Not found');
}

/** What the dashboard needs: latest BNR rates, the latest price per instrument with a staleness flag, run status. */
async function summary(env: Env) {
  const day = today();
  const y = Number(day.slice(0, 4));
  const [data, status, fx, prices] = await Promise.all([
    getJson<InvestData>(env, DATA_KEY),
    getJson<MarketStatus>(env, STATUS_KEY),
    loadYears<FxYear>(env, FX_KEY, [y - 1, y]),
    loadYears<PricesYear>(env, PRICES_KEY, [y - 1, y]),
  ]);
  const docs = [...prices.values()];
  const instruments = (data?.instruments ?? []).map(i => {
    const p = latestPrice(docs, i.id);
    return {
      id: i.id, name: i.name, ticker: i.ticker ?? null, currency: i.currency, priceSource: i.priceSource ?? null,
      latest: p, stale: p ? isStale(p.date, day) : true,
      status: status?.instruments[i.id] ?? null,
    };
  });
  return json({
    today: day,
    status: status ?? null,
    refreshCooldownMs: REFRESH_COOLDOWN_MS,
    fx: latestFx([...fx.values()]),
    instruments,
  });
}
