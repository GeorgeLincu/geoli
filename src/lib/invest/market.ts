// Market data for the investment section (Phase 3): BNR exchange rates and daily closing prices.
// Pure functions only (no fetch, no R2) so they run in the Worker, in the browser and in vitest.
//
// Stored in R2 (written by the Worker's cron job, see worker/market.ts):
//   invest/fx/<year>.json      FxYear      — BNR reference rates, RON per 1 unit of currency
//   invest/prices/<year>.json  PricesYear  — daily closes per instrument id (source "yahoo" or "manual")
//   invest/market-status.json  MarketStatus — last run, per-instrument result
import { CURRENCIES, type Currency } from './types';

export const MARKET_VERSION = 1;

/** RON per 1 unit of the currency (BNR "multiplier" already applied). RON itself is never stored. */
export type FxRates = Partial<Record<Currency, number>>;

export interface FxYear {
  version: typeof MARKET_VERSION;
  year: number;
  source: 'BNR';
  /** date (YYYY-MM-DD, BNR publication date) → rates */
  rates: Record<string, FxRates>;
  /** true once the year was filled from BNR's yearly file (history before the 10-day window) */
  backfilled?: boolean;
  /** true once a past year was filled from BNR's yearly file (nothing more to fetch) */
  complete?: boolean;
  updated: string;
}

export type PriceSourceKind = 'yahoo' | 'manual';

export interface PricePoint {
  close: number;
  currency: Currency;
  source: PriceSourceKind;
}

export interface PricesYear {
  version: typeof MARKET_VERSION;
  year: number;
  /** instrument id → date → close */
  prices: Record<string, Record<string, PricePoint>>;
  updated: string;
}

export interface InstrumentStatus {
  /** Symbol sent to the price source (ticker only) */
  symbol?: string;
  ok: boolean;
  message?: string;
  /** Latest date received in this run */
  lastDate?: string;
  checkedAt: string;
}

export interface MarketStatus {
  version: typeof MARKET_VERSION;
  lastRun?: string;
  lastTrigger?: 'cron' | 'manual';
  /** Last "Actualizează acum" (rate limit) */
  lastManualRun?: string;
  fx: { ok: boolean; message?: string; latestDate?: string; checkedAt?: string };
  instruments: Record<string, InstrumentStatus>;
  /** Years filled from BNR yearly files in the last run */
  backfilled: number[];
}

export const emptyStatus = (): MarketStatus => ({ version: MARKET_VERSION, fx: { ok: false }, instruments: {}, backfilled: [] });
export const emptyFxYear = (year: number, now = new Date().toISOString()): FxYear =>
  ({ version: MARKET_VERSION, year, source: 'BNR', rates: {}, updated: now });
export const emptyPricesYear = (year: number, now = new Date().toISOString()): PricesYear =>
  ({ version: MARKET_VERSION, year, prices: {}, updated: now });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: unknown): s is string =>
  typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const yearOf = (date: string) => Number(date.slice(0, 4));

// ───────────────────────── BNR ─────────────────────────

/** Currencies we keep from BNR (everything in types.ts except RON). */
export const FX_CURRENCIES = CURRENCIES.filter((c): c is Exclude<Currency, 'RON'> => c !== 'RON');

export const BNR_DAILY_URL = 'https://curs.bnr.ro/nbrfxrates10days.xml';
export const bnrYearUrl = (year: number) => `https://curs.bnr.ro/files/xml/years/nbrfxrates${year}.xml`;

export interface FxDay { date: string; rates: FxRates }

/**
 * Parses any BNR reference-rate XML (daily, 10 days or yearly file).
 * Each <Cube date="…"> holds <Rate currency="EUR" [multiplier="100"]>5.0000</Rate>.
 */
