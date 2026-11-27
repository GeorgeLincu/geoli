// "Cât a scăzut de la maxim": highs, distance below them and drawdown history per instrument.
// Pure functions only (no fetch, no R2): used by the page (/vault/invest/oportunitati/) and by the
// Worker's alert job, and tested with vitest. All percentages are fractions (0.1 = 10 %).
//
// Long history lives in invest/history/<instrumentId>.json (HistoryDoc): weekly closes since the listing,
// fetched once per instrument. The same one-off fetch puts the last ~13 months of DAILY closes into the
// normal price store (invest/prices/<year>.json), which the cron then keeps current, so the 52-week high
// and recent highs are exact; highs older than that are weekly closes. mergeSeries() joins both.
import type { Currency } from './types';
import type { PricesYear } from './market';

export interface Point { date: string; close: number }

export const HISTORY_VERSION = 1;

/** invest/history/<instrumentId>.json — compact: [date, close] tuples, listing currency. */
export interface HistoryDoc {
  version: typeof HISTORY_VERSION;
  instrumentId: string;
  symbol: string;
  currency: Currency;
  fetchedAt: string;
  /** Weekly closes (Yahoo interval=1wk), whole listing history */
  weekly: [string, number][];
}

/** Small summary kept in invest/history/index.json so the cron never parses the big files. */
export interface HistoryIndexEntry {
  symbol: string;
  currency: Currency;
  fetchedAt: string;
  from: string;
  to: string;
  points: number;
  /** Highest close in the history file */
  ath: Point;
  ok: boolean;
  message?: string;
}
export interface HistoryIndex {
  version: typeof HISTORY_VERSION;
  instruments: Record<string, HistoryIndexEntry>;
  /** Last "Descarcă istoricul" click (rate limit) */
  lastManualRun?: string;
}
export const emptyHistoryIndex = (): HistoryIndex => ({ version: HISTORY_VERSION, instruments: {} });

const valid = (p: Point) => typeof p.close === 'number' && Number.isFinite(p.close) && p.close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.date);

/** Union of several series by date (later arguments win on the same date), sorted, invalid points dropped. */
export function mergeSeries(...series: readonly (readonly Point[])[]): Point[] {
  const byDate = new Map<string, number>();
  for (const s of series) for (const p of s) if (valid(p)) byDate.set(p.date, p.close);
  return [...byDate].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}

export const tuplesToPoints = (t: readonly (readonly [string, number])[] | undefined): Point[] =>
  (t ?? []).map(([date, close]) => ({ date, close }));
export const pointsToTuples = (p: readonly Point[]): [string, number][] => p.map(x => [x.date, x.close]);

/**
 * Full series for one instrument: weekly history up to the first daily price, then the daily price store.
 * (Weekly bars are dated at the start of their week, so mixing both in the same period would zig-zag.)
 */
export function seriesFor(instrumentId: string, history: HistoryDoc | null, priceDocs: readonly PricesYear[]): Point[] {
  const store: Point[] = [];
  for (const doc of priceDocs) {
    const days = doc.prices[instrumentId];
    if (days) for (const [date, p] of Object.entries(days)) store.push({ date, close: p.close });
  }
  const daily = mergeSeries(store);
  const firstDaily = daily[0]?.date ?? '9999';
  return mergeSeries(tuplesToPoints(history?.weekly).filter(p => p.date < firstDaily), daily);
}

/** Highest close in the series (earliest date on ties). */
export function highOf(points: readonly Point[]): Point | null {
  let best: Point | null = null;
  for (const p of points) if (!best || p.close > best.close) best = p;
  return best;
}

const minusDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Fraction below a high: 0 at the high, 0.25 = 25 % below. Never negative. */
export const belowHigh = (price: number, high: number) => (high > 0 ? Math.max(0, 1 - price / high) : 0);

export interface DrawdownEpisode {
  peak: Point;
  trough: Point;
  /** First date back at or above the peak; null while still under water */
  recovery: string | null;
  /** Depth as a fraction (0.34 = −34 %) */
  depth: number;
}

/** Underwater curve: for every point, the fraction below the running high so far (0 … 1). */
export function underwater(points: readonly Point[]): { date: string; dd: number }[] {
  let peak = 0;
  return points.map(p => {
    if (p.close > peak) peak = p.close;
    return { date: p.date, dd: belowHigh(p.close, peak) };
  });
}

/**
 * Drawdown episodes deeper than `minDepth` (peak → trough → recovery), deepest first.
 * An episode starts at a running high and ends when a close is back at or above it.
 */
export function drawdownEpisodes(points: readonly Point[], minDepth = 0.05): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  let peak: Point | null = null;
  let trough: Point | null = null;
  for (const p of points) {
    if (!peak || p.close >= peak.close) {
      if (peak && trough && trough.close < peak.close) {
        const depth = belowHigh(trough.close, peak.close);
        if (depth >= minDepth) out.push({ peak, trough, recovery: p.date, depth });
      }
      peak = p; trough = null;
      continue;
    }
    if (!trough || p.close < trough.close) trough = p;
  }
  if (peak && trough) {
    const depth = belowHigh(trough.close, peak.close);
    if (depth >= minDepth) out.push({ peak, trough, recovery: null, depth });
  }
  return out.sort((a, b) => b.depth - a.depth);
}

