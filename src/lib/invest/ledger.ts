// Portfolio ledger: replays the transaction list into positions, realized gains, income and cash.
//
// Cost basis = weighted-average cost per account and instrument, transaction costs included.
// That is the method the Romanian Fiscal Code prescribes for gains on securities sold through intermediaries:
// Legea 227/2015 (Codul fiscal) art. 97 alin. (8^2) ("metoda prețului mediu ponderat ... cuprinzând și costurile
// aferente transferului/operațiunii, pe fiecare simbol"); costs are part of the gain per art. 94 alin. (1).
// A sale does not change the average cost of what is left; it only reduces the quantity.
//
// RON amounts: every transaction is converted at the rate valid on its own date (buy cost at the buy date,
// sale proceeds at the sale date). Which rate the tax return must use is decided in Phase 4 (tax-ro.ts),
// which can recompute from the raw rows here.
import type { Account, Currency, InvestData, Instrument, Transaction } from './types';
import type { FxSource } from './fx';

export interface Position {
  accountId: string;
  instrumentId: string;
  /** Instrument currency; cost amounts below are in it */
  currency: Currency;
  quantity: number;
  /** Total cost of the units still held, fees included */
  cost: number;
  /** Same in RON at the rates of each purchase; null if a rate was missing */
  costRon: number | null;
  avgCost: number;
  avgCostRon: number | null;
  firstBuy?: string;
}

export interface RealizedGain {
  txId: string;
  date: string;
  accountId: string;
  instrumentId: string;
  currency: Currency;
  quantity: number;
  /** Sale value minus sale fees */
  proceeds: number;
  /** Weighted-average cost of the units sold */
  cost: number;
  gain: number;
  /** Tax withheld by the broker on this sale (Romanian brokers), in the transaction currency */
  withheld: number;
  proceedsRon: number | null;
  costRon: number | null;
  gainRon: number | null;
}

export interface IncomeRow {
  txId: string;
  date: string;
  type: 'dividend' | 'interest';
  accountId: string;
  instrumentId?: string;
  currency: Currency;
  gross: number;
  withheld: number;
  fees: number;
  net: number;
  grossRon: number | null;
  withheldRon: number | null;
}

export interface CashBalance {
  accountId: string;
  currency: Currency;
  amount: number;
}

export interface FeeRow {
  txId: string;
  date: string;
  accountId: string;
  currency: Currency;
  amount: number;
  amountRon: number | null;
}

export interface LedgerWarning {
  txId: string;
  message: string;
}

export interface Ledger {
  positions: Position[];
  realized: RealizedGain[];
  income: IncomeRow[];
  cash: CashBalance[];
  fees: FeeRow[];
  /** Accounts with at least one deposit/withdrawal: only their cash is meaningful */
  cashTracked: Set<string>;
  warnings: LedgerWarning[];
}

const EPS = 1e-9;
const posKey = (accountId: string, instrumentId: string) => `${accountId}|${instrumentId}`;
const round = (n: number, d = 8) => Math.round(n * 10 ** d) / 10 ** d;

/** Stable sort by date; transactions on the same day keep the order they were entered in. */
export function sortTransactions(txs: readonly Transaction[]): Transaction[] {
  return txs.map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i)
    .map(x => x.t);
}

