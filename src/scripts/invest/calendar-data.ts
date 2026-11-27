// Loads what the income calendar needs (data.json, tax-rules.json, BNR rates) — shared by the
// Calendar page and the dashboard card.
import { loadDoc, loadMarket, loadDocOnce, loadMarketOnce, type Loaded } from './api';
import { manualFx, chainFx, convert, type FxSource } from '../../lib/invest/fx';
import { bnrFx, marketYears } from '../../lib/invest/market-sources';
import type { Currency, TaxRules } from '../../lib/invest/types';
import type { Converter } from '../../lib/invest/calendar';

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface CalendarContext {
  data: Loaded<'data'>;
  rules: TaxRules | null;
  fx: FxSource;
  today: string;
}

/** `shared`: read-only callers (dashboard) reuse the page-wide requests instead of fetching again. */
export async function loadCalendarContext(shared = false): Promise<CalendarContext> {
  const today = todayIso();
  const get = shared ? loadDocOnce : loadDoc;
  const [data, rules] = await Promise.all([get('data'), get('tax-rules').catch(() => null)]);
  const years = marketYears(data.doc.transactions.map(t => t.date), today);
  const market = await (shared ? loadMarketOnce : loadMarket)(years).catch(() => ({ fx: [], prices: [] }));
  const fx = chainFx(bnrFx(market.fx), manualFx(data.doc.fxRates ?? []));
  return { data, rules: rules?.exists ? rules.doc : null, fx, today };
}

/** Converter to the display currency; future dates use today's rate (the latest known). */
export const converterFor = (fx: FxSource, to: Currency, today: string): Converter =>
  (amount, from, date) => convert(fx, amount, from, to, date > today ? today : date);
