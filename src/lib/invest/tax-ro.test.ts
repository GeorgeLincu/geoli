import { describe, it, expect } from 'vitest';
import {
  computeTax, cassFor, holdingSplits, buildTaxYear, computeTaxYears, estimateSales, estimateWithdrawal, rulesFor,
  duDeadline, copyRuleSet, annualAverages, prevDayFx, ledgerFx, emptyAggregates, missingParams, unconfirmedParams,
  FX_AVG, FX_TX, type TaxAggregates, type AnnualAverage,
} from './tax-ro';
import { computeLedger } from './ledger';
import { manualFx } from './fx';
import type { Account, Currency, Instrument, TaxRuleSet, Transaction } from './types';
import type { FxYear } from './market';

// Synthetic rule values chosen to make the arithmetic easy to check. They are NOT the Romanian rules;
// the real, sourced values live in tax-rules.json / tax-ro-defaults.ts.
const P = (value: number) => ({ value });
const set = (over: Record<string, number> = {}, year = 2025): TaxRuleSet => ({
  year, confirmed: false,
  params: Object.fromEntries(Object.entries({
    'cg.foreign.rate': 0.1, 'cg.ro.rateLong': 0.01, 'cg.ro.rateShort': 0.03, 'cg.ro.holdDays': 365,
    'loss.carryYears': 7, 'loss.offsetShare': 1,
    'div.rate': 0.1, 'div.foreignCredit': 1, 'div.usTreatyRate': 0.1,
    'int.rate': 0.1, 'int.govExempt': 1,
    'cass.rate': 0.1, 'cass.minWage': 4000, 'cass.t1': 6, 'cass.t2': 12, 'cass.t3': 24,
    'cass.countRoGains': 1, 'cass.countExemptInterest': 0, 'cass.lossReducesBase': 0, 'cass.netOfWithheld': 0,
    'fx.gains': FX_TX, 'fx.income': FX_TX, 'fx.prevDay': 0, 'du.month': 5, 'du.day': 25,
    ...over,
  }).map(([k, v]) => [k, P(v)])),
});
const agg = (over: Partial<TaxAggregates>): TaxAggregates => ({ ...emptyAggregates(), ...over });

describe('rule sets', () => {
  it('picks the exact year, else the latest earlier one, else the earliest', () => {
    const rules = { version: 1 as const, years: [set({}, 2024), set({}, 2026)] };
    expect(rulesFor(rules, 2026)).toMatchObject({ exact: true, set: { year: 2026 } });
    expect(rulesFor(rules, 2025)).toMatchObject({ exact: false, set: { year: 2024 } });
    expect(rulesFor(rules, 2040)?.set.year).toBe(2026);
    expect(rulesFor(rules, 2020)?.set.year).toBe(2024);
    expect(rulesFor({ version: 1, years: [] }, 2025)).toBeNull();
  });
  it('deadline, copies and confirmation state', () => {
    expect(duDeadline(set(), 2025)).toBe('2026-05-25');
    const s = set();
    s.params['div.rate'].confirmed = true;
    const c = copyRuleSet(s, 2027);
    expect(c.year).toBe(2027);
    expect(c.params['div.rate']).toEqual({ value: 0.1, confirmed: false });
    expect(unconfirmedParams(s)).not.toContain('div.rate');
    expect(unconfirmedParams(s)).toContain('int.rate');
    expect(missingParams(set())).toEqual([]);
    const partial = set();
    delete partial.params['cass.rate'];
    expect(missingParams(partial)).toEqual(['cass.rate']);
  });
});

describe('CASS tiers', () => {
  // min wage 4000 → thresholds 24 000 / 48 000 / 96 000 RON; CASS = 10% of the threshold reached
  it.each([
    [23_999.99, 0, 0],
    [24_000, 1, 2_400],
    [47_999, 1, 2_400],
    [48_000, 2, 4_800],
    [96_000, 3, 9_600],
    [1_000_000, 3, 9_600],
  ])('base %d → tier %d, CASS %d', (base, tier, due) => {
    const c = cassFor(set(), base);
    expect(c.tier).toBe(tier);
    expect(c.due).toBe(due);
    expect(c.thresholds).toEqual([24_000, 48_000, 96_000]);
  });
  it('supports a fourth tier', () => {
    expect(cassFor(set({ 'cass.t4': 60 }), 300_000)).toMatchObject({ tier: 4, due: 24_000 });
  });
});

