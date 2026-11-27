import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseBnrXml, mergeFxDays, rateOn, convert, latestFx, emptyFxYear,
  parsePriceSource, parseYahooChart, mergePrices, setManualPrice, latestPrice, emptyPricesYear,
  isStale, fxYearsNeeded, validateOverride, isIsoDate, type FxYear, type PricesYear,
} from './market';

// Real responses saved on 2026-11-27 (see __fixtures__/README.md)
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const yahoo = (sym: string) => JSON.parse(fixture(`yahoo-${sym}.json`));

describe('BNR XML', () => {
  it('parses the daily file', () => {
    const days = parseBnrXml(fixture('bnr-daily.xml'));
    expect(days).toEqual([{ date: '2026-11-27', rates: { EUR: 5.3434, USD: 4.8743, GBP: 6.3985, CHF: 5.8334 } }]);
  });

  it('parses the 10-day file, sorted by date', () => {
    const days = parseBnrXml(fixture('bnr-10days.xml'));
    expect(days).toHaveLength(10);
    expect(days[0].date).toBe('2026-11-16');
    expect(days[9].date).toBe('2026-11-27');
    for (const d of days) expect(Object.keys(d.rates).sort()).toEqual(['CHF', 'EUR', 'GBP', 'USD']);
  });

  it('parses the (pretty-printed) yearly file', () => {
    const days = parseBnrXml(fixture('bnr-year-2024-excerpt.xml'));
    expect(days.map(d => d.date)).toEqual(['2024-01-03', '2024-01-04', '2024-01-05']);
    expect(days[0].rates.EUR).toBe(4.9731);
  });

  it('applies the multiplier', () => {
    const xml = '<DataSet><Body><Cube date="2026-01-05"><Rate currency="USD" multiplier="100">450.00</Rate></Cube></Body></DataSet>';
    expect(parseBnrXml(xml)[0].rates.USD).toBe(4.5);
  });

  it('rejects an HTML page (e.g. a redirect to the BNR home page)', () => {
    expect(() => parseBnrXml('<!doctype html><html><body>BNR</body></html>')).toThrow(/not a rates XML/);
  });
});

describe('FX documents and lookups', () => {
  const docs = new Map<number, FxYear>();
  mergeFxDays(docs, parseBnrXml(fixture('bnr-10days.xml')), '2026-11-27T18:00:00Z');

  it('merges into per-year documents and reports changes once', () => {
    expect([...docs.keys()]).toEqual([2026]);
    expect(Object.keys(docs.get(2026)!.rates)).toHaveLength(10);
    expect(mergeFxDays(docs, parseBnrXml(fixture('bnr-daily.xml')))).toEqual([]);
  });

  it('splits days across years', () => {
    const m = new Map<number, FxYear>();
    const changed = mergeFxDays(m, [
      { date: '2025-12-31', rates: { EUR: 5.1 } },
      { date: '2026-01-05', rates: { EUR: 5.2 } },
    ]);
    expect(changed).toEqual([2025, 2026]);
  });

  it('uses the previous published rate on weekends', () => {
    // 2026-11-21/22 is a weekend → Friday 2026-11-20
    const r = rateOn(docs, '2026-11-22', 'EUR');
    expect(r?.date).toBe('2026-11-20');
    expect(rateOn(docs, '2026-11-27', 'EUR')).toEqual({ rate: 5.3434, date: '2026-11-27' });
    expect(rateOn(docs, '2026-11-27', 'RON')).toEqual({ rate: 1, date: '2026-11-27' });
    expect(rateOn(docs, '2026-01-01', 'EUR')).toBeNull();
  });

  it('looks back into the previous year', () => {
    const m = new Map<number, FxYear>([[2025, { ...emptyFxYear(2025), rates: { '2025-12-31': { EUR: 5.09 } } }]]);
    expect(rateOn(m, '2026-01-02', 'EUR')).toEqual({ rate: 5.09, date: '2025-12-31' });
  });

  it('converts through RON', () => {
    expect(convert(100, 'EUR', 'RON', '2026-11-27', docs)).toBeCloseTo(534.34, 6);
    expect(convert(100, 'USD', 'EUR', '2026-11-27', docs)).toBeCloseTo(100 * 4.8743 / 5.3434, 8);
    expect(convert(5, 'EUR', 'EUR', '1999-01-01', docs)).toBe(5);
    expect(convert(5, 'EUR', 'RON', '1999-01-01', docs)).toBeNull();
  });

  it('finds the latest day', () => {
    expect(latestFx([...docs.values()])?.date).toBe('2026-11-27');
  });
});

describe('price sources', () => {
  it('maps exchanges to Yahoo symbols', () => {
    expect(parsePriceSource('xetra:VWCE')?.symbol).toBe('VWCE.DE');
    expect(parsePriceSource('lse:vwra')?.symbol).toBe('VWRA.L');
    expect(parsePriceSource('us:AAPL')?.symbol).toBe('AAPL');
    expect(parsePriceSource('bvb:TVBETETF')?.symbol).toBe('TVBETETF.RO');
    expect(parsePriceSource('yahoo:IWDA.AS')?.symbol).toBe('IWDA.AS');
  });

  it('rejects manual, unknown and unsafe values', () => {
    for (const s of [undefined, '', 'manual', 'VWCE', 'nyse:AAPL', 'xetra:', 'us:AA PL', 'us:../x', 'us:A?B=1']) {
      expect(parsePriceSource(s)).toBeNull();
    }
  });
});

