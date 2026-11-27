// Romanian personal income tax on investment income, per income year (Phase 4).
//
// Nothing here is hard-coded: every rate, threshold and rule switch is a TaxParam in invest/tax-rules.json
// (one TaxRuleSet per year, each value with its source and "verified on" date, confirmed by George).
// The parameter keys are listed in TAX_PARAMS; their researched values live in tax-ro-defaults.ts.
//
// Categories (by account type, see classify*):
//   • foreign  — gains through a non-resident broker: yearly net gain, losses carried forward, tax paid via
//                Declarația Unică (DU).
//   • ro       — gains through a Romanian broker: tax withheld per sale by the broker (rate by holding period),
//                final; nothing to pay via DU.
//   • dividends / interest — RO source: withheld at source, final. Foreign source: RO tax due on the gross
//                amount, minus a credit for the tax withheld abroad (capped at the RO tax on that income).
//   • CASS     — health contribution on investment income, a fixed amount by tier (multiples of the minimum
//                gross wage).
//
// This is a calculator, not tax advice.
import type { AccountType, Account, Currency, Instrument, TaxParam, TaxRuleSet, TaxRules, Transaction } from './types';
import type { Ledger } from './ledger';
import { sortTransactions } from './ledger';
import type { FxSource } from './fx';
import type { FxYear } from './market';

// ─── Parameters ───

export type ParamKind = 'rate' | 'number' | 'ron' | 'eur' | 'flag' | 'choice';
export type ParamGroup = 'gains' | 'losses' | 'dividends' | 'interest' | 'cass' | 'other' | 'fx' | 'deadline';

export interface ParamDef {
  key: string;
  group: ParamGroup;
  label: string;
  kind: ParamKind;
  help?: string;
  /** For kind 'choice': value → label */
  choices?: [number, string][];
  /** Used by the calculation (false = shown for information only) */
  used: boolean;
}

export const PARAM_GROUP_LABEL: Record<ParamGroup, string> = {
  gains: 'Câștiguri din vânzarea titlurilor',
  losses: 'Pierderi',
  dividends: 'Dividende',
  interest: 'Dobânzi',
  cass: 'CASS (contribuția de sănătate)',
  other: 'Alte contribuții și deduceri',
  fx: 'Conversia în lei (curs BNR)',
  deadline: 'Termen',
};

export const FX_TX = 0;
export const FX_AVG = 1;

