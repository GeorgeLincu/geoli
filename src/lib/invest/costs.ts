// Costs (/vault/invest/costuri/): broker fees paid per year, fund costs (TER) on what is held today, and how
// much the yearly cost takes away over the years. TER values are George's (Instrument.ter); nothing is assumed.
import type { InvestData, Instrument } from './types';
import type { FxSource } from './fx';
import type { Holding } from './portfolio';
import { convert } from './fx';
import { grow } from './projection';

/** Broker fees per calendar year in EUR: transaction fees plus standalone fee rows (all accounts). */
export function feesByYear(data: Pick<InvestData, 'transactions'>, fx: FxSource) {
  const out = new Map<number, { eur: number; count: number; missing: number }>();
  for (const t of data.transactions) {
    const amt = (t.fees ?? 0) + (t.type === 'fee' ? (t.amount ?? 0) : 0);
    if (!amt) continue;
    const y = Number(t.date.slice(0, 4));
    const row = out.get(y) ?? { eur: 0, count: 0, missing: 0 };
    const eur = convert(fx, amt, t.currency, 'EUR', t.date);
    if (eur === null) row.missing++; else { row.eur += eur; row.count++; }
    out.set(y, row);
  }
  return out;
}

export interface TerRow { instrumentId: string; valueEur: number; ter: number | null; costEur: number | null }

/** Fund cost per instrument on today's holdings: value × TER (TER missing = unknown, listed separately). */
export function terCosts(holdings: readonly Holding[], instruments: readonly Instrument[]) {
  const byInst = new Map<string, number>();
  for (const h of holdings) {
    if (h.kind !== 'position' || !h.instrumentId || h.valueEur === null) continue;
    byInst.set(h.instrumentId, (byInst.get(h.instrumentId) ?? 0) + h.valueEur);
  }
  const insts = new Map(instruments.map(i => [i.id, i]));
  const rows: TerRow[] = [...byInst].map(([instrumentId, valueEur]) => {
    const ter = insts.get(instrumentId)?.ter ?? null;
    return { instrumentId, valueEur, ter, costEur: ter === null ? null : valueEur * ter };
  }).sort((a, b) => b.valueEur - a.valueEur);
  const known = rows.filter(r => r.ter !== null);
  const knownValue = known.reduce((s, r) => s + r.valueEur, 0);
  const costEur = known.reduce((s, r) => s + (r.costEur ?? 0), 0);
  return {
    rows, costEur, knownValue,
    totalValue: rows.reduce((s, r) => s + r.valueEur, 0),
    /** Value-weighted TER of the instruments that have one */
    weightedTer: knownValue > 0 ? costEur / knownValue : null,
    missing: rows.length - known.length,
  };
}

export interface DragInput {
  /** Starting value, EUR */
  start: number;
  /** Monthly contribution, EUR (real) */
  monthly: number;
  years: number;
  /** Expected real return before costs, yearly decimal */
  realReturn: number;
  /** Yearly cost as a share of the value (TER + broker fees / value) */
  costRate: number;
}

/** Year-by-year value with and without the yearly cost (same contributions), and what the cost takes away. */
export function costDrag(inp: DragInput) {
  const net = (1 + inp.realReturn) * (1 - Math.max(0, inp.costRate)) - 1;
  const gross: number[] = [inp.start], withCosts: number[] = [inp.start];
  for (let y = 1; y <= inp.years; y++) {
    gross.push(grow(gross[y - 1], inp.realReturn, inp.monthly * 12));
    withCosts.push(grow(withCosts[y - 1], net, inp.monthly * 12));
  }
  const lost = gross[inp.years] - withCosts[inp.years];
  return { gross, withCosts, lost, lostShare: gross[inp.years] > 0 ? lost / gross[inp.years] : 0, netReturn: net };
}
