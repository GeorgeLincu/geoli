import { describe, it, expect } from 'vitest';
import { computeLedger, yearTotals, sortTransactions } from './ledger';
import { manualFx, chainFx, convert, tableFx } from './fx';
import { manualPrices, chainPrices, tablePrices } from './prices';
import type { Account, Instrument, Transaction } from './types';

// Synthetic test data only (no real holdings).
const accounts: Account[] = [
  { id: 'fb', name: 'Foreign', type: 'foreign_broker', currency: 'EUR' },
  { id: 'ro', name: 'RO', type: 'ro_broker', currency: 'RON' },
  { id: 'fb2', name: 'Foreign 2', type: 'foreign_broker', currency: 'EUR' },
];
const instruments: Instrument[] = [
  { id: 'etf', name: 'ETF A', assetClass: 'equity', region: 'global', currency: 'EUR' },
  { id: 'us', name: 'Stock US', assetClass: 'equity', region: 'us', currency: 'USD' },
  { id: 'bvb', name: 'BVB share', assetClass: 'equity', region: 'romania', currency: 'RON' },
];
const fx = manualFx([
  { date: '2025-01-01', currency: 'EUR', ron: 5 },
  { date: '2025-06-01', currency: 'EUR', ron: 5.1 },
  { date: '2025-01-01', currency: 'USD', ron: 4.5 },
]);
let n = 0;
const tx = (p: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction =>
  ({ id: `t${++n}`, accountId: 'fb', currency: 'EUR', ...p });

describe('fx', () => {
  it('uses the latest rate on or before the date; RON is 1', () => {
    expect(fx.rate('EUR', '2025-03-10')?.ron).toBe(5);
    expect(fx.rate('EUR', '2025-06-01')?.ron).toBe(5.1);
    expect(fx.rate('EUR', '2024-12-31')).toBeNull();
    expect(fx.rate('RON', '1999-01-01')?.ron).toBe(1);
    expect(fx.rate('GBP', '2025-03-10')).toBeNull();
  });
  it('converts through RON and chains sources', () => {
    expect(convert(fx, 100, 'EUR', 'RON', '2025-02-01')).toBe(500);
    expect(convert(fx, 90, 'USD', 'EUR', '2025-02-01')).toBeCloseTo(81);
    expect(convert(fx, 1, 'GBP', 'EUR', '2025-02-01')).toBeNull();
    const auto = tableFx([{ date: '2025-01-02', currency: 'GBP', ron: 6 }], 'bnr');
    const both = chainFx(auto, fx);
    expect(both.rate('GBP', '2025-02-01')).toEqual({ ron: 6, date: '2025-01-02', source: 'bnr' });
    expect(both.rate('EUR', '2025-02-01')?.source).toBe('manual');
  });
});

describe('prices', () => {
  it('latest manual price on or before the date, manual overrides auto', () => {
    const m = manualPrices([{ instrumentId: 'etf', date: '2025-05-01', price: 110 }]);
    const auto = tablePrices([{ instrumentId: 'etf', date: '2025-05-02', price: 111 }, { instrumentId: 'us', date: '2025-05-02', price: 50 }], 'auto');
    expect(m.price('etf', '2025-04-30')).toBeNull();
    expect(chainPrices(m, auto).price('etf', '2025-06-01')?.price).toBe(110);
    expect(chainPrices(m, auto).price('us', '2025-06-01')?.source).toBe('auto');
  });
});

describe('computeLedger — weighted-average cost', () => {
  it('averages buys including fees; a sale keeps the average and books the gain', () => {
    const transactions = [
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'etf', quantity: 10, price: 100, fees: 2 }),
      tx({ date: '2025-03-01', type: 'buy', instrumentId: 'etf', quantity: 10, price: 120, fees: 2 }),
      tx({ date: '2025-07-01', type: 'sell', instrumentId: 'etf', quantity: 5, price: 130, fees: 1 }),
    ];
    const l = computeLedger({ accounts, instruments, transactions }, fx);
    const p = l.positions[0];
    // cost = 1002 + 1202 = 2204 for 20 units → 110.2 each
    expect(p.quantity).toBe(15);
    expect(p.avgCost).toBeCloseTo(110.2);
    expect(p.cost).toBeCloseTo(15 * 110.2);
    // RON cost at the buy-date rate (5): 2204 × 5 = 11020 → 551 per unit
    expect(p.avgCostRon).toBeCloseTo(551);

    const g = l.realized[0];
    expect(g.proceeds).toBe(649); // 5 × 130 − 1
    expect(g.cost).toBeCloseTo(551);
    expect(g.gain).toBeCloseTo(98);
    // RON: proceeds at sale-date rate 5.1, cost at the buy rates
    expect(g.proceedsRon).toBeCloseTo(649 * 5.1);
    expect(g.costRon).toBeCloseTo(5 * 551);
    expect(g.gainRon).toBeCloseTo(649 * 5.1 - 2755);
    expect(l.warnings).toEqual([]);
  });

  it('a full sale closes the position; a later buy starts a fresh average', () => {
    const transactions = [
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'etf', quantity: 2, price: 100 }),
      tx({ date: '2025-02-10', type: 'sell', instrumentId: 'etf', quantity: 2, price: 90 }),
      tx({ date: '2025-02-20', type: 'buy', instrumentId: 'etf', quantity: 1, price: 50 }),
    ];
    const l = computeLedger({ accounts, instruments, transactions }, fx);
    expect(l.realized[0].gain).toBeCloseTo(-20);
    expect(l.positions).toHaveLength(1);
    expect(l.positions[0].avgCost).toBe(50);
  });

  it('keeps averages separate per account and handles foreign currency', () => {
    const transactions = [
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'us', quantity: 4, price: 25, currency: 'USD' }),
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'bvb', quantity: 100, price: 2, accountId: 'ro', currency: 'RON', fees: 1 }),
    ];
    const l = computeLedger({ accounts, instruments, transactions }, fx);
    const us = l.positions.find(p => p.instrumentId === 'us')!;
    expect(us.currency).toBe('USD');
    expect(us.costRon).toBeCloseTo(450);
    const bvb = l.positions.find(p => p.instrumentId === 'bvb')!;
    expect(bvb.avgCost).toBeCloseTo(2.01);
    expect(bvb.avgCostRon).toBeCloseTo(2.01);
  });

  it('processes same-day transactions in entry order and ignores later ones with asOf', () => {
    const transactions = [
      tx({ date: '2025-03-01', type: 'sell', instrumentId: 'etf', quantity: 1, price: 10 }),
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'etf', quantity: 1, price: 10 }),
    ];
    expect(sortTransactions(transactions).map(t => t.date)).toEqual(['2025-02-01', '2025-03-01']);
    const l = computeLedger({ accounts, instruments, transactions }, fx, '2025-02-15');
    expect(l.positions[0].quantity).toBe(1);
    expect(l.realized).toHaveLength(0);
  });

  it('warns when selling more than held and only books what is held', () => {
    const transactions = [
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'etf', quantity: 1, price: 100 }),
      tx({ date: '2025-02-02', type: 'sell', instrumentId: 'etf', quantity: 2, price: 110 }),
    ];
    const l = computeLedger({ accounts, instruments, transactions }, fx);
    expect(l.warnings).toHaveLength(1);
    expect(l.realized[0].quantity).toBe(1);
    expect(l.realized[0].gain).toBeCloseTo(10);
  });

  it('marks RON values unknown when a rate is missing', () => {
    const transactions = [tx({ date: '2024-06-01', type: 'buy', instrumentId: 'etf', quantity: 1, price: 100 })];
    const l = computeLedger({ accounts, instruments, transactions }, fx);
    expect(l.positions[0].costRon).toBeNull();
    expect(l.warnings[0].message).toMatch(/curs/);
  });
});

