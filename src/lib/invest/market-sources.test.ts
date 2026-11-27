import { describe, it, expect } from 'vitest';
import { bnrFx, storePrices, manualPriceRows, marketYears } from './market-sources';
import { chainFx, manualFx } from './fx';
import { chainPrices, manualPrices } from './prices';
import type { FxYear, PricesYear } from './market';
import type { Instrument } from './types';

const fxDoc: FxYear = {
  version: 1, year: 2026, source: 'BNR', updated: '2026-11-27T00:00:00Z',
  rates: { '2026-11-20': { EUR: 5.0, USD: 4.5, GBP: 6.0 }, '2026-11-23': { EUR: 5.1, USD: 4.4, GBP: 6.1 } },
};
const pricesDoc: PricesYear = {
  version: 1, year: 2026, updated: '2026-11-27T00:00:00Z',
  prices: {
    eur: { '2026-11-20': { close: 100, currency: 'EUR', source: 'yahoo' }, '2026-11-23': { close: 102, currency: 'EUR', source: 'manual' } },
    gbpLine: { '2026-11-23': { close: 51, currency: 'GBP', source: 'yahoo' } },
  },
};
const inst = (id: string, currency: Instrument['currency']): Instrument => ({ id, name: id, assetClass: 'equity', region: 'global', currency });

describe('bnrFx', () => {
  const fx = bnrFx([fxDoc]);
  it('uses the rate of the day, or the last one before it', () => {
    expect(fx.rate('EUR', '2026-11-23')).toEqual({ ron: 5.1, date: '2026-11-23', source: 'BNR' });
    expect(fx.rate('EUR', '2026-11-22')).toEqual({ ron: 5.0, date: '2026-11-20', source: 'BNR' }); // Sunday
  });
  it('RON is 1, unknown dates are null', () => {
    expect(fx.rate('RON', '2026-01-01')?.ron).toBe(1);
    expect(fx.rate('EUR', '2025-01-01')).toBeNull();
  });
  it('falls back to manual rates through chainFx', () => {
    const chained = chainFx(fx, manualFx([{ date: '2025-01-01', currency: 'EUR', ron: 4.97 }]));
    expect(chained.rate('EUR', '2025-01-02')).toEqual({ ron: 4.97, date: '2025-01-01', source: 'manual' });
    expect(chained.rate('EUR', '2026-11-23')?.source).toBe('BNR');
  });
});

describe('storePrices', () => {
  const fx = bnrFx([fxDoc]);
  const src = storePrices([pricesDoc], [inst('eur', 'EUR'), inst('gbpLine', 'EUR')], fx);

  it('returns the latest price on or before the date, with its source', () => {
    expect(src.price('eur', '2026-11-21')).toEqual({ price: 100, date: '2026-11-20', source: 'yahoo' });
    expect(src.price('eur', '2026-11-30')).toEqual({ price: 102, date: '2026-11-23', source: 'manual' });
    expect(src.price('eur', '2026-11-01')).toBeNull();
    expect(src.price('nothing', '2026-11-30')).toBeNull();
  });

  it('converts a listing in another currency with BNR rates of the price date', () => {
    // 51 GBP × 6.1 RON / 5.1 RON per EUR = 61.0 EUR
    const q = src.price('gbpLine', '2026-11-25');
    expect(q?.price).toBeCloseTo(61, 4);
    expect(q?.source).toBe('yahoo (GBP→EUR)');
  });

  it('returns null when the conversion rate is missing, so the chain continues', () => {
    const noFx = storePrices([pricesDoc], [inst('gbpLine', 'EUR')], bnrFx([]));
    expect(noFx.price('gbpLine', '2026-11-25')).toBeNull();
    const chained = chainPrices(noFx, manualPrices([{ instrumentId: 'gbpLine', date: '2026-11-01', price: 60 }]));
    expect(chained.price('gbpLine', '2026-11-25')).toEqual({ price: 60, date: '2026-11-01', source: 'manual' });
  });
});

describe('manualPriceRows / marketYears', () => {
  it('lists only manual corrections, newest first', () => {
    expect(manualPriceRows([pricesDoc])).toEqual([{ instrumentId: 'eur', date: '2026-11-23', close: 102, currency: 'EUR' }]);
  });
  it('needs every transaction year plus the current one', () => {
    expect(marketYears(['2024-03-01', '2024-05-01', '2025-01-02'], '2026-11-27')).toEqual([2024, 2025, 2026]);
  });
});
