import { describe, it, expect } from 'vitest';
import { computeLedger } from './ledger';
import { manualFx } from './fx';
import { manualPrices } from './prices';
import { valuePortfolio, computeDrift, matchTarget, rebalanceWithContribution, bondLadder, allocationTree, type Holding } from './portfolio';
import { transactionsCsv } from './csv';
import { emptyData, type InvestData, type TargetAllocation } from './types';
import { validateDoc } from './validate';

// Synthetic test data only (no real holdings).
const data: InvestData = {
  ...emptyData(),
  accounts: [
    { id: 'fb', name: 'Foreign', type: 'foreign_broker', currency: 'EUR' },
    { id: 'gb', name: 'Bonds', type: 'gov_bonds', currency: 'RON' },
    { id: 'p2', name: 'Pilon 2', type: 'pillar2', currency: 'RON' },
  ],
  instruments: [
    { id: 'etf', name: 'ETF A', assetClass: 'equity', region: 'global', currency: 'EUR' },
    { id: 'tz', name: 'Tezaur X', assetClass: 'gov_bond', region: 'romania', currency: 'RON', faceValue: 1, coupon: 0.06, maturity: '2027-05-01' },
  ],
  transactions: [
    { id: 't1', date: '2025-01-10', type: 'deposit', accountId: 'fb', amount: 1000, currency: 'EUR' },
    { id: 't2', date: '2025-01-11', type: 'buy', accountId: 'fb', instrumentId: 'etf', quantity: 8, price: 100, currency: 'EUR' },
    { id: 't3', date: '2025-02-01', type: 'buy', accountId: 'gb', instrumentId: 'tz', quantity: 5000, price: 1, currency: 'RON' },
  ],
  prices: [{ instrumentId: 'etf', date: '2025-06-01', price: 125 }],
  fxRates: [{ date: '2025-01-01', currency: 'EUR', ron: 5 }],
  pensionValues: [
    { id: 'v1', accountId: 'p2', date: '2025-03-31', value: 9000 },
    { id: 'v2', accountId: 'p2', date: '2025-06-30', value: 10000 },
  ],
};
const fx = manualFx(data.fxRates);

describe('valuePortfolio', () => {
  const l = computeLedger(data, fx);
  const v = valuePortfolio(data, l, manualPrices(data.prices), fx, '2025-07-01');

  it('values positions at market, bonds at face value, cash and pension', () => {
    const etf = v.holdings.find(h => h.instrumentId === 'etf')!;
    expect(etf.basis).toBe('market');
    expect(etf.value).toBe(1000);
    expect(etf.unrealized).toBe(200);
    const tz = v.holdings.find(h => h.instrumentId === 'tz')!;
    expect(tz.basis).toBe('face');
    expect(tz.valueEur).toBe(1000);
    expect(v.holdings.find(h => h.kind === 'cash')!.value).toBe(200);
    expect(v.holdings.find(h => h.kind === 'pension')!.value).toBe(10000);
    // 1000 + 200 + 1000 (5000 RON) + 2000 (10000 RON)
    expect(v.totalEur).toBeCloseTo(4200);
    expect(v.totalRon).toBeCloseTo(21000);
    expect(v.missingFx).toEqual([]);
  });

  it('falls back to average cost when there is no price', () => {
    const v0 = valuePortfolio(data, l, manualPrices([]), fx, '2025-07-01');
    expect(v0.holdings.find(h => h.instrumentId === 'etf')!.basis).toBe('cost');
  });

  it('builds a class → region → leaf tree', () => {
    const tree = allocationTree(v.holdings, h => h.instrumentId ?? h.kind);
    const eq = tree.find(n => n.name === 'equity')!;
    expect(eq.value).toBe(1000);
    expect(eq.children![0].children![0]).toEqual({ name: 'etf', value: 1000 });
  });
});