export function parseBnrXml(xml: string): FxDay[] {
  if (!/<DataSet[\s>]/.test(xml)) throw new Error('BNR: response is not a rates XML');
  const days: FxDay[] = [];
  const cubeRe = /<Cube\s+date="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Rate\s+currency="([A-Z]{3})"(?:\s+multiplier="(\d+)")?\s*>\s*([0-9.]+)\s*<\/Rate>/g;
  for (const cube of xml.matchAll(cubeRe)) {
    const rates: FxRates = {};
    for (const r of cube[2].matchAll(rateRe)) {
      const cur = r[1] as Currency;
      if (!(FX_CURRENCIES as readonly string[]).includes(cur)) continue;
      const value = Number(r[3]) / (r[2] ? Number(r[2]) : 1);
      if (Number.isFinite(value) && value > 0) rates[cur] = value;
    }
    if (Object.keys(rates).length) days.push({ date: cube[1], rates });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** Merges parsed days into the per-year documents. Returns only the years that changed. */
export function mergeFxDays(docs: Map<number, FxYear>, days: FxDay[], now = new Date().toISOString()): number[] {
  const changed = new Set<number>();
  for (const d of days) {
    const y = yearOf(d.date);
    let doc = docs.get(y);
    if (!doc) { doc = emptyFxYear(y, now); docs.set(y, doc); }
    const old = doc.rates[d.date];
    if (!old || JSON.stringify(old) !== JSON.stringify(d.rates)) {
      doc.rates[d.date] = d.rates;
      doc.updated = now;
      changed.add(y);
    }
  }
  return [...changed].sort();
}

export interface RateFound { rate: number; date: string }

/**
 * RON per 1 unit of `currency` on `date`: BNR's rate for that day, or the last one published before it
 * (weekends and holidays use the previous business day's rate). Looks back at most `maxDays` days.
 */
export function rateOn(fx: FxYear[] | Map<number, FxYear>, date: string, currency: Currency, maxDays = 10): RateFound | null {
  if (currency === 'RON') return { rate: 1, date };
  const byYear = fx instanceof Map ? fx : new Map(fx.map(d => [d.year, d]));
  const t = Date.parse(`${date}T00:00:00Z`);
  for (let i = 0; i <= maxDays; i++) {
    const day = new Date(t - i * 86_400_000).toISOString().slice(0, 10);
    const rate = byYear.get(yearOf(day))?.rates[day]?.[currency];
    if (rate) return { rate, date: day };
  }
  return null;
}

/** Converts between any two currencies through RON with BNR rates. null when a rate is missing. */
export function convert(amount: number, from: Currency, to: Currency, date: string, fx: FxYear[] | Map<number, FxYear>): number | null {
  if (from === to) return amount;
  const a = rateOn(fx, date, from);
  const b = rateOn(fx, date, to);
  if (!a || !b) return null;
  return (amount * a.rate) / b.rate;
}

/** Latest date with rates across the given years. */
export function latestFx(fx: FxYear[]): FxDay | null {
  let best: FxDay | null = null;
  for (const doc of fx) for (const [date, rates] of Object.entries(doc.rates)) if (!best || date > best.date) best = { date, rates };
  return best;
}

// ───────────────────────── Price sources ─────────────────────────

/**
 * Instrument.priceSource format: "<exchange>:<ticker>".
 *   xetra:VWCE → VWCE.DE   lse:VWRA → VWRA.L   us:AAPL → AAPL   bvb:TLV → TLV.RO
 *   ams:IWDA → IWDA.AS     mil:… → .MI   par:… → .PA   swx:… → .SW
 *   yahoo:<symbol> → symbol as is (any other Yahoo listing)
 *   manual (or empty) → no automatic price; enter prices by hand.
 */
export const EXCHANGES: Record<string, { label: string; suffix: string }> = {
  xetra: { label: 'Xetra (Frankfurt)', suffix: '.DE' },
  lse: { label: 'London Stock Exchange', suffix: '.L' },
  us: { label: 'NYSE / Nasdaq', suffix: '' },
  bvb: { label: 'Bursa de Valori București', suffix: '.RO' },
  ams: { label: 'Euronext Amsterdam', suffix: '.AS' },
  mil: { label: 'Borsa Italiana (Milano)', suffix: '.MI' },
  par: { label: 'Euronext Paris', suffix: '.PA' },
  swx: { label: 'SIX Swiss Exchange', suffix: '.SW' },
  yahoo: { label: 'Simbol Yahoo (exact)', suffix: '' },
};

export interface ParsedSource { exchange: string; ticker: string; symbol: string }

const TICKER = /^[A-Z0-9][A-Z0-9.\-^=]{0,19}$/;

export function parsePriceSource(src: string | undefined): ParsedSource | null {
  if (!src) return null;
  const m = /^([a-z]+):(.+)$/.exec(src.trim());
  if (!m) return null;
  const exchange = m[1];
  const ticker = m[2].trim().toUpperCase();
  const ex = EXCHANGES[exchange];
  if (!ex || !TICKER.test(ticker)) return null;
  return { exchange, ticker, symbol: ticker + ex.suffix };
}

export const yahooChartUrl = (symbol: string, period1: number, period2: number, host = 'query1') =>
  `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=`;

export interface PriceSeries { symbol: string; currency: Currency; points: { date: string; close: number }[] }

/**
 * Parses Yahoo's v8 chart JSON (daily interval). Dates are the exchange's local date.
 * London prices quoted in pence (GBp) are converted to pounds.
 */
export function parseYahooChart(body: unknown): PriceSeries {
  const chart = (body as { chart?: { result?: unknown[] | null; error?: { description?: string } | null } })?.chart;
  if (!chart) throw new Error('Yahoo: unexpected response');
  if (chart.error || !chart.result?.length) throw new Error(`Yahoo: ${chart.error?.description || 'no data'}`);
  const r = chart.result[0] as {
    meta?: { currency?: string; symbol?: string; gmtoffset?: number };
    timestamp?: number[];
    indicators?: { quote?: { close?: (number | null)[] }[] };
  };
  const rawCur = r.meta?.currency || '';
  let factor = 1;
  let cur = rawCur;
  if (rawCur === 'GBp' || rawCur === 'GBX') { factor = 0.01; cur = 'GBP'; }
  if (!(CURRENCIES as readonly string[]).includes(cur)) throw new Error(`Yahoo: unsupported currency "${rawCur}"`);
  const offset = r.meta?.gmtoffset ?? 0;
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const byDate = new Map<string, number>();
  ts.forEach((t, i) => {
    const c = closes[i];
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) return;
    const date = new Date((t + offset) * 1000).toISOString().slice(0, 10);
    byDate.set(date, Math.round(c * factor * 10_000) / 10_000); // later bar of the same day wins
  });
  const points = [...byDate].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
  return { symbol: r.meta?.symbol || '', currency: cur as Currency, points };
}

// ───────────────────────── Price documents ─────────────────────────

/**
 * Merges automatic prices. Manual entries are never overwritten. Returns the years that changed.
 * Re-fetching recent days overwrites earlier automatic values (e.g. an intraday price with the final close).
 */
export function mergePrices(docs: Map<number, PricesYear>, instrumentId: string, series: PriceSeries, now = new Date().toISOString()): number[] {
  const changed = new Set<number>();
  for (const p of series.points) {
    const y = yearOf(p.date);
    let doc = docs.get(y);
    if (!doc) { doc = emptyPricesYear(y, now); docs.set(y, doc); }
    const days = (doc.prices[instrumentId] ??= {});
    const old = days[p.date];
    if (old?.source === 'manual') continue;
    if (old && old.close === p.close && old.currency === series.currency) continue;
    days[p.date] = { close: p.close, currency: series.currency, source: 'yahoo' };
    doc.updated = now;
    changed.add(y);
  }
  return [...changed].sort();
}

/** Sets (close > 0) or removes (close = null) a manual price. Removing leaves the date empty until the next run. */
export function setManualPrice(doc: PricesYear, instrumentId: string, date: string, close: number | null, currency: Currency, now = new Date().toISOString()) {
  const days = (doc.prices[instrumentId] ??= {});
  if (close === null) {
    if (days[date]?.source === 'manual') delete days[date];
    if (!Object.keys(days).length) delete doc.prices[instrumentId];
  } else {
    days[date] = { close, currency, source: 'manual' };
  }
  doc.updated = now;
}

export interface LatestPrice extends PricePoint { date: string }

/** Latest price on or before `onOrBefore` (default: any date) across the given years. */
export function latestPrice(docs: PricesYear[], instrumentId: string, onOrBefore?: string): LatestPrice | null {
  let best: LatestPrice | null = null;
  for (const doc of docs) {
    const days = doc.prices[instrumentId];
    if (!days) continue;
    for (const [date, p] of Object.entries(days)) {
      if (onOrBefore && date > onOrBefore) continue;
      if (!best || date > best.date) best = { date, ...p };
    }
  }
  return best;
}

/** Whole days between two ISO dates (b − a). */
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * A price is stale when it is older than `maxDays` calendar days (default 5: covers a weekend
 * plus a public holiday or two without false alarms).
 */
export const isStale = (priceDate: string, today: string, maxDays = 5) => daysBetween(priceDate, today) > maxDays;

/** Years that need BNR rates: every year with a transaction, plus the current one. */
export function fxYearsNeeded(transactionDates: string[], today: string): number[] {
  const current = yearOf(today);
  const years = new Set<number>([current]);
  for (const d of transactionDates) if (isIsoDate(d) && yearOf(d) <= current && yearOf(d) >= 2005) years.add(yearOf(d));
  return [...years].sort((a, b) => a - b);
}

// ───────────────────────── Validation of a manual price ─────────────────────────

export interface OverrideInput { instrumentId: string; date: string; close: number | null; currency: Currency }

/** Validates the body of POST /vault/api/invest/market/override. Returns problems (empty = ok). */
export function validateOverride(v: unknown, today: string): string[] {
  const e: string[] = [];
  const o = v as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return ['object expected'];
  if (typeof o.instrumentId !== 'string' || !o.instrumentId || o.instrumentId.length > 64) e.push('instrumentId: required');
  if (!isIsoDate(o.date)) e.push('date: YYYY-MM-DD expected');
  else if (o.date > today) e.push('date: cannot be in the future');
  else if (yearOf(o.date) < 2000) e.push('date: too old');
  if (o.close !== null && (typeof o.close !== 'number' || !Number.isFinite(o.close) || o.close <= 0 || o.close > 1e9)) e.push('close: positive number or null');
  if (typeof o.currency !== 'string' || !(CURRENCIES as readonly string[]).includes(o.currency)) e.push(`currency: one of ${CURRENCIES.join(', ')}`);
  for (const k of Object.keys(o)) if (!['instrumentId', 'date', 'close', 'currency'].includes(k)) e.push(`${k}: unknown field`);
  return e;
}