export function computeLedger(data: Pick<InvestData, 'accounts' | 'instruments' | 'transactions'>, fx: FxSource, asOf?: string): Ledger {
  const instruments = new Map<string, Instrument>(data.instruments.map(i => [i.id, i]));
  const accounts = new Map<string, Account>(data.accounts.map(a => [a.id, a]));
  const positions = new Map<string, Position>();
  const cash = new Map<string, CashBalance>();
  const realized: RealizedGain[] = [];
  const income: IncomeRow[] = [];
  const fees: FeeRow[] = [];
  const warnings: LedgerWarning[] = [];
  const cashTracked = new Set<string>();

  const warn = (t: Transaction, message: string) => warnings.push({ txId: t.id, message });
  const toRon = (amount: number, cur: Currency, date: string) => {
    const q = fx.rate(cur, date);
    return q ? amount * q.ron : null;
  };
  const addCash = (accountId: string, currency: Currency, delta: number) => {
    if (!delta) return;
    const k = `${accountId}|${currency}`;
    const c = cash.get(k) ?? { accountId, currency, amount: 0 };
    c.amount = round(c.amount + delta);
    cash.set(k, c);
  };
  const getPos = (accountId: string, inst: Instrument) => {
    const k = posKey(accountId, inst.id);
    let p = positions.get(k);
    if (!p) {
      p = { accountId, instrumentId: inst.id, currency: inst.currency, quantity: 0, cost: 0, costRon: 0, avgCost: 0, avgCostRon: 0 };
      positions.set(k, p);
    }
    return p;
  };
  /** Amount in the transaction currency → instrument currency (null when no rate). */
  const toInstrumentCur = (t: Transaction, inst: Instrument, amount: number) => {
    if (t.currency === inst.currency) return amount;
    const a = fx.rate(t.currency, t.date), b = fx.rate(inst.currency, t.date);
    if (!a || !b) return null;
    return (amount * a.ron) / b.ron;
  };
  const refreshAvg = (p: Position) => {
    if (p.quantity > EPS) {
      p.avgCost = p.cost / p.quantity;
      p.avgCostRon = p.costRon === null ? null : p.costRon / p.quantity;
    } else {
      p.quantity = 0; p.cost = 0; p.costRon = 0; p.avgCost = 0; p.avgCostRon = 0; p.firstBuy = undefined;
    }
  };

  for (const t of sortTransactions(data.transactions)) {
    if (asOf && t.date > asOf) break;
    if (!accounts.has(t.accountId)) { warn(t, 'Cont inexistent'); continue; }
    const f = t.fees ?? 0;
    const inst = t.instrumentId ? instruments.get(t.instrumentId) : undefined;
    if (t.instrumentId && !inst) { warn(t, 'Instrument inexistent'); continue; }

    switch (t.type) {
      case 'deposit':
      case 'withdrawal': {
        cashTracked.add(t.accountId);
        const amt = t.amount ?? 0;
        addCash(t.accountId, t.currency, t.type === 'deposit' ? amt - f : -amt - f);
        break;
      }
      case 'buy': {
        if (!inst || !(t.quantity! > 0) || t.price === undefined) { warn(t, 'Cumpărare fără instrument, cantitate sau preț'); break; }
        const gross = t.quantity! * t.price + f;
        const costInst = toInstrumentCur(t, inst, gross);
        if (costInst === null) { warn(t, `Lipsește cursul ${t.currency}/${inst.currency} la ${t.date}`); break; }
        const p = getPos(t.accountId, inst);
        const ron = toRon(gross, t.currency, t.date);
        if (ron === null) warn(t, `Lipsește cursul ${t.currency}→RON la ${t.date}`);
        p.quantity = round(p.quantity + t.quantity!);
        p.cost += costInst;
        p.costRon = p.costRon === null || ron === null ? null : p.costRon + ron;
        p.firstBuy ??= t.date;
        refreshAvg(p);
        addCash(t.accountId, t.currency, -gross);
        break;
      }
      case 'sell': {
        if (!inst || !(t.quantity! > 0) || t.price === undefined) { warn(t, 'Vânzare fără instrument, cantitate sau preț'); break; }
        const p = getPos(t.accountId, inst);
        let qty = t.quantity!;
        if (qty > p.quantity + EPS) {
          warn(t, `Vinzi ${qty} dar deții ${round(p.quantity, 6)}; se calculează doar pentru cât deții`);
          qty = p.quantity;
        }
        const net = t.quantity! * t.price - f;
        // Proceeds are scaled when more is sold than held, so the gain only covers units we know the cost of
        const proceeds = t.quantity! > 0 ? net * (qty / t.quantity!) : 0;
        const proceedsInst = toInstrumentCur(t, inst, proceeds);
        if (proceedsInst === null) { warn(t, `Lipsește cursul ${t.currency}/${inst.currency} la ${t.date}`); break; }
        const cost = qty * p.avgCost;
        const costRon = p.avgCostRon === null ? null : qty * p.avgCostRon;
        const proceedsRon = toRon(proceeds, t.currency, t.date);
        if (proceedsRon === null) warn(t, `Lipsește cursul ${t.currency}→RON la ${t.date}`);
        if (qty > 0) {
          realized.push({
            txId: t.id, date: t.date, accountId: t.accountId, instrumentId: inst.id, currency: inst.currency,
            quantity: qty, proceeds: proceedsInst, cost, gain: proceedsInst - cost, withheld: t.withheldTax ?? 0,
            proceedsRon, costRon, gainRon: proceedsRon !== null && costRon !== null ? proceedsRon - costRon : null,
          });
        }
        p.quantity = round(p.quantity - qty);
        p.cost -= cost;
        if (p.costRon !== null && costRon !== null) p.costRon -= costRon;
        refreshAvg(p);
        addCash(t.accountId, t.currency, net - (t.withheldTax ?? 0));
        break;
      }
      case 'dividend':
      case 'interest': {
        const gross = t.amount ?? 0;
        const withheld = t.withheldTax ?? 0;
        income.push({
          txId: t.id, date: t.date, type: t.type, accountId: t.accountId, instrumentId: inst?.id, currency: t.currency,
          gross, withheld, fees: f, net: gross - withheld - f,
          grossRon: toRon(gross, t.currency, t.date), withheldRon: toRon(withheld, t.currency, t.date),
        });
        if (t.currency !== 'RON' && !fx.rate(t.currency, t.date)) warn(t, `Lipsește cursul ${t.currency}→RON la ${t.date}`);
        addCash(t.accountId, t.currency, gross - withheld - f);
        break;
      }
      case 'fee': {
        const amt = (t.amount ?? 0) + f;
        fees.push({ txId: t.id, date: t.date, accountId: t.accountId, currency: t.currency, amount: amt, amountRon: toRon(amt, t.currency, t.date) });
        addCash(t.accountId, t.currency, -amt);
        break;
      }
      case 'transfer': {
        if (!t.toAccountId || !accounts.has(t.toAccountId)) { warn(t, 'Transfer fără cont destinație'); break; }
        if (inst && t.quantity! > 0) {
          // Securities move with their average cost
          const from = getPos(t.accountId, inst);
          const qty = Math.min(t.quantity!, from.quantity);
          if (t.quantity! > from.quantity + EPS) warn(t, `Transferi ${t.quantity} dar deții ${round(from.quantity, 6)}`);
          const share = from.quantity > 0 ? qty / from.quantity : 0;
          const cost = from.cost * share;
          const costRon = from.costRon === null ? null : from.costRon * share;
          const to = getPos(t.toAccountId, inst);
          to.quantity = round(to.quantity + qty);
          to.cost += cost;
          to.costRon = to.costRon === null || costRon === null ? null : to.costRon + costRon;
          to.firstBuy = !to.firstBuy || (from.firstBuy && from.firstBuy < to.firstBuy) ? from.firstBuy : to.firstBuy;
          from.quantity = round(from.quantity - qty);
          from.cost -= cost;
          if (from.costRon !== null && costRon !== null) from.costRon -= costRon;
          refreshAvg(from); refreshAvg(to);
          addCash(t.accountId, t.currency, -f);
        } else {
          const amt = t.amount ?? 0;
          cashTracked.add(t.accountId); cashTracked.add(t.toAccountId);
          addCash(t.accountId, t.currency, -amt - f);
          addCash(t.toAccountId, t.currency, amt);
        }
        if (f) fees.push({ txId: t.id, date: t.date, accountId: t.accountId, currency: t.currency, amount: f, amountRon: toRon(f, t.currency, t.date) });
        break;
      }
    }
  }

  return {
    positions: [...positions.values()].filter(p => p.quantity > EPS),
    realized, income, fees, warnings, cashTracked,
    cash: [...cash.values()].filter(c => Math.abs(c.amount) > 1e-6),
  };
}

