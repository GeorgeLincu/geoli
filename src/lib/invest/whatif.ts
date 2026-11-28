// "Ce-ar fi dacă" (/vault/invest/simulare/): what a withdrawal of X today would sell, cost in Romanian tax,
// and do to the allocation and to the years until FI. Pure functions; the page gathers the inputs.
//
// Selling rule: proportional to the market value of the eligible positions (one account, one instrument, or all),
// so the allocation inside the selection stays the same. Gains use the weighted-average cost of the ledger
// (the Romanian method). Tax: tax-ro.ts estimateSales on top of what the year already holds.
import type { Account, Currency, TaxRuleSet } from './types';
import type { FxSource } from './fx';
import type { Holding } from './portfolio';
import type { TaxAggregates, LossBucket, SaleEstimate } from './tax-ro';
import { convert } from './fx';
import { estimateSales } from './tax-ro';

export interface WithdrawalFilter { accountId?: string; instrumentId?: string }

export interface SaleLine {
  key: string;
  accountId: string;
  instrumentId: string;
  currency: Currency;
  /** Units to sell (fractional, rounded to 6 decimals) */
  quantity: number;
  /** Sale value in EUR and in the instrument currency */
  valueEur: number;
  value: number;
  /** Gain at the average cost, in the instrument currency and in RON (null = no RON rate) */
  gain: number;
  gainRon: number | null;
}

export interface WithdrawalPlan {
  lines: SaleLine[];
  /** What was asked and what the selection can give */
  askedEur: number;
  soldEur: number;
  /** Asked − available, when the selection is too small (0 otherwise) */
  shortfallEur: number;
  /** Holdings after the sale (the sold part removed) */
  after: Holding[];
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Positions that can be sold for the withdrawal (market/face/cost valued, positive value). */
export const eligible = (holdings: readonly Holding[], f: WithdrawalFilter) =>
  holdings.filter(h => h.kind === 'position' && (h.valueEur ?? 0) > 0 && (h.quantity ?? 0) > 0
    && (!f.accountId || h.accountId === f.accountId) && (!f.instrumentId || h.instrumentId === f.instrumentId));

export function planWithdrawal(holdings: readonly Holding[], amountEur: number, f: WithdrawalFilter, fx: FxSource, date: string): WithdrawalPlan {
  const pool = eligible(holdings, f);
  const total = pool.reduce((s, h) => s + (h.valueEur ?? 0), 0);
  const want = Math.max(0, amountEur);
  const sell = Math.min(want, total);
  const share = total > 0 ? sell / total : 0;
  const lines: SaleLine[] = [];
  const sold = new Map<string, number>();
  for (const h of pool) {
    if (share <= 0) break;
    const qty = r6((h.quantity ?? 0) * share);
    const value = h.value * share;
    const avg = h.cost !== undefined && h.quantity ? h.cost / h.quantity : 0;
    const gain = value - qty * avg;
    lines.push({
      key: h.key, accountId: h.accountId, instrumentId: h.instrumentId!, currency: h.currency,
      quantity: qty, valueEur: (h.valueEur ?? 0) * share, value, gain, gainRon: convert(fx, gain, h.currency, 'RON', date),
    });
    sold.set(h.key, share);
  }
  const after = holdings.map(h => {
    const s = sold.get(h.key);
    if (!s) return h;
    const k = 1 - s;
    return {
      ...h, quantity: (h.quantity ?? 0) * k, value: h.value * k, cost: h.cost === undefined ? undefined : h.cost * k,
      valueEur: h.valueEur === null ? null : h.valueEur * k, valueRon: h.valueRon === null ? null : h.valueRon * k,
    };
  });
  return { lines, askedEur: want, soldEur: sell, shortfallEur: Math.max(0, want - total), after };
}

export interface WithdrawalTax {
  estimate: SaleEstimate;
  /** Lines without a RON rate (left out of the tax) */
  missing: number;
}

/**
 * Marginal Romanian tax of the sales, on top of the year's realised income so far (`base`, from the Taxe
 * computation). Romanian-broker sales are assumed held for more than the long-term threshold (the lower rate);
 * the page says so.
 */
export function withdrawalTax(set: TaxRuleSet, year: number, lines: readonly SaleLine[], accounts: readonly Account[], base?: TaxAggregates, carryIn?: LossBucket[]): WithdrawalTax {
  const byId = new Map(accounts.map(a => [a.id, a]));
  let missing = 0;
  const sales = lines.flatMap(l => {
    if (l.gainRon === null) { missing++; return []; }
    return [{ accountType: byId.get(l.accountId)?.type ?? 'foreign_broker', gainRon: l.gainRon }];
  });
  return { estimate: estimateSales(set, sales, { year, base, carryIn }), missing };
}