describe('computeLedger — income, fees, cash, transfers', () => {
  it('records dividends with withheld tax and tracks cash', () => {
    const transactions = [
      tx({ date: '2025-01-05', type: 'deposit', amount: 1000 }),
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'etf', quantity: 5, price: 100, fees: 1 }),
      tx({ date: '2025-04-01', type: 'dividend', instrumentId: 'us', amount: 10, withheldTax: 1.5, currency: 'USD' }),
      tx({ date: '2025-04-02', type: 'fee', amount: 3 }),
      tx({ date: '2025-08-01', type: 'interest', amount: 4, accountId: 'ro', currency: 'RON', withheldTax: 0.4 }),
    ];
    const l = computeLedger({ accounts, instruments, transactions }, fx);
    const div = l.income.find(i => i.type === 'dividend')!;
    expect(div.net).toBe(8.5);
    expect(div.grossRon).toBeCloseTo(45);
    expect(div.withheldRon).toBeCloseTo(6.75);
    expect(l.cash.find(c => c.accountId === 'fb' && c.currency === 'EUR')!.amount).toBeCloseTo(1000 - 501 - 3);
    expect(l.cash.find(c => c.currency === 'USD')!.amount).toBeCloseTo(8.5);
    expect(l.cashTracked.has('fb')).toBe(true);
    expect(l.cashTracked.has('ro')).toBe(false);

    const y = yearTotals(l, 2025);
    expect(y.divRon).toBeCloseTo(45);
    expect(y.divTaxRon).toBeCloseTo(6.75);
    expect(y.intRon).toBeCloseTo(4);
    expect(y.feesRon).toBeCloseTo(15);
    expect(y.missing).toBe(0);
  });

  it('transfers securities with their average cost, and cash between accounts', () => {
    const transactions = [
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'etf', quantity: 10, price: 100 }),
      tx({ date: '2025-03-01', type: 'transfer', instrumentId: 'etf', quantity: 4, toAccountId: 'fb2' }),
      tx({ date: '2025-03-02', type: 'transfer', amount: 50, toAccountId: 'fb2' }),
    ];
    const l = computeLedger({ accounts, instruments, transactions }, fx);
    const a = l.positions.find(p => p.accountId === 'fb')!;
    const b = l.positions.find(p => p.accountId === 'fb2')!;
    expect(a.quantity).toBe(6);
    expect(b.quantity).toBe(4);
    expect(b.avgCost).toBe(100);
    expect(b.costRon).toBeCloseTo(2000);
    expect(l.cash.find(c => c.accountId === 'fb2')!.amount).toBe(50);
  });

  it('splits realized gains and losses per year in RON', () => {
    const transactions = [
      tx({ date: '2025-02-01', type: 'buy', instrumentId: 'bvb', accountId: 'ro', currency: 'RON', quantity: 10, price: 10 }),
      tx({ date: '2025-03-01', type: 'sell', instrumentId: 'bvb', accountId: 'ro', currency: 'RON', quantity: 5, price: 12 }),
      tx({ date: '2025-04-01', type: 'sell', instrumentId: 'bvb', accountId: 'ro', currency: 'RON', quantity: 5, price: 9 }),
    ];
    const y = yearTotals(computeLedger({ accounts, instruments, transactions }, fx), 2025);
    expect(y.gainRon).toBeCloseTo(10);
    expect(y.lossRon).toBeCloseTo(-5);
    expect(y.netGainRon).toBeCloseTo(5);
  });
});