export const TAX_PARAMS: ParamDef[] = [
  { key: 'cg.foreign.rate', group: 'gains', kind: 'rate', used: true, label: 'Impozit pe câștigul net anual — broker străin (prin Declarația Unică)' },
  { key: 'cg.ro.rateLong', group: 'gains', kind: 'rate', used: true, label: 'Reținere la sursă — broker RO, titluri deținute cel puțin pragul' },
  { key: 'cg.ro.rateShort', group: 'gains', kind: 'rate', used: true, label: 'Reținere la sursă — broker RO, titluri deținute sub prag' },
  { key: 'cg.ro.holdDays', group: 'gains', kind: 'number', used: true, label: 'Pragul de deținere (zile)', help: 'Durata se calculează pe loturi, primul intrat — primul ieșit.' },
  { key: 'loss.carryYears', group: 'losses', kind: 'number', used: true, label: 'Pierderea netă anuală (broker străin) se reportează timp de (ani)' },
  { key: 'loss.offsetShare', group: 'losses', kind: 'rate', used: true, label: 'Cât din câștigul net al anului poate fi acoperit de pierderi reportate', help: '100% = fără limită.' },
  { key: 'div.rate', group: 'dividends', kind: 'rate', used: true, label: 'Impozit pe dividende' },
  { key: 'div.foreignCredit', group: 'dividends', kind: 'flag', used: true, label: 'Credit fiscal pentru impozitul reținut în străinătate (plafonat la impozitul din România)' },
  { key: 'div.usTreatyRate', group: 'dividends', kind: 'rate', used: false, label: 'Reținerea SUA pe dividende cu formularul W-8BEN (tratatul RO–SUA)', help: 'Doar informativ: pagina te avertizează dacă reținerea e mai mare.' },
  { key: 'int.rate', group: 'interest', kind: 'rate', used: true, label: 'Impozit pe dobânzi' },
  { key: 'int.govExempt', group: 'interest', kind: 'flag', used: true, label: 'Dobânzile la titluri de stat (Tezaur, Fidelis) sunt neimpozabile' },
  { key: 'cass.rate', group: 'cass', kind: 'rate', used: true, label: 'Cota CASS' },
  { key: 'cass.minWage', group: 'cass', kind: 'ron', used: true, label: 'Salariul minim brut folosit pentru plafoanele CASS (lei/lună)' },
  { key: 'cass.t1', group: 'cass', kind: 'number', used: true, label: 'Plafon 1 (număr de salarii minime)' },
  { key: 'cass.t2', group: 'cass', kind: 'number', used: true, label: 'Plafon 2 (număr de salarii minime)' },
  { key: 'cass.t3', group: 'cass', kind: 'number', used: true, label: 'Plafon 3 (număr de salarii minime)' },
  { key: 'cass.t4', group: 'cass', kind: 'number', used: true, label: 'Plafon 4 (număr de salarii minime), dacă există' },
  { key: 'cass.countRoGains', group: 'cass', kind: 'flag', used: true, label: 'Câștigurile prin broker RO intră în baza CASS' },
  { key: 'cass.countExemptInterest', group: 'cass', kind: 'flag', used: true, label: 'Dobânzile neimpozabile (titluri de stat) intră în baza CASS' },
  { key: 'cass.netOfWithheld', group: 'cass', kind: 'flag', used: true, label: 'Dividendele și dobânzile intră în baza CASS net de impozitul reținut' },
  { key: 'cass.lossReducesBase', group: 'cass', kind: 'flag', used: true, label: 'Pierderile reportate reduc și baza CASS' },
  { key: 'wage.min', group: 'cass', kind: 'ron', used: false, label: 'Salariul minim brut pe țară la 1 ianuarie (lei/lună)' },
  { key: 'cas.rate', group: 'other', kind: 'rate', used: false, label: 'CAS (pensie) pe venituri din investiții', help: 'Doar informativ.' },
  { key: 'pillar3.maxEur', group: 'other', kind: 'eur', used: false, label: 'Deducere contribuții Pilon 3 (EUR/an)', help: 'Se aplică pe salariu, nu pe veniturile din investiții; doar informativ.' },
  { key: 'fx.gains', group: 'fx', kind: 'choice', used: true, label: 'Curs pentru câștiguri (cumpărări/vânzări în valută)', choices: [[FX_TX, 'cursul BNR al zilei tranzacției'], [FX_AVG, 'cursul mediu anual BNR']] },
  { key: 'fx.income', group: 'fx', kind: 'choice', used: true, label: 'Curs pentru dividende, dobânzi și impozitul reținut în străinătate', choices: [[FX_TX, 'cursul BNR al zilei încasării'], [FX_AVG, 'cursul mediu anual BNR']] },
  { key: 'fx.prevDay', group: 'fx', kind: 'flag', used: true, label: 'Folosește cursul BNR publicat în ziua lucrătoare anterioară tranzacției' },
  { key: 'du.month', group: 'deadline', kind: 'number', used: true, label: 'Termen Declarația Unică — luna (anul următor)' },
  { key: 'du.day', group: 'deadline', kind: 'number', used: true, label: 'Termen Declarația Unică — ziua' },
];

export const PARAM_BY_KEY = new Map(TAX_PARAMS.map(d => [d.key, d]));

/** Rule set for an income year: that year's, else the latest earlier one, else the earliest one. */
export function rulesFor(rules: TaxRules | null | undefined, year: number): { set: TaxRuleSet; exact: boolean } | null {
  const years = [...(rules?.years ?? [])].sort((a, b) => a.year - b.year);
  if (!years.length) return null;
  const exact = years.find(y => y.year === year);
  if (exact) return { set: exact, exact: true };
  const before = years.filter(y => y.year < year).pop();
  return { set: before ?? years[0], exact: false };
}

