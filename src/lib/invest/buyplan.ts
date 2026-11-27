// "Ce cumpăr luna asta": turns the monthly contribution into units to buy, moving the portfolio toward
// George's target without selling (water-filling from portfolio.ts rebalanceWithContribution).
import type { Instrument, TargetAllocation } from './types';
import type { Holding } from './portfolio';
import { matchTarget, rebalanceWithContribution } from './portfolio';

export interface BuyLine {
  target: TargetAllocation;
  /** Instrument bought for this row: the row's own, else the largest holding in the row; null = none known */
  instrumentId: string | null;
  /** Money the row should get, EUR */
  amountEur: number;
  /** Price per unit in EUR today (null = no price) */
  priceEur: number | null;
  units: number;
  /** units × price */
  costEur: number;
}

/** The instrument to buy for a target row. */
export function instrumentForRow(t: TargetAllocation, holdings: readonly Holding[], targets: readonly TargetAllocation[]): string | null {
  if (t.instrumentId) return t.instrumentId;
  let best: Holding | null = null;
  for (const h of holdings) {
    if (h.kind !== 'position' || !h.instrumentId) continue;
    if (matchTarget(h, targets)?.id !== t.id) continue;
    if (!best || (h.valueEur ?? 0) > (best.valueEur ?? 0)) best = h;
  }
  return best?.instrumentId ?? null;
}

/**
 * Splits `amountEur` across the target rows (most underweight first, nothing sold), then into units at today's
 * price: whole units by default (rounded down; the rest stays as cash), or fractional (4 decimals).
 * Holdings that match no target row are ignored, as on the Portofoliu page.
 */
export function buyPlan(
  holdings: readonly Holding[], targets: readonly TargetAllocation[], amountEur: number,
  priceEur: (instrumentId: string) => number | null, opts: { fractional?: boolean } = {},
) {
  const value = new Map<string, number>();
  for (const h of holdings) {
    const t = matchTarget(h, targets);
    if (t) value.set(t.id, (value.get(t.id) ?? 0) + (h.valueEur ?? 0));
  }
  const split = rebalanceWithContribution(targets.map(t => ({ id: t.id, weight: t.weight, value: value.get(t.id) ?? 0 })), amountEur);
  const lines: BuyLine[] = targets.map(t => {
    const amount = split.get(t.id) ?? 0;
    const instrumentId = instrumentForRow(t, holdings, targets);
    const price = instrumentId ? priceEur(instrumentId) : null;
    let units = 0;
    if (price && price > 0 && amount > 0) units = opts.fractional ? Math.floor((amount / price) * 1e4) / 1e4 : Math.floor(amount / price + 1e-9);
    return { target: t, instrumentId, amountEur: amount, priceEur: price, units, costEur: price ? units * price : 0 };
  }).filter(l => l.amountEur > 0.005);
  const spent = lines.reduce((s, l) => s + l.costEur, 0);
  return { lines, spent, leftover: Math.max(0, amountEur - spent) };
}

/** Name for a line: ticker, else name, else the target label. */
export const lineName = (l: BuyLine, instruments: readonly Instrument[]) => {
  const i = l.instrumentId ? instruments.find(x => x.id === l.instrumentId) : undefined;
  return i ? (i.ticker || i.name) : l.target.label;
};