export interface DrawdownStats {
  last: Point;
  ath: Point;
  /** Highest close in the 52 weeks up to the last price */
  high52: Point;
  belowAth: number;
  below52: number;
  /** Deepest episode in the whole series */
  maxDrawdown: DrawdownEpisode | null;
  /** Calendar days since the all-time high (0 when at the high) */
  daysSinceAth: number;
  /** First and last date of the series */
  from: string;
  to: string;
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Everything the table needs for one instrument. null when the series is empty. */
export function drawdownStats(points: readonly Point[]): DrawdownStats | null {
  const s = mergeSeries(points);
  if (!s.length) return null;
  const last = s[s.length - 1];
  const ath = highOf(s)!;
  const cutoff = minusDays(last.date, 364);
  const high52 = highOf(s.filter(p => p.date >= cutoff))!;
  return {
    last, ath, high52,
    belowAth: belowHigh(last.close, ath.close),
    below52: belowHigh(last.close, high52.close),
    maxDrawdown: drawdownEpisodes(s, 0)[0] ?? null,
    daysSinceAth: daysBetween(ath.date, last.date),
    from: s[0].date, to: last.date,
  };
}

// ───────────── George's own levels ─────────────

/** One threshold: "X % below the high", optionally with the extra amount he planned to buy there. */
export interface DipLevel { pct: number; extraAmount?: number; currency?: Currency; note?: string }

/** Cleans a list of levels: fractions in (0, 1), unique, ascending. Accepts 10 or 0.10 for "10 %". */
export function normalizeLevels(levels: readonly unknown[] | undefined): DipLevel[] {
  const out = new Map<number, DipLevel>();
  for (const raw of levels ?? []) {
    const o = (typeof raw === 'number' ? { pct: raw } : raw) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    let pct = Number(o.pct ?? o.belowHighPct ?? o.percent);
    if (!Number.isFinite(pct)) continue;
    pct = Math.abs(pct);
    if (pct >= 1) pct /= 100;
    if (!(pct > 0 && pct < 1)) continue;
    pct = Math.round(pct * 10_000) / 10_000;
    const lvl: DipLevel = { pct };
    const amt = Number(o.extraAmount ?? o.extra ?? o.amount);
    if (Number.isFinite(amt) && amt > 0) lvl.extraAmount = amt;
    if (typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency)) lvl.currency = o.currency as Currency;
    if (typeof o.note === 'string' && o.note.trim()) lvl.note = o.note.trim().slice(0, 200);
    out.set(pct, lvl);
  }
  return [...out.values()].sort((a, b) => a.pct - b.pct);
}

/**
 * Reads dip-buy levels from invest/ips.json if the IPS page (Phase 6) stored any, in the latest version.
 * Tolerant: looks for `rules.dipBuys`, `rules.dipLevels`, `dipBuys` or `dipLevels`. Empty when absent.
 */
export function levelsFromIps(ips: unknown): DipLevel[] {
  const versions = (ips as { versions?: unknown[] } | null)?.versions;
  const latest = Array.isArray(versions) && versions.length
    ? [...versions].sort((a, b) => String((a as { date?: string }).date ?? '').localeCompare(String((b as { date?: string }).date ?? ''))).at(-1)
    : ips;
  const v = latest as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return [];
  const rules = (v.rules ?? {}) as Record<string, unknown>;
  const list = rules.dipBuys ?? rules.dipLevels ?? v.dipBuys ?? v.dipLevels;
  return Array.isArray(list) ? normalizeLevels(list) : [];
}

/** Deepest level reached by a fall of `below` (fraction), or 0 when none. */
export function deepestLevel(below: number, levels: readonly DipLevel[]): number {
  let hit = 0;
  for (const l of levels) if (below + 1e-9 >= l.pct) hit = Math.max(hit, l.pct);
  return hit;
}

/**
 * Alert state for one instrument. `prev` is the deepest level already announced.
 * A level is announced once when crossed; it re-arms only after the price recovers to `hysteresis`
 * above it (e.g. announced at −20 %, re-armed when back above −17.5 %), so a price hovering around a
 * level doesn't send an e-mail every day.
 */
export function nextAlertLevel(prev: number, below: number, levels: readonly DipLevel[], hysteresis = 0.025) {
  const reached = deepestLevel(below, levels);
  if (reached > prev) {
    const newly = levels.filter(l => l.pct > prev && l.pct <= reached).map(l => l.pct);
    return { level: reached, newly };
  }
  // Re-arm: drop announced levels the price has clearly recovered from
  let level = prev;
  while (level > 0 && below < level - hysteresis) {
    const lower = levels.filter(l => l.pct < level).map(l => l.pct);
    level = lower.length ? Math.max(...lower) : 0;
  }
  return { level, newly: [] as number[] };
}

/** Yahoo chart URL for the whole listing history in weekly closes (one-off per instrument). */
export const yahooWeeklyUrl = (symbol: string, period2: number, host = 'query1') =>
  `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${period2}&interval=1wk&events=`;

/** Days of DAILY closes the one-off history fetch adds to the price store (covers the 52-week window). */
export const HISTORY_DAILY_DAYS = 400;