describe('targets and drift', () => {
  const targets: TargetAllocation[] = [
    { id: 'a', label: 'ETF A', assetClass: 'equity', instrumentId: 'etf', weight: 0.6, band: 0.05 },
    { id: 'b', label: 'Equity RO', assetClass: 'equity', region: 'romania', weight: 0.1 },
    { id: 'c', label: 'Bonds', assetClass: 'gov_bond', weight: 0.3, band: 0.05 },
  ];
  it('matches the most specific row', () => {
    expect(matchTarget({ instrumentId: 'etf', assetClass: 'equity', region: 'global' }, targets)?.id).toBe('a');
    expect(matchTarget({ instrumentId: 'x', assetClass: 'equity', region: 'romania' }, targets)?.id).toBe('b');
    expect(matchTarget({ instrumentId: 'y', assetClass: 'gov_bond', region: 'romania' }, targets)?.id).toBe('c');
    expect(matchTarget({ assetClass: 'gold', region: 'global' }, targets)).toBeNull();
  });
  it('computes weights and band status', () => {
    const h = (id: string, assetClass: Holding['assetClass'], region: Holding['region'], v: number) =>
      ({ key: id, kind: 'position', accountId: 'fb', instrumentId: id, assetClass, region, currency: 'EUR', basis: 'market', value: v, valueEur: v, valueRon: v * 5 }) as Holding;
    const d = computeDrift([h('etf', 'equity', 'global', 700), h('tz', 'gov_bond', 'romania', 200), h('g', 'gold', 'global', 100)], targets);
    // gold matches no row: reported apart and left out of the weights
    expect(d.total).toBe(900);
    expect(d.unmatched).toBe(100);
    expect(d.weightSum).toBeCloseTo(1);
    const [a, b, c] = d.rows;
    expect(a.actualWeight).toBeCloseTo(700 / 900);
    expect(a.status).toBe('over');
    expect(b.status).toBe('under'); // 0 vs 10% with default band 5 pp
    expect(c.diff).toBeCloseTo(200 / 900 - 0.3);
    expect(c.status).toBe('under');
  });
});

describe('rebalanceWithContribution', () => {
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + x, 0);
  it('puts everything into the most underweight row first', () => {
    const r = rebalanceWithContribution([{ id: 'eq', weight: 0.8, value: 8000 }, { id: 'bd', weight: 0.2, value: 1000 }], 500);
    expect(r.get('eq')).toBe(0);
    expect(r.get('bd')).toBeCloseTo(500);
  });
  it('reaches the target exactly when the contribution is large enough, then splits by weight', () => {
    // total after = 10000 + 2000 = 12000 → targets 9600 / 2400
    const r = rebalanceWithContribution([{ id: 'eq', weight: 0.8, value: 9000 }, { id: 'bd', weight: 0.2, value: 1000 }], 2000);
    expect(r.get('eq')).toBeCloseTo(600);
    expect(r.get('bd')).toBeCloseTo(1400);
    expect(sum(r)).toBeCloseTo(2000);
  });
  it('splits partially between several underweight rows and never sells', () => {
    const r = rebalanceWithContribution([
      { id: 'a', weight: 0.5, value: 4000 }, { id: 'b', weight: 0.3, value: 1000 }, { id: 'c', weight: 0.2, value: 1000 },
    ], 600);
    // b is lowest (1000/0.3 = 3333), c next (5000), a (8000). Lift b to level 5000 costs 500, then b+c share 100.
    expect(r.get('a')).toBe(0);
    expect(r.get('b')).toBeCloseTo(500 + 60);
    expect(r.get('c')).toBeCloseTo(40);
    expect(sum(r)).toBeCloseTo(600);
    for (const x of r.values()) expect(x).toBeGreaterThanOrEqual(0);
  });
  it('normalises weights and handles empty input', () => {
    const r = rebalanceWithContribution([{ id: 'a', weight: 2, value: 0 }, { id: 'b', weight: 2, value: 0 }], 100);
    expect(r.get('a')).toBeCloseTo(50);
    expect(rebalanceWithContribution([], 100).size).toBe(0);
    expect(rebalanceWithContribution([{ id: 'a', weight: 1, value: 0 }], 0).get('a')).toBe(0);
  });
});

describe('bondLadder', () => {
  it('lists bonds by maturity with face value and coupon', () => {
    const l = computeLedger(data, fx);
    const rows = bondLadder(data, l, fx, '2025-07-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instrumentId: 'tz', face: 5000, yearlyCoupon: 300, faceRon: 5000, matured: false });
    expect(bondLadder(data, l, fx, '2027-05-01')[0].matured).toBe(true);
  });
});

describe('csv and schema', () => {
  it('exports transactions with ; and decimal commas', () => {
    const csv = transactionsCsv({ ...data, transactions: [{ ...data.transactions[1], price: 100.5, note: 'a;b "c"' }] });
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0].startsWith('data;tip;cont')).toBe(true);
    expect(lines[1]).toContain('2025-01-11;buy;Foreign;ETF A');
    expect(lines[1]).toContain(';100,5;');
    expect(lines[1]).toContain('"a;b ""c"""');
  });
  it('the extended data document validates', () => {
    expect(validateDoc('data', data)).toEqual([]);
    expect(validateDoc('data', { ...data, fxRates: [{ date: '2025-01-01', currency: 'XYZ', ron: 1 }] })).not.toEqual([]);
  });
});