/** Parameter value, or `fallback` when the rule set doesn't define it. */
export const pv = (set: TaxRuleSet, key: string, fallback = 0) => {
  const v = set.params[key]?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
export const flag = (set: TaxRuleSet, key: string) => pv(set, key) !== 0;

/** Keys the calculation needs that the rule set doesn't define. */
export function missingParams(set: TaxRuleSet): string[] {
  const optional = new Set(['cass.t4']);
  return TAX_PARAMS.filter(d => d.used && !optional.has(d.key) && !(d.key in set.params)).map(d => d.key);
}

/** Parameters not yet confirmed by George (per-parameter flag, or the whole year when it has none). */
export function unconfirmedParams(set: TaxRuleSet): string[] {
  return Object.entries(set.params).filter(([, p]) => !(p.confirmed ?? set.confirmed)).map(([k]) => k);
}

/** Due date of the Declarația Unică for an income year (ISO). */
export function duDeadline(set: TaxRuleSet, incomeYear: number): string {
  const m = Math.min(12, Math.max(1, Math.round(pv(set, 'du.month', 5))));
  const d = Math.min(31, Math.max(1, Math.round(pv(set, 'du.day', 25))));
  return `${incomeYear + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** New year entry copied from an earlier one: same values, nothing confirmed. */
export function copyRuleSet(from: TaxRuleSet, year: number): TaxRuleSet {
  const params: Record<string, TaxParam> = {};
  for (const [k, p] of Object.entries(from.params)) params[k] = { ...p, confirmed: false };
  return { year, confirmed: false, params };
}

// ─── FX ───

/** FX source that answers with the rate BNR published on the previous day (weekends fall back further). */
export function prevDayFx(fx: FxSource): FxSource {
  return {
    rate(currency, date) {
      if (currency === 'RON') return fx.rate(currency, date);
      const d = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      return fx.rate(currency, d);
    },
  };
}

export interface AnnualAverage { currency: Currency; rate: number; days: number; source: 'BNR (medie zilnică)' | 'manual' }

/**
 * Yearly average RON rate per currency: the arithmetic mean of BNR's daily rates in that year, unless the rule set
 * holds an official value under `fx.avg.<CUR>` (BNR publishes the yearly averages; enter them there).
 */
export function annualAverages(fxDocs: readonly FxYear[], year: number, set?: TaxRuleSet): Map<Currency, AnnualAverage> {
  const out = new Map<Currency, AnnualAverage>();
  const doc = fxDocs.find(d => d.year === year);
  const sums = new Map<Currency, { s: number; n: number }>();
  for (const rates of Object.values(doc?.rates ?? {})) {
    for (const [cur, r] of Object.entries(rates) as [Currency, number][]) {
      if (!(r > 0)) continue;
      const x = sums.get(cur) ?? { s: 0, n: 0 };
      x.s += r; x.n++;
      sums.set(cur, x);
    }
  }
  for (const [cur, { s, n }] of sums) out.set(cur, { currency: cur, rate: Math.round((s / n) * 10_000) / 10_000, days: n, source: 'BNR (medie zilnică)' });
  if (set) {
    for (const [k, p] of Object.entries(set.params)) {
      const m = /^fx\.avg\.([A-Z]{3})$/.exec(k);
      if (m && p.value > 0) out.set(m[1] as Currency, { currency: m[1] as Currency, rate: p.value, days: 0, source: 'manual' });
    }
  }
  return out;
}

// ─── Holding periods (Romanian broker) ───

export interface HoldingSplit { longQty: number; shortQty: number; firstBuy?: string; lastBuy?: string }

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * For every sale, how many units were held at least `holdDays` days (FIFO lots per account and instrument).
 * Transfers in carry no date of their own, so they are treated as bought on the transfer date (conservative).
 */
export function holdingSplits(transactions: readonly Transaction[], holdDays: number): Map<string, HoldingSplit> {
  const lots = new Map<string, { date: string; qty: number }[]>();
  const out = new Map<string, HoldingSplit>();
  const key = (acc: string, inst: string) => `${acc}|${inst}`;
  for (const t of sortTransactions(transactions)) {
    if (!t.instrumentId || !(t.quantity! > 0)) continue;
    if (t.type === 'buy' || (t.type === 'transfer' && t.toAccountId)) {
      const k = key(t.type === 'buy' ? t.accountId : t.toAccountId!, t.instrumentId);
      if (t.type === 'transfer') {
        // Move the oldest lots from the source account, keeping their dates
        const from = lots.get(key(t.accountId, t.instrumentId)) ?? [];
        let left = t.quantity!;
        const moved: { date: string; qty: number }[] = [];
        while (left > 1e-9 && from.length) {
          const lot = from[0];
          const q = Math.min(lot.qty, left);
          moved.push({ date: lot.date, qty: q });
          lot.qty -= q; left -= q;
          if (lot.qty <= 1e-9) from.shift();
        }
        if (left > 1e-9) moved.push({ date: t.date, qty: left });
        const to = lots.get(k) ?? [];
        to.push(...moved);
        to.sort((a, b) => a.date.localeCompare(b.date));
        lots.set(k, to);
      } else {
        const l = lots.get(k) ?? [];
        l.push({ date: t.date, qty: t.quantity! });
        lots.set(k, l);
      }
    } else if (t.type === 'sell') {
      const l = lots.get(key(t.accountId, t.instrumentId)) ?? [];
      let left = t.quantity!;
      const split: HoldingSplit = { longQty: 0, shortQty: 0 };
      while (left > 1e-9 && l.length) {
        const lot = l[0];
        const q = Math.min(lot.qty, left);
        if (daysBetween(lot.date, t.date) >= holdDays) split.longQty += q; else split.shortQty += q;
        split.firstBuy ??= lot.date;
        split.lastBuy = lot.date;
        lot.qty -= q; left -= q;
        if (lot.qty <= 1e-9) l.shift();
      }
      out.set(t.id, split);
    }
  }
  return out;
}

// ─── Core: tax from yearly aggregates ───

/** A loss from an earlier year that can still be used. `amount` is what is left (positive, RON). */
export interface LossBucket { year: number; amount: number; expiresAfter: number }

export interface ForeignIncome { kind: 'dividend' | 'interest'; grossRon: number; withheldRon: number }

export interface TaxAggregates {
  /** Foreign-broker gains minus losses of the year (RON) */
  foreignNetGainRon: number;
  /** Romanian-broker gains minus losses (RON) and the tax withheld (actual or estimated) */
  roNetGainRon: number;
  roWithheldRon: number;
  /** Romanian-source income, tax already withheld (final) */
  roDividendsRon: number;
  roDividendsWithheldRon: number;
  roInterestRon: number;
  roInterestWithheldRon: number;
  /** Interest exempt from income tax (government securities) */
  exemptInterestRon: number;
  /** Foreign-source dividends/interest, one row per payment (the credit is capped per payment) */
  foreign: ForeignIncome[];
}

export const emptyAggregates = (): TaxAggregates => ({
  foreignNetGainRon: 0, roNetGainRon: 0, roWithheldRon: 0, roDividendsRon: 0, roDividendsWithheldRon: 0,
  roInterestRon: 0, roInterestWithheldRon: 0, exemptInterestRon: 0, foreign: [],
});

export interface CassResult {
  base: number;
  minWage: number;
  /** Thresholds in RON (ascending) */
  thresholds: number[];
  /** Multiples of the minimum wage behind the thresholds */
  multiples: number[];
  /** 0 = under the first threshold, 1 = first tier, … */
  tier: number;
  due: number;
}

export interface TaxResult {
  gains: {
    foreignNet: number;
    lossAvailable: number;
    lossUsed: number;
    taxable: number;
    tax: number;
    /** Loss of this year added to the carry-forward */
    lossCreated: number;
    carryOut: LossBucket[];
    roNet: number;
    roWithheld: number;
  };
  dividends: { roGross: number; roWithheld: number; foreignGross: number; foreignDue: number; credit: number; toPay: number };
  interest: { roGross: number; roWithheld: number; exempt: number; foreignGross: number; foreignDue: number; credit: number; toPay: number };
  cass: CassResult;
  /** Withheld at source (RO broker, RO dividends/interest, foreign tax credited) */
  withheld: number;
  /** Income tax + CASS to pay via Declarația Unică */
  payable: number;
  totalTax: number;
  grossIncome: number;
  effectiveRate: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function cassFor(set: TaxRuleSet, base: number): CassResult {
  const minWage = pv(set, 'cass.minWage');
  const multiples = ['cass.t1', 'cass.t2', 'cass.t3', 'cass.t4']
    .map(k => pv(set, k)).filter(x => x > 0).sort((a, b) => a - b);
  const thresholds = multiples.map(m => m * minWage);
  let tier = 0;
  for (let i = 0; i < thresholds.length; i++) if (base >= thresholds[i]) tier = i + 1;
  const due = tier ? r2(pv(set, 'cass.rate') * thresholds[tier - 1]) : 0;
  return { base: r2(base), minWage, thresholds, multiples, tier, due };
}

/** Tax for one year from its aggregates and the losses carried in from earlier years. */
export function computeTax(set: TaxRuleSet, year: number, agg: TaxAggregates, carryIn: readonly LossBucket[] = []): TaxResult {
  // Foreign-broker gains: offset carried losses (oldest first, within the allowed share), tax the rest
  const buckets = carryIn.filter(b => b.amount > 0 && b.expiresAfter >= year && b.year < year).map(b => ({ ...b }))
    .sort((a, b) => a.year - b.year);
  const lossAvailable = buckets.reduce((s, b) => s + b.amount, 0);
  const netGain = agg.foreignNetGainRon;
  let lossUsed = 0;
  if (netGain > 0) {
    let cap = netGain * pv(set, 'loss.offsetShare', 1);
    for (const b of buckets) {
      const use = Math.min(b.amount, cap);
      b.amount -= use; cap -= use; lossUsed += use;
      if (cap <= 1e-9) break;
    }
  }
  const taxable = Math.max(0, netGain - lossUsed);
  const gainTax = r2(taxable * pv(set, 'cg.foreign.rate'));
  const lossCreated = netGain < 0 ? -netGain : 0;
  const carryOut = buckets.filter(b => b.amount > 1e-6);
  if (lossCreated > 0) carryOut.push({ year, amount: lossCreated, expiresAfter: year + Math.round(pv(set, 'loss.carryYears')) });

  // Foreign dividends / interest: RO tax on the gross amount, credit for tax paid abroad (capped per payment)
  const credit = flag(set, 'div.foreignCredit');
  const fDiv = { gross: 0, due: 0, credit: 0 };
  const fInt = { gross: 0, due: 0, credit: 0 };
  for (const f of agg.foreign) {
    const rate = pv(set, f.kind === 'dividend' ? 'div.rate' : 'int.rate');
    const due = f.grossRon * rate;
    const c = credit ? Math.min(Math.max(0, f.withheldRon), due) : 0;
    const t = f.kind === 'dividend' ? fDiv : fInt;
    t.gross += f.grossRon; t.due += due; t.credit += c;
  }

  // CASS
  const exemptCounts = flag(set, 'cass.countExemptInterest');
  // Net of withheld tax: RO withholding, and for foreign income the tax withheld abroad plus the RO top-up
  const netOfTax = flag(set, 'cass.netOfWithheld');
  const incomeBase = netOfTax
    ? (agg.roDividendsRon - agg.roDividendsWithheldRon) + (agg.roInterestRon - agg.roInterestWithheldRon)
      + agg.foreign.reduce((a, f) => a + f.grossRon - Math.max(f.withheldRon, f.grossRon * pv(set, f.kind === 'dividend' ? 'div.rate' : 'int.rate')), 0)
    : agg.roDividendsRon + agg.roInterestRon + fDiv.gross + fInt.gross;
  const cassBase = incomeBase
    + (exemptCounts ? agg.exemptInterestRon : 0)
    + Math.max(0, netGain - (flag(set, 'cass.lossReducesBase') ? lossUsed : 0))
    + (flag(set, 'cass.countRoGains') ? Math.max(0, agg.roNetGainRon) : 0);
  const cass = cassFor(set, cassBase);

  const dividends = {
    roGross: r2(agg.roDividendsRon), roWithheld: r2(agg.roDividendsWithheldRon),
    foreignGross: r2(fDiv.gross), foreignDue: r2(fDiv.due), credit: r2(fDiv.credit), toPay: r2(fDiv.due - fDiv.credit),
  };
  const interest = {
    roGross: r2(agg.roInterestRon), roWithheld: r2(agg.roInterestWithheldRon), exempt: r2(agg.exemptInterestRon),
    foreignGross: r2(fInt.gross), foreignDue: r2(fInt.due), credit: r2(fInt.credit), toPay: r2(fInt.due - fInt.credit),
  };
  const withheld = r2(agg.roWithheldRon + dividends.roWithheld + interest.roWithheld + dividends.credit + interest.credit);
  const payable = r2(gainTax + dividends.toPay + interest.toPay + cass.due);
  const grossIncome = r2(Math.max(0, netGain) + Math.max(0, agg.roNetGainRon) + agg.roDividendsRon + agg.roInterestRon
    + agg.exemptInterestRon + fDiv.gross + fInt.gross);
  const totalTax = r2(withheld + payable);

  return {
    gains: {
      foreignNet: r2(netGain), lossAvailable: r2(lossAvailable), lossUsed: r2(lossUsed), taxable: r2(taxable), tax: gainTax,
      lossCreated: r2(lossCreated), carryOut, roNet: r2(agg.roNetGainRon), roWithheld: r2(agg.roWithheldRon),
    },
    dividends, interest, cass, withheld, payable, totalTax, grossIncome,
    effectiveRate: grossIncome > 0 ? totalTax / grossIncome : null,
  };
}

// ─── From the ledger to yearly aggregates ───

export type GainCategory = 'foreign' | 'ro';

export const gainCategory = (type: AccountType | undefined): GainCategory => (type === 'ro_broker' ? 'ro' : 'foreign');

/** Romanian-source income: paid in a Romanian account, or the instrument has a Romanian ISIN. */
export function incomeSource(account: Account | undefined, inst: Instrument | undefined, currency: Currency): 'ro' | 'foreign' {
  if (inst?.isin?.toUpperCase().startsWith('RO')) return 'ro';
  if (account?.type === 'ro_broker' || account?.type === 'gov_bonds') return 'ro';
  if (account?.type === 'cash' && currency === 'RON') return 'ro';
  return 'foreign';
}

const isGovInterest = (account: Account | undefined, inst: Instrument | undefined) =>
  account?.type === 'gov_bonds' || inst?.assetClass === 'gov_bond';

export interface SaleRow {
  txId: string;
  date: string;
  accountId: string;
  instrumentId: string;
  category: GainCategory;
  currency: Currency;
  quantity: number;
  proceedsRon: number | null;
  costRon: number | null;
  gainRon: number | null;
  /** Rate used when the yearly average applies */
  avgRate?: number;
  /** Romanian broker only */
  longQty?: number;
  shortQty?: number;
  withheldRon?: number | null;
  expectedWithholdingRon?: number;
  withholdingEstimated?: boolean;
}

export interface IncomeTaxRow {
  txId: string;
  date: string;
  type: 'dividend' | 'interest';
  accountId: string;
  instrumentId?: string;
  source: 'ro' | 'foreign';
  exempt: boolean;
  currency: Currency;
  gross: number;
  withheld: number;
  grossRon: number | null;
  withheldRon: number | null;
  /** Withheld share of gross, for the W-8BEN check */
  withheldRate: number | null;
}

export interface TaxYearInput {
  year: number;
  set: TaxRuleSet;
  /** Ledger computed with the FX source the rule set asks for (see ledgerFx) */
  ledger: Ledger;
  accounts: readonly Account[];
  instruments: readonly Instrument[];
  transactions: readonly Transaction[];
  fx: FxSource;
  averages: Map<Currency, AnnualAverage>;
}

export interface TaxYear {
  year: number;
  set: TaxRuleSet;
  sales: SaleRow[];
  income: IncomeTaxRow[];
  aggregates: TaxAggregates;
  /** Rows left out because a rate was missing */
  missing: string[];
  warnings: string[];
}

/** The FX source to give computeLedger so per-transaction amounts follow the rule set (previous day or not). */
export const ledgerFx = (set: TaxRuleSet, fx: FxSource) => (flag(set, 'fx.prevDay') ? prevDayFx(fx) : fx);

export function buildTaxYear(input: TaxYearInput): TaxYear {
  const { year, set, ledger, fx, averages } = input;
  const accounts = new Map(input.accounts.map(a => [a.id, a]));
  const instruments = new Map(input.instruments.map(i => [i.id, i]));
  const txs = new Map(input.transactions.map(t => [t.id, t]));
  const inYear = (d: string) => d.startsWith(`${year}-`);
  const avg = (cur: Currency) => (cur === 'RON' ? 1 : averages.get(cur)?.rate ?? null);
  const txFx = ledgerFx(set, fx);
  const gainsAvg = pv(set, 'fx.gains') === FX_AVG;
  const incomeAvg = pv(set, 'fx.income') === FX_AVG;
  const holdDays = pv(set, 'cg.ro.holdDays', 365);
  const splits = holdingSplits(input.transactions, holdDays);
  const agg = emptyAggregates();
  const missing: string[] = [];
  const warnings: string[] = [];
  const sales: SaleRow[] = [];
  const income: IncomeTaxRow[] = [];

  for (const r of ledger.realized) {
    if (!inYear(r.date)) continue;
    const category = gainCategory(accounts.get(r.accountId)?.type);
    const row: SaleRow = {
      txId: r.txId, date: r.date, accountId: r.accountId, instrumentId: r.instrumentId, category, currency: r.currency,
      quantity: r.quantity, proceedsRon: r.proceedsRon, costRon: r.costRon, gainRon: r.gainRon,
    };
    if (gainsAvg && r.currency !== 'RON') {
      const a = avg(r.currency);
      row.avgRate = a ?? undefined;
      row.proceedsRon = a === null ? null : r.proceeds * a;
      row.costRon = a === null ? null : r.cost * a;
      row.gainRon = a === null ? null : r.gain * a;
    }
    if (row.gainRon === null) { missing.push(r.txId); sales.push(row); continue; }
    if (category === 'ro') {
      const t = txs.get(r.txId);
      const s = splits.get(r.txId) ?? { longQty: 0, shortQty: r.quantity };
      const total = s.longQty + s.shortQty || r.quantity;
      row.longQty = s.longQty; row.shortQty = s.shortQty;
      const rate = (s.longQty / total) * pv(set, 'cg.ro.rateLong') + (s.shortQty / total) * pv(set, 'cg.ro.rateShort');
      row.expectedWithholdingRon = r2(Math.max(0, row.gainRon) * rate);
      if (r.withheld > 0 && t) {
        const q = txFx.rate(t.currency, t.date);
        row.withheldRon = q ? r2(r.withheld * q.ron) : null;
        if (!q) missing.push(r.txId);
      } else {
        row.withheldRon = row.expectedWithholdingRon;
        row.withholdingEstimated = true;
      }
      agg.roNetGainRon += row.gainRon;
      agg.roWithheldRon += row.withheldRon ?? 0;
    } else {
      agg.foreignNetGainRon += row.gainRon;
    }
    sales.push(row);
  }

  for (const r of ledger.income) {
    if (!inYear(r.date)) continue;
    const account = accounts.get(r.accountId);
    const inst = r.instrumentId ? instruments.get(r.instrumentId) : undefined;
    const source = incomeSource(account, inst, r.currency);
    const exempt = r.type === 'interest' && source === 'ro' && isGovInterest(account, inst) && flag(set, 'int.govExempt');
    let grossRon = r.grossRon, withheldRon = r.withheldRon;
    if (incomeAvg && r.currency !== 'RON') {
      const a = avg(r.currency);
      grossRon = a === null ? null : r.gross * a;
      withheldRon = a === null ? null : r.withheld * a;
    }
    const row: IncomeTaxRow = {
      txId: r.txId, date: r.date, type: r.type, accountId: r.accountId, instrumentId: r.instrumentId, source, exempt,
      currency: r.currency, gross: r.gross, withheld: r.withheld, grossRon, withheldRon,
      withheldRate: r.gross > 0 ? r.withheld / r.gross : null,
    };
    income.push(row);
    if (grossRon === null || withheldRon === null) { missing.push(r.txId); continue; }
    if (exempt) agg.exemptInterestRon += grossRon;
    else if (source === 'ro') {
      if (r.type === 'dividend') { agg.roDividendsRon += grossRon; agg.roDividendsWithheldRon += withheldRon; }
      else { agg.roInterestRon += grossRon; agg.roInterestWithheldRon += withheldRon; }
    } else {
      agg.foreign.push({ kind: r.type, grossRon, withheldRon });
      const treaty = set.params['div.usTreatyRate']?.value;
      if (r.type === 'dividend' && inst?.isin?.toUpperCase().startsWith('US') && treaty !== undefined && row.withheldRate !== null
        && row.withheldRate > treaty + 0.005) {
        warnings.push(`Dividend ${inst.ticker ?? inst.name} din ${r.date.split('-').reverse().join('.')}: reținere ${Math.round(row.withheldRate * 1000) / 10}% > ${Math.round(treaty * 1000) / 10}% (tratat). Verifică formularul W-8BEN.`);
      }
    }
  }

  return { year, set, sales, income, aggregates: agg, missing: [...new Set(missing)], warnings };
}

export interface TaxYearResult extends TaxYear { result: TaxResult; carryIn: LossBucket[]; exactRules: boolean }

/**
 * Every income year from the first one with a sale or income to `lastYear`, in order, so that the loss
 * carry-forward flows from one year to the next. `build(year)` returns that year's data, or null if it has no rules.
 */
export function computeTaxYears(years: number[], build: (year: number) => (TaxYear & { exactRules: boolean }) | null): Map<number, TaxYearResult> {
  const out = new Map<number, TaxYearResult>();
  let carry: LossBucket[] = [];
  for (const year of [...years].sort((a, b) => a - b)) {
    const y = build(year);
    if (!y) continue;
    const result = computeTax(y.set, year, y.aggregates, carry);
    out.set(year, { ...y, result, carryIn: carry });
    carry = result.gains.carryOut;
  }
  return out;
}

// ─── Estimates (planned sales, retirement withdrawals — used by Phase 5) ───

export interface PlannedSale {
  /** Where the sale happens */
  accountType: AccountType;
  /** Gain (negative = loss) in RON */
  gainRon: number;
  /** Romanian broker: days the units were held (decides the withholding rate) */
  holdingDays?: number;
}

export interface EstimateContext {
  year: number;
  /** Everything else of that year that already counts (aggregates of what was realized so far) */
  base?: TaxAggregates;
  carryIn?: LossBucket[];
}

export interface SaleEstimate {
  /** Extra income tax because of the sale (DU tax or RO withholding) */
  incomeTax: number;
  /** Extra CASS because the sale moves the CASS base into a higher tier */
  cassDelta: number;
  total: number;
  before: TaxResult;
  after: TaxResult;
}

const addSale = (base: TaxAggregates, set: TaxRuleSet, sale: PlannedSale): TaxAggregates => {
  const agg = structuredClone(base);
  if (gainCategory(sale.accountType) === 'ro') {
    const long = (sale.holdingDays ?? Infinity) >= pv(set, 'cg.ro.holdDays', 365);
    agg.roNetGainRon += sale.gainRon;
    agg.roWithheldRon += Math.max(0, sale.gainRon) * pv(set, long ? 'cg.ro.rateLong' : 'cg.ro.rateShort');
  } else {
    agg.foreignNetGainRon += sale.gainRon;
  }
  return agg;
};

/** Marginal tax of planned sales on top of what the year already holds. */
export function estimateSales(set: TaxRuleSet, sales: readonly PlannedSale[], ctx: EstimateContext): SaleEstimate {
  const base = ctx.base ?? emptyAggregates();
  const before = computeTax(set, ctx.year, base, ctx.carryIn);
  const after = computeTax(set, ctx.year, sales.reduce((a, s) => addSale(a, set, s), base), ctx.carryIn);
  const incomeTax = r2((after.totalTax - after.cass.due) - (before.totalTax - before.cass.due));
  const cassDelta = r2(after.cass.due - before.cass.due);
  return { incomeTax, cassDelta, total: r2(incomeTax + cassDelta), before, after };
}

export interface WithdrawalInput {
  year: number;
  /** Amount sold from the portfolio this year (RON) */
  withdrawalRon: number;
  /** Share of the amount sold that is gain (0…1): 1 − cost basis / market value */
  gainShare: number;
  accountType?: AccountType;
  holdingDays?: number;
  /** Other investment income of the year (RON) */
  foreignDividendsRon?: number;
  foreignDividendsWithheldRon?: number;
  roDividendsRon?: number;
  interestRon?: number;
  exemptInterestRon?: number;
  carryIn?: LossBucket[];
}

export interface WithdrawalEstimate {
  incomeTax: number;
  cass: number;
  totalTax: number;
  /** Withdrawal + other income − all tax */
  netRon: number;
  effectiveRate: number | null;
  result: TaxResult;
}

/**
 * Yearly tax on a retirement withdrawal financed by selling investments (plus other investment income).
 * Phase 5 calls this for every simulated year with that year's rule set (rulesFor picks the latest known one).
 */
export function estimateWithdrawal(set: TaxRuleSet, w: WithdrawalInput): WithdrawalEstimate {
  const agg = emptyAggregates();
  const gain = w.withdrawalRon * Math.min(1, Math.max(0, w.gainShare));
  const withSale = addSale(agg, set, { accountType: w.accountType ?? 'foreign_broker', gainRon: gain, holdingDays: w.holdingDays });
  withSale.roDividendsRon = w.roDividendsRon ?? 0;
  withSale.roDividendsWithheldRon = (w.roDividendsRon ?? 0) * pv(set, 'div.rate');
  withSale.roInterestRon = w.interestRon ?? 0;
  withSale.roInterestWithheldRon = (w.interestRon ?? 0) * pv(set, 'int.rate');
  withSale.exemptInterestRon = w.exemptInterestRon ?? 0;
  if (w.foreignDividendsRon) withSale.foreign.push({ kind: 'dividend', grossRon: w.foreignDividendsRon, withheldRon: w.foreignDividendsWithheldRon ?? 0 });
  const result = computeTax(set, w.year, withSale, w.carryIn);
  const other = (w.foreignDividendsRon ?? 0) + (w.roDividendsRon ?? 0) + (w.interestRon ?? 0) + (w.exemptInterestRon ?? 0);
  // Foreign tax withheld abroad is a cost too, even the part RO credits
  const abroad = w.foreignDividendsWithheldRon ?? 0;
  const incomeTax = r2(result.totalTax - result.cass.due - result.dividends.credit - result.interest.credit + abroad);
  const totalTax = r2(incomeTax + result.cass.due);
  const gross = w.withdrawalRon + other;
  return {
    incomeTax, cass: result.cass.due, totalTax, netRon: r2(gross - totalTax),
    effectiveRate: gross > 0 ? totalTax / gross : null, result,
  };
}
