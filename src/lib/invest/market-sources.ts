// Bridges the Phase 3 market documents (invest/fx/<year>.json, invest/prices/<year>.json) into the
// FxSource / PriceSource interfaces the ledger and the portfolio valuation use (Phase 2).
//
//   FX:     BNR rate (that day, or the last one published before it)  →  manual rate from data.json
//   Prices: price store (manual corrections + automatic closes)       →  legacy manual prices in data.json
import type { Currency, Instrument } from './types';
import type { FxSource, FxQuote } from './fx';
import type { PriceSource } from './prices';
import { rateOn, fxYearsNeeded, type FxYear, type PricesYear, type PriceSourceKind } from './market';

/** FxSource backed by BNR reference rates (weekends/holidays use the previous publication, max 10 days back). */
export function bnrFx(docs: readonly FxYear[]): FxSource {
  const byYear = new Map(docs.map(d => [d.year, d]));
  return {
    rate(currency: Currency, date: string): FxQuote | null {
      if (currency === 'RON') return { ron: 1, date, source: 'fixed' };
      const r = rateOn(byYear, date, currency);
      return r ? { ron: r.rate, date: r.date, source: 'BNR' } : null;
    },
  };
}

interface IndexedPoint { date: string; close: number; currency: Currency; source: PriceSourceKind }

/**
 * PriceSource backed by the price store. Returns the latest close on or before the date, converted to the
 * instrument's currency when the listing trades in another one (e.g. a London line in GBP for an EUR instrument).
 * If that conversion is impossible it returns null, so the next source in the chain can answer.
 */
export function storePrices(docs: readonly PricesYear[], instruments: readonly Instrument[], fx: FxSource): PriceSource {
  const index = new Map<string, IndexedPoint[]>();
  for (const doc of docs) {
    for (const [id, days] of Object.entries(doc.prices)) {
      const list = index.get(id) ?? [];
      for (const [date, p] of Object.entries(days)) if (p.close > 0) list.push({ date, ...p });
      index.set(id, list);
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const currencyOf = new Map(instruments.map(i => [i.id, i.currency]));

  return {
    price(instrumentId, date) {
      const list = index.get(instrumentId);
      if (!list?.length) return null;
      let lo = 0, hi = list.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (found < 0) return null;
      const p = list[found];
      const want = currencyOf.get(instrumentId) ?? p.currency;
      if (p.currency === want) return { price: p.close, date: p.date, source: p.source };
      const a = fx.rate(p.currency, p.date);
      const b = fx.rate(want, p.date);
      if (!a || !b) return null;
      return { price: Math.round((p.close * a.ron) / b.ron * 10_000) / 10_000, date: p.date, source: `${p.source} (${p.currency}→${want})` };
    },
  };
}

/** Manual corrections stored in the price documents, newest first (for the "Prețuri manuale" table). */
export function manualPriceRows(docs: readonly PricesYear[]) {
  const rows: { instrumentId: string; date: string; close: number; currency: Currency }[] = [];
  for (const doc of docs) {
    for (const [instrumentId, days] of Object.entries(doc.prices)) {
      for (const [date, p] of Object.entries(days)) if (p.source === 'manual') rows.push({ instrumentId, date, close: p.close, currency: p.currency });
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.instrumentId.localeCompare(b.instrumentId));
}

/** Years of market data the portfolio needs: every year with a transaction, plus the current one. */
export const marketYears = (transactionDates: string[], today: string) => fxYearsNeeded(transactionDates, today);
