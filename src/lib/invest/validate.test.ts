import { describe, it, expect } from 'vitest';
import { validateDoc, isDocName } from './validate';
import { emptyData, emptyTaxRules, emptyIps } from './types';

describe('validateDoc', () => {
  it('accepts the empty documents', () => {
    expect(validateDoc('data', emptyData())).toEqual([]);
    expect(validateDoc('tax-rules', emptyTaxRules())).toEqual([]);
    expect(validateDoc('ips', emptyIps())).toEqual([]);
  });

  it('accepts a realistic data document', () => {
    const doc = {
      ...emptyData(),
      accounts: [{ id: 'a1', name: 'Broker', type: 'foreign_broker', currency: 'EUR' }],
      instruments: [{ id: 'i1', name: 'Fund', assetClass: 'equity', region: 'global', currency: 'EUR', distribution: 'accumulating' }],
      transactions: [{ id: 't1', date: '2026-01-15', type: 'buy', accountId: 'a1', instrumentId: 'i1', quantity: 2, price: 100, currency: 'EUR', fees: 1 }],
      targets: [{ id: 'g1', label: 'Equity', assetClass: 'equity', weight: 1, band: 0.05 }],
    };
    expect(validateDoc('data', doc)).toEqual([]);
  });

  it('rejects wrong shapes, unknown fields and bad values', () => {
    expect(validateDoc('data', null)).not.toEqual([]);
    expect(validateDoc('data', [])).not.toEqual([]);
    expect(validateDoc('data', { ...emptyData(), version: 2 })).toContain('data.version: must be 1');
    expect(validateDoc('data', { ...emptyData(), extra: 1 })).toContain('data.extra: unknown field');

    const badTx = { ...emptyData(), transactions: [{ id: 't1', date: '15.01.2026', type: 'gift', accountId: 'a1', currency: 'XYZ', price: 'x' }] };
    const errs = validateDoc('data', badTx);
    expect(errs.some(e => e.includes('date'))).toBe(true);
    expect(errs.some(e => e.includes('type'))).toBe(true);
    expect(errs.some(e => e.includes('currency'))).toBe(true);
    expect(errs.some(e => e.includes('price'))).toBe(true);
  });

  it('rejects non-finite numbers', () => {
    const doc = { ...emptyData(), settings: { baseCurrency: 'EUR', swr: Infinity } };
    expect(validateDoc('data', doc)).toContain('data.settings.swr: number expected');
  });

  it('validates tax parameters with provenance', () => {
    const ok = { version: 1, years: [{ year: 2026, confirmed: false, params: { cassRate: { value: 0.1, source: 'https://example.org', verifiedOn: '2026-11-27' } } }] };
    expect(validateDoc('tax-rules', ok)).toEqual([]);
    const bad = { version: 1, years: [{ year: 2026, confirmed: false, params: { 'bad name!': { value: '10%' } } }] };
    expect(validateDoc('tax-rules', bad).length).toBeGreaterThanOrEqual(2);
  });

  it('knows the document names', () => {
    expect(isDocName('data')).toBe(true);
    expect(isDocName('../secret')).toBe(false);
  });
});

describe('validateDoc: plan projection settings', () => {
  it('accepts projection settings and rejects unknown classes or modes', () => {
    const ok = {
      ...emptyData(),
      settings: {
        baseCurrency: 'EUR', birthYear: 1990,
        projection: {
          planToAge: 90, correlation: 0.3, mcMode: 'bootstrap', mcRuns: 5000, mcSeed: 1,
          assumptions: { equity: { ret: 0.05, vol: 0.16 } }, weights: { equity: 0.8, bond: 0.2 },
          history: [{ year: 2000, returns: { equity: -0.1 } }], historySource: 'https://example.org',
        },
      },
    };
    expect(validateDoc('data', ok)).toEqual([]);
    const bad = { ...ok, settings: { ...ok.settings, projection: { weights: { crypto: 1 }, mcMode: 'x', assumptions: { equity: { ret: 0.05 } } } } };
    const errs = validateDoc('data', bad);
    expect(errs).toContain('data.settings.projection.weights.crypto: unknown asset class');
    expect(errs.some(e => e.includes('mcMode'))).toBe(true);
    expect(errs).toContain('data.settings.projection.assumptions.equity.vol: required');
  });
});

describe('validateDoc — net worth', () => {
  const nw = {
    assets: [{ id: 'n1', name: 'Bank', category: 'savings', currency: 'RON', emergency: true, values: [{ date: '2026-01-31', value: 1000 }] }],
    liabilities: [{ id: 'l1', name: 'Mortgage', kind: 'mortgage', currency: 'EUR', rate: 0.05, monthlyPayment: 500, balances: [{ date: '2026-01-31', value: 90000, note: 'bank statement' }] }],
    monthlyExpenses: 2000,
  };
  it('accepts assets, liabilities and monthly expenses', () => {
    expect(validateDoc('data', { ...emptyData(), netWorth: nw })).toEqual([]);
    expect(validateDoc('data', { ...emptyData(), netWorth: { assets: [], liabilities: [] } })).toEqual([]);
  });
  it('rejects bad categories, negative values and rates above 100%', () => {
    const bad = {
      assets: [{ ...nw.assets[0], category: 'boat', values: [{ date: '2026-01-31', value: -5 }] }],
      liabilities: [{ ...nw.liabilities[0], rate: 5, extra: 1 }],
    };
    const errs = validateDoc('data', { ...emptyData(), netWorth: bad });
    expect(errs.some(e => e.includes('category'))).toBe(true);
    expect(errs.some(e => e.includes('values[0].value'))).toBe(true);
    expect(errs.some(e => e.includes('rate'))).toBe(true);
    expect(errs).toContain('data.netWorth.liabilities[0].extra: unknown field');
  });
  it('requires the lists', () => {
    expect(validateDoc('data', { ...emptyData(), netWorth: {} })).toEqual(expect.arrayContaining(['data.netWorth.assets: required', 'data.netWorth.liabilities: required']));
  });
});