describe('computeTax — worked examples', () => {
  it('foreign broker: 10% of the yearly net gain, gains and losses netted', () => {
    // +12 000 and −2 000 in the year → net 10 000 → tax 1 000; CASS base 10 000 < 24 000 → 0
    const r = computeTax(set(), 2025, agg({ foreignNetGainRon: 10_000 }));
    expect(r.gains).toMatchObject({ foreignNet: 10_000, taxable: 10_000, tax: 1_000, lossCreated: 0 });
    expect(r.cass.due).toBe(0);
    expect(r.payable).toBe(1_000);
    expect(r.effectiveRate).toBeCloseTo(0.1);
  });

  it('a net loss is carried forward and offsets later gains (oldest first)', () => {
    const y1 = computeTax(set({}, 2024), 2024, agg({ foreignNetGainRon: -5_000 }));
    expect(y1.gains.tax).toBe(0);
    expect(y1.gains.carryOut).toEqual([{ year: 2024, amount: 5_000, expiresAfter: 2031 }]);
    // 2025: gain 8 000 − loss 5 000 → taxable 3 000 → tax 300
    const y2 = computeTax(set(), 2025, agg({ foreignNetGainRon: 8_000 }), y1.gains.carryOut);
    expect(y2.gains).toMatchObject({ lossAvailable: 5_000, lossUsed: 5_000, taxable: 3_000, tax: 300, carryOut: [] });
  });

  it('respects a cap on the share of the gain that losses may offset, and expiry', () => {
    const carry = [{ year: 2018, amount: 1_000, expiresAfter: 2025 }, { year: 2024, amount: 5_000, expiresAfter: 2031 }];
    // cap 70% of 4 000 = 2 800 → 1 000 (2018) + 1 800 (2024); taxable 1 200 → tax 120; 3 200 left
    const r = computeTax(set({ 'loss.offsetShare': 0.7 }), 2025, agg({ foreignNetGainRon: 4_000 }), carry);
    expect(r.gains).toMatchObject({ lossUsed: 2_800, taxable: 1_200, tax: 120 });
    expect(r.gains.carryOut).toEqual([{ year: 2024, amount: 3_200, expiresAfter: 2031 }]);
    // In 2026 the 2018 loss has expired
    const r26 = computeTax(set({}, 2026), 2026, agg({ foreignNetGainRon: 4_000 }), carry);
    expect(r26.gains.lossAvailable).toBe(5_000);
  });

  it('foreign dividends: RO tax on gross minus the tax withheld abroad, capped per payment', () => {
    // US dividend 1 000 RON, 10% withheld (W-8BEN) → RO 10% due 100, credit 100, pay 0
    // Other dividend 500 RON, 25% withheld → due 50, credit capped at 50, pay 0 (the extra 75 is lost)
    // Dividend 200 RON with nothing withheld → pay 20
    const r = computeTax(set(), 2025, agg({ foreign: [
      { kind: 'dividend', grossRon: 1_000, withheldRon: 100 },
      { kind: 'dividend', grossRon: 500, withheldRon: 125 },
      { kind: 'dividend', grossRon: 200, withheldRon: 0 },
    ] }));
    expect(r.dividends).toMatchObject({ foreignGross: 1_700, foreignDue: 170, credit: 150, toPay: 20 });
    // With a 16% rate the US one leaves 60 to pay
    const r16 = computeTax(set({ 'div.rate': 0.16 }), 2025, agg({ foreign: [{ kind: 'dividend', grossRon: 1_000, withheldRon: 100 }] }));
    expect(r16.dividends.toPay).toBe(60);
  });

  it('RO broker and RO dividends are final; they still count for CASS', () => {
    // RO gains 20 000 (withheld 200), RO dividends 10 000 (withheld 1 000) → nothing to pay via DU except CASS:
    // base 30 000 ≥ 24 000 → CASS 2 400
    const r = computeTax(set(), 2025, agg({ roNetGainRon: 20_000, roWithheldRon: 200, roDividendsRon: 10_000, roDividendsWithheldRon: 1_000 }));
    expect(r.gains.tax).toBe(0);
    expect(r.withheld).toBe(1_200);
    expect(r.cass).toMatchObject({ base: 30_000, tier: 1, due: 2_400 });
    expect(r.payable).toBe(2_400);
    expect(r.totalTax).toBe(3_600);
    // If RO gains don't count, the base is 10 000 → no CASS
    expect(computeTax(set({ 'cass.countRoGains': 0 }), 2025, agg({ roNetGainRon: 20_000, roDividendsRon: 10_000 })).cass.due).toBe(0);
  });

  it('CASS base net of withheld tax when the rule says so', () => {
    // RO dividends 30 000 with 3 000 withheld → 27 000; foreign 10 000 with 15% withheld abroad (> 10% RO) → 8 500
    const a = agg({ roDividendsRon: 30_000, roDividendsWithheldRon: 3_000, foreign: [{ kind: 'dividend', grossRon: 10_000, withheldRon: 1_500 }] });
    expect(computeTax(set(), 2025, a).cass.base).toBe(40_000);
    expect(computeTax(set({ 'cass.netOfWithheld': 1 }), 2025, a).cass.base).toBe(35_500);
  });

  it('exempt interest counts for CASS only when the rule says so', () => {
    const a = agg({ exemptInterestRon: 30_000 });
    expect(computeTax(set(), 2025, a).cass.due).toBe(0);
    expect(computeTax(set({ 'cass.countExemptInterest': 1 }), 2025, a).cass.due).toBe(2_400);
  });
});

