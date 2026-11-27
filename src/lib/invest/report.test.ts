import { describe, it, expect } from 'vitest';
import { emptyData, type InvestData, type IpsDoc } from './types';
import { manualFx } from './fx';
import { manualPrices } from './prices';
import {
  portfolioFlows, cashTrackedAccounts, portfolioAt, buildHistory, yearFigures, reportYears, waterfall, waterfallBars,
  monthEnds, ipsCompliance, driftOf, accountValues, fiProgress, ipsVersionOn, netWorthComposition,
} from './report';
import { netWorthAt } from './networth';
import { buildSnapshot, applySnapshotEdit, missingSnapshotYears, snapshotOverrides, snapshotPortfolio } from './snapshots';
import { validateSnapshot } from './validate';

// Invented test data only.
const fx = manualFx([{ date: '2020-01-01', currency: 'EUR', ron: 5 }]);

function sample(): InvestData {
  return {
    ...emptyData(),
    accounts: [
      { id: 'a', name: 'Broker fără cash', type: 'foreign_broker', currency: 'EUR' },
      { id: 'b', name: 'Broker cu cash', type: 'foreign_broker', currency: 'EUR' },
      { id: 'p2', name: 'Pilon 2', type: 'pillar2', currency: 'RON' },
    ],
    instruments: [
      { id: 'w', name: 'World', assetClass: 'equity', region: 'global', currency: 'EUR' },
      { id: 'bd', name: 'Bonds', assetClass: 'bond', region: 'europe', currency: 'EUR' },
    ],
    transactions: [
      { id: 't1', date: '2024-03-10', type: 'buy', accountId: 'a', instrumentId: 'w', quantity: 10, price: 100, fees: 1, currency: 'EUR' },
      { id: 't2', date: '2025-02-01', type: 'deposit', accountId: 'b', amount: 1000, currency: 'EUR' },
      { id: 't3', date: '2025-02-02', type: 'buy', accountId: 'b', instrumentId: 'bd', quantity: 5, price: 100, fees: 2, currency: 'EUR' },
      { id: 't4', date: '2025-06-15', type: 'dividend', accountId: 'a', instrumentId: 'w', amount: 20, withheldTax: 3, currency: 'EUR' },
      { id: 't5', date: '2025-07-01', type: 'buy', accountId: 'a', instrumentId: 'w', quantity: 5, price: 120, currency: 'EUR' },
      { id: 't6', date: '2025-03-01', type: 'deposit', accountId: 'p2', amount: 300, currency: 'RON' },
    ],
    prices: [
      { instrumentId: 'w', date: '2024-12-31', price: 110 },
      { instrumentId: 'w', date: '2025-12-31', price: 130 },
      { instrumentId: 'bd', date: '2025-12-31', price: 90 },
    ],
    pensionValues: [{ id: 'pv', accountId: 'p2', date: '2025-06-30', value: 5000 }],
  };
}
const src = () => ({ fx, prices: manualPrices(sample().prices) });

describe('flows', () => {
  it('cash-tracked accounts use deposits; others use buys, sales and payouts; Pillar 2/3 is out', () => {
    const d = sample();
    expect([...cashTrackedAccounts(d)].sort()).toEqual(['b', 'p2']);
    const { flows } = portfolioFlows(d, fx);
    expect(flows.map(f => [f.txId, f.amount, f.kind])).toEqual([
      ['t1', 1001, 'contribution'],
      ['t2', 1000, 'contribution'],
      ['t4', -17, 'payout'],
      ['t5', 600, 'contribution'],
    ]);
  });

  it('a cash transfer from the portfolio to Pillar 3 is money out', () => {
    const d = sample();
    d.accounts.push({ id: 'p3', name: 'Pilon 3', type: 'pillar3', currency: 'EUR' });
    d.transactions.push({ id: 'tt', date: '2025-08-01', type: 'transfer', accountId: 'b', toAccountId: 'p3', amount: 100, currency: 'EUR' });
    const f = portfolioFlows(d, fx).flows.find(x => x.txId === 'tt')!;
    expect(f.amount).toBe(-100);
  });
});