/** Sums per calendar year, in RON (rows with a missing rate are counted in `missing`). */
export function yearTotals(ledger: Ledger, year: number) {
  const inYear = (d: string) => d.startsWith(`${year}-`);
  let gainRon = 0, lossRon = 0, divRon = 0, divTaxRon = 0, intRon = 0, intTaxRon = 0, feesRon = 0, missing = 0;
  for (const r of ledger.realized) {
    if (!inYear(r.date)) continue;
    if (r.gainRon === null) { missing++; continue; }
    if (r.gainRon >= 0) gainRon += r.gainRon; else lossRon += r.gainRon;
  }
  for (const r of ledger.income) {
    if (!inYear(r.date)) continue;
    if (r.grossRon === null || r.withheldRon === null) { missing++; continue; }
    if (r.type === 'dividend') { divRon += r.grossRon; divTaxRon += r.withheldRon; } else { intRon += r.grossRon; intTaxRon += r.withheldRon; }
  }
  for (const r of ledger.fees) {
    if (!inYear(r.date)) continue;
    if (r.amountRon === null) { missing++; continue; }
    feesRon += r.amountRon;
  }
  return { gainRon, lossRon, netGainRon: gainRon + lossRon, divRon, divTaxRon, intRon, intTaxRon, feesRon, missing };
}