// ─── From a ledger ───

const accounts: Account[] = [
  { id: 'ib', name: 'Foreign', type: 'foreign_broker', currency: 'EUR' },
  { id: 'ro', name: 'RO', type: 'ro_broker', currency: 'RON' },
  { id: 'gov', name: 'Tezaur', type: 'gov_bonds', currency: 'RON' },
];
const instruments: Instrument[] = [
  { id: 'etf', name: 'ETF', assetClass: 'equity', region: 'global', currency: 'EUR' },
  { id: 'us', ticker: 'USX', isin: 'US0000000001', name: 'US stock', assetClass: 'equity', region: 'us', currency: 'USD' },
  { id: 'bvb', isin: 'RO0000000001', name: 'BVB share', assetClass: 'equity', region: 'romania', currency: 'RON' },
  { id: 'tez', name: 'Tezaur', assetClass: 'gov_bond', region: 'romania', currency: 'RON' },
];
const fx = manualFx([
  { date: '2024-01-01', currency: 'EUR', ron: 5 },
  { date: '2025-03-01', currency: 'EUR', ron: 5.2 },
  { date: '2025-01-01', currency: 'USD', ron: 4.5 },
]);
let n = 0;
const tx = (p: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `t${++n}`, accountId: 'ib', currency: 'EUR', ...p });

describe('holding periods (FIFO lots)', () => {
  it('splits a sale into units held ≥ 365 days and the rest', () => {
    const txs = [
      tx({ id: 'b1', date: '2023-01-10', type: 'buy', accountId: 'ro', instrumentId: 'bvb', quantity: 100, price: 10, currency: 'RON' }),
      tx({ id: 'b2', date: '2024-06-01', type: 'buy', accountId: 'ro', instrumentId: 'bvb', quantity: 100, price: 12, currency: 'RON' }),
      tx({ id: 's1', date: '2025-01-15', type: 'sell', accountId: 'ro', instrumentId: 'bvb', quantity: 150, price: 15, currency: 'RON' }),
    ];
    expect(holdingSplits(txs, 365).get('s1')).toEqual({ longQty: 100, shortQty: 50, firstBuy: '2023-01-10', lastBuy: '2024-06-01' });
  });
});

