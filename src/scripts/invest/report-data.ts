// Loads everything the yearly reports need and keeps the year-end snapshots up to date.
// Shared by /vault/invest/rapoarte/ (list) and /vault/invest/rapoarte/<an>/ (one year).
import { loadDocOnce, loadMarketOnce, loadSnapshots, saveSnapshot, saveDoc, type SnapshotList, type Loaded } from './api';
import { manualFx, chainFx, type FxSource } from '../../lib/invest/fx';
import { manualPrices, chainPrices, type PriceSource } from '../../lib/invest/prices';
import { bnrFx, storePrices } from '../../lib/invest/market-sources';
import { netWorthAt, firstNetWorthDate } from '../../lib/invest/networth';
import { activeIpsRules } from '../../lib/invest/ips-checks';
import { buildHistory, portfolioAt, reportYears, yearEnd, type History } from '../../lib/invest/report';
import { buildSnapshot, missingSnapshotYears, snapshotOverrides } from '../../lib/invest/snapshots';
import type { InvestData, IpsDoc, TaxRules, YearSnapshot } from '../../lib/invest/types';
import type { FxYear } from '../../lib/invest/market';

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface ReportContext {
  today: string;
  data: InvestData;
  dataExists: boolean;
  /** As loaded (ETag), for saving data.json from the report pages */
  loaded: Loaded<'data'>;
  ips: IpsDoc | null;
  rules: TaxRules | null;
  fxDocs: FxYear[];
  fx: FxSource;
  prices: PriceSource;
  snaps: SnapshotList;
  history: History | null;
  years: number[];
  emergencyAccountIds: string[];
}

/** Every year from the first recorded date (transaction, Pillar value, net-worth entry) to today. */
function yearsSpan(data: InvestData, today: string): number[] {
  const first = firstNetWorthDate(data) ?? today;
  const out: number[] = [];
  for (let y = +first.slice(0, 4) - 1; y <= +today.slice(0, 4); y++) out.push(y);
  return out;
}

export async function loadReportContext(): Promise<ReportContext> {
  const today = todayIso();
  const [d, ipsDoc, rulesDoc, snaps] = await Promise.all([
    loadDocOnce('data'), loadDocOnce('ips').catch(() => null), loadDocOnce('tax-rules').catch(() => null), loadSnapshots(),
  ]);
  const data = d.doc;
  const market = await loadMarketOnce(yearsSpan(data, today));
  const fx = chainFx(bnrFx(market.fx), manualFx(data.fxRates ?? []));
  const prices = chainPrices(storePrices(market.prices, data.instruments, fx), manualPrices(data.prices ?? []));
  const ips = ipsDoc?.exists ? ipsDoc.doc : null;
  const ctx: ReportContext = {
    today, data, dataExists: d.exists, loaded: d, ips, rules: rulesDoc?.exists ? rulesDoc.doc : null,
    fxDocs: market.fx, fx, prices, snaps, history: null, years: [],
    emergencyAccountIds: activeIpsRules(ips)?.rules.emergencyFund?.accountIds ?? [],
  };
  rebuildHistory(ctx);
  return ctx;
}

/** Saves a changed copy of data.json (ETag); the context keeps the new state. */
export async function saveData(ctx: ReportContext, next: InvestData) {
  ctx.loaded = await saveDoc('data', ctx.loaded, next);
  ctx.data = next;
}

/** Recomputes the month-end history with the corrected snapshot values. */
export function rebuildHistory(ctx: ReportContext) {
  ctx.history = buildHistory(ctx.data, { fx: ctx.fx, prices: ctx.prices }, ctx.today, snapshotOverrides(ctx.snaps.snapshots));
  ctx.years = reportYears(ctx.history);
}

export const snapshotOf = (ctx: ReportContext, year: number): YearSnapshot | null =>
  ctx.snaps.snapshots.find(s => s.year === year) ?? null;

/** Computes (or recomputes) a year-end snapshot from the ledger + prices and saves it. */
export async function saveComputedSnapshot(ctx: ReportContext, year: number): Promise<YearSnapshot> {
  const date = yearEnd(year);
  const p = portfolioAt(ctx.data, { fx: ctx.fx, prices: ctx.prices }, date);
  const nw = netWorthAt(ctx.data, { fx: ctx.fx, prices: ctx.prices, emergencyAccountIds: ctx.emergencyAccountIds }, date);
  const prev = snapshotOf(ctx, year);
  const doc = buildSnapshot(year, p, nw, new Date().toISOString(), prev);
  return storeSnapshot(ctx, doc);
}

export async function storeSnapshot(ctx: ReportContext, doc: YearSnapshot): Promise<YearSnapshot> {
  const etag = await saveSnapshot(doc, ctx.snaps.etags[String(doc.year)] ?? null);
  if (etag) ctx.snaps.etags[String(doc.year)] = etag;
  ctx.snaps.snapshots = [...ctx.snaps.snapshots.filter(s => s.year !== doc.year), doc].sort((a, b) => a.year - b.year);
  return doc;
}

/** Saves the snapshot of every finished year that doesn't have one yet (automatic, oldest first). */
export async function ensureSnapshots(ctx: ReportContext): Promise<number[]> {
  const missing = missingSnapshotYears(ctx.years, ctx.snaps.snapshots, ctx.today);
  for (const y of missing) await saveComputedSnapshot(ctx, y);
  if (missing.length) rebuildHistory(ctx);
  return missing;
}