describe('Yahoo chart', () => {
  it('parses a Xetra ETF in EUR', () => {
    const s = parseYahooChart(yahoo('VWCE.DE'));
    expect(s.currency).toBe('EUR');
    expect(s.points).toHaveLength(10);
    expect(s.points.at(-1)).toEqual({ date: '2026-11-27', close: 165.46 });
    expect(s.points[0].date).toBe('2026-11-16');
  });

  it('parses US and BVB listings', () => {
    expect(parseYahooChart(yahoo('AAPL')).points.at(-1)).toEqual({ date: '2026-11-27', close: 358.54 });
    const tlv = parseYahooChart(yahoo('TLV.RO'));
    expect(tlv.currency).toBe('RON');
    expect(tlv.points.at(-1)).toEqual({ date: '2026-11-27', close: 36.4 });
  });

  it('keeps GBP listings and converts pence (GBp) to pounds', () => {
    expect(parseYahooChart(yahoo('VWRL.L')).currency).toBe('GBP');
    const vod = parseYahooChart(yahoo('VOD.L'));
    expect(vod.currency).toBe('GBP');
    expect(vod.points.at(-1)).toEqual({ date: '2026-11-27', close: 1.0395 });
  });

  it('skips null closes', () => {
    const body = yahoo('VWCE.DE');
    body.chart.result[0].indicators.quote[0].close[9] = null;
    expect(parseYahooChart(body).points).toHaveLength(9);
  });

  it('throws on errors and unsupported currencies', () => {
    expect(() => parseYahooChart(yahoo('notfound'))).toThrow(/No data found/);
    expect(() => parseYahooChart({})).toThrow(/unexpected/);
    const jpy = yahoo('AAPL');
    jpy.chart.result[0].meta.currency = 'JPY';
    expect(() => parseYahooChart(jpy)).toThrow(/unsupported currency/);
  });
});

describe('price documents', () => {
  const series = parseYahooChart(yahoo('VWCE.DE'));

  it('merges automatic prices and never overwrites manual ones', () => {
    const docs = new Map<number, PricesYear>();
    expect(mergePrices(docs, 'i1', series)).toEqual([2026]);
    expect(mergePrices(docs, 'i1', series)).toEqual([]); // nothing new
    const doc = docs.get(2026)!;
    setManualPrice(doc, 'i1', '2026-11-27', 170, 'EUR');
    mergePrices(docs, 'i1', series);
    expect(doc.prices.i1['2026-11-27']).toEqual({ close: 170, currency: 'EUR', source: 'manual' });
    expect(latestPrice([doc], 'i1')).toEqual({ date: '2026-11-27', close: 170, currency: 'EUR', source: 'manual' });
    expect(latestPrice([doc], 'i1', '2026-11-20')?.date).toBe('2026-11-20');
  });

  it('overwrites an earlier automatic value (intraday → final close)', () => {
    const docs = new Map<number, PricesYear>();
    mergePrices(docs, 'i1', { ...series, points: [{ date: '2026-11-27', close: 160 }] });
    expect(mergePrices(docs, 'i1', series)).toEqual([2026]);
    expect(docs.get(2026)!.prices.i1['2026-11-27'].close).toBe(165.46);
  });

  it('removes a manual price', () => {
    const doc = emptyPricesYear(2026);
    setManualPrice(doc, 'i2', '2026-03-02', 10, 'RON');
    setManualPrice(doc, 'i2', '2026-03-02', null, 'RON');
    expect(doc.prices.i2).toBeUndefined();
    expect(latestPrice([doc], 'i2')).toBeNull();
  });
});

describe('helpers', () => {
  it('flags stale prices', () => {
    expect(isStale('2026-11-20', '2026-11-23')).toBe(false); // Friday → Monday
    expect(isStale('2026-11-20', '2026-11-25')).toBe(false);
    expect(isStale('2026-11-20', '2026-11-26')).toBe(true);
  });

  it('lists the FX years to backfill', () => {
    expect(fxYearsNeeded(['2024-05-02', '2025-01-10', '2024-12-01', 'bad'], '2026-11-27')).toEqual([2024, 2025, 2026]);
    expect(fxYearsNeeded([], '2026-11-27')).toEqual([2026]);
  });

  it('validates dates strictly', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('26-02-01')).toBe(false);
  });

  it('validates a manual price', () => {
    const ok = { instrumentId: 'i1', date: '2026-11-20', close: 101.5, currency: 'EUR' };
    expect(validateOverride(ok, '2026-11-27')).toEqual([]);
    expect(validateOverride({ ...ok, close: null }, '2026-11-27')).toEqual([]);
    expect(validateOverride({ ...ok, date: '2026-12-01' }, '2026-11-27')).toEqual(['date: cannot be in the future']);
    expect(validateOverride({ ...ok, close: -1, currency: 'JPY', extra: 1 }, '2026-11-27')).toHaveLength(3);
    expect(validateOverride([], '2026-11-27')).toEqual(['object expected']);
  });
});