describe('buildTaxYear — from the ledger', () => {
  const transactions: Transaction[] = [
    // Foreign: buy 10 @ 100 EUR (+0 fees) at 5.0 → cost 5 000 RON; sell 10 @ 150 at 5.2 → 7 800 RON; gain 2 800 RON
    tx({ id: 'fb', date: '2024-05-01', type: 'buy', instrumentId: 'etf', quantity: 10, price: 100 }),
    tx({ id: 'fs', date: '2025-04-01', type: 'sell', instrumentId: 'etf', quantity: 10, price: 150 }),
    // RO: buy 100 @ 10 RON in 2024-02, sell 100 @ 12 in 2025-03 (≥ 365 days) → gain 200, broker withheld 2 RON
    tx({ id: 'rb', date: '2024-02-01', type: 'buy', accountId: 'ro', instrumentId: 'bvb', quantity: 100, price: 10, currency: 'RON' }),
    tx({ id: 'rs', date: '2025-03-01', type: 'sell', accountId: 'ro', instrumentId: 'bvb', quantity: 100, price: 12, currency: 'RON', withheldTax: 2 }),
    // US dividend 100 USD with 30% withheld (no W-8BEN) → warning
    tx({ id: 'd1', date: '2025-06-01', type: 'dividend', instrumentId: 'us', amount: 100, withheldTax: 30, currency: 'USD' }),
    // Tezaur interest 1 000 RON, exempt
    tx({ id: 'i1', date: '2025-07-01', type: 'interest', accountId: 'gov', instrumentId: 'tez', amount: 1_000, currency: 'RON' }),
  ];
  const s = set();
  const ledger = computeLedger({ accounts, instruments, transactions }, ledgerFx(s, fx));

  it('classifies, converts and aggregates', () => {
    const y = buildTaxYear({ year: 2025, set: s, ledger, accounts, instruments, transactions, fx, averages: new Map() });
    expect(y.aggregates.foreignNetGainRon).toBeCloseTo(2_800);
    expect(y.aggregates.roNetGainRon).toBeCloseTo(200);
    expect(y.aggregates.roWithheldRon).toBe(2);
    const rs = y.sales.find(r => r.txId === 'rs')!;
    expect(rs).toMatchObject({ longQty: 100, shortQty: 0, expectedWithholdingRon: 2, withheldRon: 2 });
    expect(rs.withholdingEstimated).toBeUndefined();
    expect(y.aggregates.exemptInterestRon).toBe(1_000);
    expect(y.aggregates.foreign).toEqual([{ kind: 'dividend', grossRon: 450, withheldRon: 135 }]);
    expect(y.warnings).toHaveLength(1);
    expect(y.missing).toEqual([]);

    const r = computeTax(s, 2025, y.aggregates);
    // Gain tax 280; dividend due 45, credit capped at 45 → 0 to pay; CASS base 2 800 + 200 + 450 < 24 000 → 0
    expect(r.gains.tax).toBeCloseTo(280);
    expect(r.dividends).toMatchObject({ foreignDue: 45, credit: 45, toPay: 0 });
    expect(r.payable).toBeCloseTo(280);
  });

  it('estimates the RO withholding when it was not entered', () => {
    const noWh = transactions.map(t => (t.id === 'rs' ? { ...t, withheldTax: undefined } : t));
    const l = computeLedger({ accounts, instruments, transactions: noWh }, fx);
    const y = buildTaxYear({ year: 2025, set: s, ledger: l, accounts, instruments, transactions: noWh, fx, averages: new Map() });
    expect(y.sales.find(r => r.txId === 'rs')).toMatchObject({ withheldRon: 2, withholdingEstimated: true });
  });

  it('can use the yearly average rate instead of the daily one', () => {
    const avgSet = set({ 'fx.gains': FX_AVG, 'fx.income': FX_AVG });
    const averages = new Map<Currency, AnnualAverage>([['EUR', { currency: 'EUR', rate: 5.1, days: 250, source: 'manual' }], ['USD', { currency: 'USD', rate: 4.4, days: 250, source: 'manual' }]]);
    const y = buildTaxYear({ year: 2025, set: avgSet, ledger, accounts, instruments, transactions, fx, averages });
    // gain 500 EUR × 5.1 = 2 550; dividend 100 USD × 4.4 = 440
    expect(y.aggregates.foreignNetGainRon).toBeCloseTo(2_550);
    expect(y.aggregates.foreign[0].grossRon).toBeCloseTo(440);
    // No average for a currency → the row is reported as missing
    const y2 = buildTaxYear({ year: 2025, set: avgSet, ledger, accounts, instruments, transactions, fx, averages: new Map() });
    expect(y2.missing).toContain('fs');
  });

  it('chains years so the loss carry-forward flows', () => {
    const lossTxs: Transaction[] = [
      tx({ id: 'a1', date: '2024-01-02', type: 'buy', instrumentId: 'etf', quantity: 10, price: 100 }),
      tx({ id: 'a2', date: '2024-02-01', type: 'sell', instrumentId: 'etf', quantity: 10, price: 80 }), // −1 000 RON
      tx({ id: 'a3', date: '2025-03-02', type: 'buy', instrumentId: 'etf', quantity: 10, price: 100 }),
      tx({ id: 'a4', date: '2025-04-01', type: 'sell', instrumentId: 'etf', quantity: 10, price: 150 }), // +2 600 RON
    ];
    const l = computeLedger({ accounts, instruments, transactions: lossTxs }, fx);
    const res = computeTaxYears([2025, 2024], year => ({
      ...buildTaxYear({ year, set: set({}, year), ledger: l, accounts, instruments, transactions: lossTxs, fx, averages: new Map() }),
      exactRules: true,
    }));
    expect(res.get(2024)!.result.gains.lossCreated).toBe(1_000);
    expect(res.get(2025)!.result.gains).toMatchObject({ lossUsed: 1_000, taxable: 1_600, tax: 160 });
  });
});

