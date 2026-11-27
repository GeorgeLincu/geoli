// Exchange rates. Convention: like BNR, a rate is "RON per 1 unit of the currency".
// Phase 2 uses manual rates from data.json; Phase 3 adds an FxSource fed from invest/fx/<year>.json and
// chains it in front of the manual one with chainFx(bnr, manual). The ledger only sees the FxSource interface.
import type { Currency, FxRate } from './types';

export interface FxQuote {
  /** RON per 1 unit */
  ron: number;
  /** Date of the rate actually used (latest on or before the requested date) */
  date: string;
  source: string;
}

export interface FxSource {
  /** RON per 1 unit of `currency` valid on `date`, or null if unknown. RON itself is always 1. */
  rate(currency: Currency, date: string): FxQuote | null;
}

/** Sorted lookup: the latest rate on or before `date`. */
export function tableFx(rates: readonly FxRate[], source = 'manual'): FxSource {
  const by = new Map<Currency, FxRate[]>();
  for (const r of rates) {
    if (!(r.ron > 0)) continue;
    const list = by.get(r.currency) ?? [];
    list.push(r);
    by.set(r.currency, list);
  }
  for (const list of by.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return {
    rate(currency, date) {
      if (currency === 'RON') return { ron: 1, date, source: 'fixed' };
      const list = by.get(currency);
      if (!list) return null;
      let lo = 0, hi = list.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (found < 0) return null;
      return { ron: list[found].ron, date: list[found].date, source };
    },
  };
}

export const manualFx = (rates: readonly FxRate[] = []) => tableFx(rates, 'manual');

/** First source that knows the rate wins. */
export function chainFx(...sources: FxSource[]): FxSource {
  return {
    rate(currency, date) {
      for (const s of sources) {
        const q = s.rate(currency, date);
        if (q) return q;
      }
      return null;
    },
  };
}

/** Converts between any two currencies through RON. Returns null when a rate is missing. */
export function convert(fx: FxSource, amount: number, from: Currency, to: Currency, date: string): number | null {
  if (from === to) return amount;
  const a = fx.rate(from, date);
  const b = fx.rate(to, date);
  if (!a || !b) return null;
  return (amount * a.ron) / b.ron;
}