describe('valuation and year figures', () => {
  it('values the scope at a date (cash of tracked accounts included, Pillar 2/3 out)', () => {
    const p = portfolioAt(sample(), src(), '2025-12-31');
    // a: 15 × 130 = 1950; b: 5 × 90 + cash (1000 − 502) = 948
    expect(p.eur).toBeCloseTo(2898, 6);
    expect(p.ron).toBeCloseTo(2898 * 5, 6);
    expect(p.byClass.equity).toBeCloseTo(1950, 6);
    expect(p.byClass.bond).toBeCloseTo(450, 6);
    expect(p.byClass.cash).toBeCloseTo(498, 6);
  });

  it('month-ends start the month before the first transaction', () => {
    expect(monthEnds('2024-03-10', '2024-05-15')).toEqual(['2024-02-29', '2024-03-31', '2024-04-30', '2024-05-15']);
  });

  it('decomposes a year: start + contributions + income − tax − fees + market − payouts = end', () => {
    const d = sample();
    const h = buildHistory(d, src(), '2025-12-31')!;
    expect(reportYears(h)).toEqual([2025, 2024]);

    const y25 = yearFigures(d, fx, h, 2025)!;
    expect(y25.complete).toBe(true);
    expect(y25.startEur).toBeCloseTo(1100, 6);
    expect(y25.endEur).toBeCloseTo(2898, 6);
    expect(y25.contributedIn).toBeCloseTo(1600, 6);
    expect(y25.payouts).toBeCloseTo(17, 6);
    expect(y25.income).toBeCloseTo(20, 6);
    expect(y25.withheld).toBeCloseTo(3, 6);
    expect(y25.fees).toBeCloseTo(2, 6);
    // Price changes: w 10×(130−110) + 5×(130−120) = 250; bd 5×(90−100) = −50 → 200
    expect(y25.market).toBeCloseTo(200, 6);
    const steps = waterfallBars(waterfall(y25));
    const deltas = steps.filter(s => s.kind === 'delta').reduce((s, x) => s + x.value, 0);
    expect(y25.startEur + deltas).toBeCloseTo(y25.endEur, 6);
    expect(y25.months).toHaveLength(12);
    expect(y25.twr).not.toBeNull();
    expect(y25.xirr).not.toBeNull();

    const y24 = yearFigures(d, fx, h, 2024)!;
    expect(y24.startEur).toBe(0);
    expect(y24.contributedIn).toBeCloseTo(1001, 6);
    expect(y24.market).toBeCloseTo(100, 6);
    // Bought at 100.1 (with the fee), worth 110: the money-weighted return of the period is ~ +9.9%
    expect(y24.xirr!).toBeCloseTo(1100 / 1001 - 1, 2);
  });

  it('a part year ends today', () => {
    const d = sample();
    const h = buildHistory(d, src(), '2025-08-15')!;
    const y = yearFigures(d, fx, h, 2025)!;
    expect(y.complete).toBe(false);
    expect(y.end).toBe('2025-08-15');
    expect(y.months.at(-1)!.month).toBe('2025-08');
  });

  it('a corrected snapshot value replaces the computed year-end value', () => {
    const d = sample();
    const h = buildHistory(d, src(), '2025-12-31', new Map([['2024-12-31', 1200]]))!;
    expect(yearFigures(d, fx, h, 2025)!.startEur).toBe(1200);
    expect(yearFigures(d, fx, h, 2024)!.market).toBeCloseTo(200, 6);
  });

  it('no history before the first transaction', () => {
    const d = sample();
    const h = buildHistory(d, src(), '2025-12-31')!;
    expect(yearFigures(d, fx, h, 2023)).toBeNull();
    expect(buildHistory(emptyData(), src(), '2025-12-31')).toBeNull();
  });
});

describe('IPS compliance and FI', () => {
  const ips: IpsDoc = {
    version: 1,
    versions: [
      { date: '2024-01-01', sections: {}, rules: { contribution: { amount: 500, day: 10 }, reviewMonth: 6, driftAlerts: true } },
      { date: '2026-02-01', sections: {}, rules: {} },
    ],
  };

  it('uses the version in force at the year end', () => {
    expect(ipsVersionOn(ips, '2025-12-31')!.date).toBe('2024-01-01');
    expect(ipsVersionOn(ips, '2023-12-31')).toBeNull();
  });

  it('counts the months with the planned contribution and flags a missed review', () => {
    const d = sample();
    d.targets = [{ id: 'eq', label: 'Acțiuni', assetClass: 'equity', weight: 0.8, band: 0.05 }, { id: 'bo', label: 'Obligațiuni', assetClass: 'bond', weight: 0.2 }];
    const p = portfolioAt(d, src(), '2025-12-31');
    const drift = driftOf(p.holdings.filter(h => h.assetClass !== 'cash'), d.targets);
    const c = ipsCompliance(ips, d, fx, 2025, '2025-12-31', drift, accountValues(p.holdings));
    const byKey = Object.fromEntries(c.items.map(i => [i.key, i]));
    // Deposit 1000 in Feb (deposits count), buy 600 in Jul → 2 of 12 months
    expect(byKey.contribution.detail).toContain('2 din 12');
    expect(byKey.contribution.status).toBe('warn');
    expect(byKey.review.status).toBe('warn');
    // equity 1950/2400 = 81.25% (band ±5) ok; bond 18.75% vs 20% ok
    expect(byKey.drift.status).toBe('ok');
  });

  it('FI progress from the plan settings', () => {
    const fi = fiProgress({ baseCurrency: 'EUR', retirementSpending: 20_000, swr: 0.04 }, [], 2025, 50_000)!;
    expect(fi.fiNumber).toBe(500_000);
    expect(fi.progress).toBeCloseTo(0.1, 10);
    expect(fiProgress({ baseCurrency: 'EUR' }, [], 2025, 1)).toBeNull();
  });
});