describe('FX helpers', () => {
  it('previous-day rate and yearly averages', () => {
    const f = manualFx([{ date: '2025-03-03', currency: 'EUR', ron: 5 }, { date: '2025-03-04', currency: 'EUR', ron: 6 }]);
    expect(prevDayFx(f).rate('EUR', '2025-03-04')?.ron).toBe(5);
    expect(prevDayFx(f).rate('RON', '2025-03-04')?.ron).toBe(1);
    const doc: FxYear = { version: 1, year: 2025, source: 'BNR', updated: '', rates: { '2025-01-02': { EUR: 5, USD: 4 }, '2025-01-03': { EUR: 5.1 } } };
    const a = annualAverages([doc], 2025);
    expect(a.get('EUR')).toMatchObject({ rate: 5.05, days: 2 });
    expect(a.get('USD')?.rate).toBe(4);
    const manual = annualAverages([doc], 2025, set({ 'fx.avg.EUR': 4.97 }));
    expect(manual.get('EUR')).toMatchObject({ rate: 4.97, source: 'manual' });
  });
});

describe('estimates (planned sales, withdrawals)', () => {
  it('a planned sale can push CASS into the next tier', () => {
    // Already 20 000 of dividends; selling with a 10 000 gain → +1 000 tax and CASS 0 → 2 400
    const e = estimateSales(set(), [{ accountType: 'foreign_broker', gainRon: 10_000 }], { year: 2025, base: agg({ roDividendsRon: 20_000 }) });
    expect(e.incomeTax).toBe(1_000);
    expect(e.cassDelta).toBe(2_400);
    expect(e.total).toBe(3_400);
  });
  it('RO broker sale uses the holding-period rate', () => {
    const short = estimateSales(set(), [{ accountType: 'ro_broker', gainRon: 1_000, holdingDays: 100 }], { year: 2025 });
    const long = estimateSales(set(), [{ accountType: 'ro_broker', gainRon: 1_000, holdingDays: 400 }], { year: 2025 });
    expect(short.incomeTax).toBe(30);
    expect(long.incomeTax).toBe(10);
  });
  it('yearly withdrawal: tax on the gain part only, CASS by tier', () => {
    // Sell 100 000 RON of which 40% is gain → gain 40 000 → tax 4 000; CASS base 40 000 → tier 1 → 2 400
    const w = estimateWithdrawal(set(), { year: 2040, withdrawalRon: 100_000, gainShare: 0.4 });
    expect(w).toMatchObject({ incomeTax: 4_000, cass: 2_400, totalTax: 6_400, netRon: 93_600 });
    expect(w.effectiveRate).toBeCloseTo(0.064);
    // With foreign dividends taxed abroad at 15%: RO tax 10% fully credited, but the 15% abroad is still a cost
    const d = estimateWithdrawal(set(), { year: 2040, withdrawalRon: 0, gainShare: 0, foreignDividendsRon: 1_000, foreignDividendsWithheldRon: 150 });
    expect(d.incomeTax).toBe(150);
    expect(d.netRon).toBe(850);
  });
});

describe('researched defaults', () => {
  it('are valid rule sets, complete, sourced and unconfirmed', async () => {
    const { DEFAULT_RULE_SETS, proposedRuleSet } = await import('./tax-ro-defaults');
    const { validateDoc } = await import('./validate');
    expect(validateDoc('tax-rules', { version: 1, years: DEFAULT_RULE_SETS })).toEqual([]);
    for (const s of DEFAULT_RULE_SETS) {
      expect(missingParams(s)).toEqual([]);
      expect(Object.values(s.params).every(p => p.source && p.verifiedOn)).toBe(true);
    }
    expect(proposedRuleSet(2027)?.year).toBe(2027);
    expect(Object.values(proposedRuleSet(2027)!.params).some(p => p.confirmed)).toBe(false);
    expect(proposedRuleSet(2020)).toBeNull();
  });
});
