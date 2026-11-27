// Instrument prices. Phase 2: manual prices from data.json. Phase 3 adds a source fed from
// invest/prices/<year>.json and chains it behind the manual overrides: chainPrices(manual, auto).
import type { PricePoint } from './types';

export interface PriceQuote {
  /** In the instrument's currency */
  price: number;
  date: string;
  source: string;
}

export interface PriceSource {
  /** Latest price on or before `date`, or null. */
  price(instrumentId: string, date: string): PriceQuote | null;
}

export function tablePrices(points: readonly PricePoint[], source = 'manual'): PriceSource {
  const by = new Map<string, PricePoint[]>();
  for (const p of points) {
    if (!(p.price >= 0)) continue;
    const list = by.get(p.instrumentId) ?? [];
    list.push(p);
    by.set(p.instrumentId, list);
  }
  for (const list of by.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return {
    price(instrumentId, date) {
      const list = by.get(instrumentId);
      if (!list) return null;
      let best: PricePoint | undefined;
      for (const p of list) { if (p.date <= date) best = p; else break; }
      return best ? { price: best.price, date: best.date, source } : null;
    },
  };
}

export const manualPrices = (points: readonly PricePoint[] = []) => tablePrices(points, 'manual');

/** First source with a quote wins (put manual overrides first). */
export function chainPrices(...sources: PriceSource[]): PriceSource {
  return {
    price(id, date) {
      for (const s of sources) {
        const q = s.price(id, date);
        if (q) return q;
      }
      return null;
    },
  };
}