describe('snapshots', () => {
  it('builds a valid snapshot and keeps George\'s fields on recalculation', () => {
    const d = sample();
    const p = portfolioAt(d, src(), '2025-12-31');
    const nw = netWorthAt(d, src(), '2025-12-31');
    const s1 = buildSnapshot(2025, p, nw, '2026-01-05T10:00:00.000Z');
    expect(validateSnapshot(2025, s1)).toEqual([]);
    expect(s1.computed.portfolioEur).toBe(2898);
    // Net worth includes Pillar 2 (5000 RON = 1000 EUR)
    expect(s1.computed.netWorthEur).toBe(3898);

    const edited = applySnapshotEdit(s1, { portfolioEur: '2 900,5', netWorthEur: '', inflationPct: '5,1', inflationSource: 'INS', note: ' ok ' }, '2026-01-06T00:00:00.000Z');
    expect(edited.problems).toEqual([]);
    expect(edited.snapshot.portfolioEur).toBe(2900.5);
    expect(edited.snapshot.inflation).toEqual({ rate: 0.051, source: 'INS' });
    expect(edited.snapshot.note).toBe('ok');
    expect(snapshotPortfolio(edited.snapshot)).toBe(2900.5);
    expect(snapshotOverrides([edited.snapshot]).get('2025-12-31')).toBe(2900.5);

    const s2 = buildSnapshot(2025, p, nw, '2026-02-01T00:00:00.000Z', edited.snapshot);
    expect(s2.createdAt).toBe(s1.createdAt);
    expect(s2.portfolioEur).toBe(2900.5);
    expect(s2.inflation?.rate).toBe(0.051);
    expect(validateSnapshot(2025, s2)).toEqual([]);
    expect(validateSnapshot(2024, s2)).not.toEqual([]);
  });

  it('rejects bad edits', () => {
    const p = portfolioAt(sample(), src(), '2025-12-31');
    const s = buildSnapshot(2025, p, netWorthAt(sample(), src(), '2025-12-31'), 'x');
    const r = applySnapshotEdit(s, { portfolioEur: 'abc', netWorthEur: '', inflationPct: '', inflationSource: 'INS', note: '' }, 'y');
    expect(r.problems).toHaveLength(2);
  });

  it('lists closed years without a snapshot', () => {
    const s = { year: 2024 } as never;
    expect(missingSnapshotYears([2026, 2025, 2024, 2023], [s], '2026-03-01')).toEqual([2023, 2025]);
  });
});

describe('net worth composition (dashboard)', () => {
  it('splits by asset class, includes Pillar 2/3 and other assets, debts below zero; total = netWorthAt', () => {
    const d = sample();
    d.netWorth = {
      assets: [
        { id: 'sv', name: 'Depozit', category: 'savings', currency: 'EUR', values: [{ date: '2025-01-01', value: 2000 }] },
        { id: 'car', name: 'Mașină', category: 'vehicle', currency: 'EUR', values: [{ date: '2025-01-01', value: 5000 }] },
      ],
      liabilities: [{ id: 'l', name: 'Credit', kind: 'loan', currency: 'EUR', balances: [{ date: '2025-01-01', value: 3000 }] }],
    };
    const c = netWorthComposition(d, src(), '2025-12-31');
    expect(c.parts.equity).toBeCloseTo(1950, 6);
    expect(c.parts.bond).toBeCloseTo(450, 6);
    expect(c.parts.cash).toBeCloseTo(498 + 2000, 6);
    expect(c.parts.pension).toBeCloseTo(1000, 6);
    expect(c.parts.other).toBeCloseTo(5000, 6);
    expect(c.parts.debts).toBeCloseTo(-3000, 6);
    expect(c.netEur).toBeCloseTo(netWorthAt(d, src(), '2025-12-31').netEur, 6);
  });
});
