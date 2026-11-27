// All rows below are invented test data (fictional accounts, tickers and amounts).
import { describe, it, expect } from 'vitest';
import {
  parseCsv, detectDelimiter, readTable, parseNumber, parseDate, guessColumns, distinctValues, missingColumns,
  matchInstrument, findNewInstruments, buildPreview, applyImport, blankPreset, BUILTIN_PRESETS,
} from './import';
import { transactionsCsv } from './csv';
import { validateDoc } from './validate';
import { emptyData, type ImportPreset, type InvestData, type Instrument } from './types';

const base = (): InvestData => ({
  ...emptyData(),
  accounts: [
    { id: 'a1', name: 'Broker Test', type: 'foreign_broker', currency: 'EUR' },
    { id: 'a2', name: 'Cont RO', type: 'ro_broker', currency: 'RON' },
  ],
  instruments: [
    { id: 'i1', ticker: 'AAA', isin: 'IE0000000001', name: 'Alpha World ETF', assetClass: 'equity', region: 'global', currency: 'EUR' },
  ],
});

let seq = 0;
const ids = () => `t${++seq}`;

describe('parseCsv / detectDelimiter', () => {
  it('handles quotes, escaped quotes, newlines in cells, BOM and CRLF', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",2\r\n\r\n', ',');
    expect(rows.map(r => r.cells)).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', '2']]);
    expect(rows.map(r => r.line)).toEqual([1, 2, 3]);
  });
  it('detects comma, semicolon and tab', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('data;suma\n05.03.2024;"1,5"\n06.03.2024;2,5')).toBe(';');
    expect(detectDelimiter('a\tb\n1,5\t2,5')).toBe('\t');
  });
});

describe('parseNumber', () => {
  it.each([
    ['1.234,56', 'auto', 1234.56], ['1,234.56', 'auto', 1234.56], ['1 234,5', 'auto', 1234.5], ['12,5', 'auto', 12.5],
    ['12.5', 'auto', 12.5], ['1,234,567', 'auto', 1234567], ['1.234.567', 'auto', 1234567], ['(12,50)', 'auto', -12.5],
    ['-3', 'auto', -3], ['€ 12.5', 'auto', 12.5], ['12,5 RON', 'auto', 12.5], ['1,234', '.', 1234], ['1.234', ',', 1234],
    ['-0.35', '.', -0.35],
  ] as const)('%s (%s) → %s', (s, d, n) => expect(parseNumber(s, d)).toBeCloseTo(n, 9));
  it('empty is undefined, garbage is NaN', () => {
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber('1.2.3', '.')).toBeNaN();
  });
});

describe('parseDate', () => {
  it('reads ISO, compact and timestamps regardless of order', () => {
    expect(parseDate('2024-03-05', 'dmy')).toBe('2024-03-05');
    expect(parseDate('20240305', 'mdy')).toBe('2024-03-05');
    expect(parseDate('2024-03-05, 10:30:00', 'dmy')).toBe('2024-03-05');
    expect(parseDate('20240305;103000', 'dmy')).toBe('2024-03-05');
  });
  it('uses the chosen order for d/m/y', () => {
    expect(parseDate('05.03.2024', 'dmy')).toBe('2024-03-05');
    expect(parseDate('3/5/2024', 'mdy')).toBe('2024-03-05');
    expect(parseDate('3/5/2024', 'dmy')).toBe('2024-05-03');
    expect(parseDate('5-3-24', 'dmy')).toBe('2024-03-05');
  });
  it('rejects impossible dates', () => {
    expect(parseDate('31.02.2024', 'dmy')).toBeNull();
    expect(parseDate('13/13/2024', 'mdy')).toBeNull();
    expect(parseDate('ieri', 'dmy')).toBeNull();
  });
});

describe('readTable / guessColumns', () => {
  it('finds the header after preamble lines and drops repeated headers', () => {
    const text = 'Raport test\nGenerat azi\nData;Tip;Ticker;Cantitate;Pret\n05.03.2024;Cumpărare;AAA;2;100\nData;Tip;Ticker;Cantitate;Pret\n06.03.2024;Vânzare;AAA;1;110\n';
    const p = { delimiter: 'auto' as const, columns: { date: 'Data', type: 'Tip' } };
    const t = readTable(text, p);
    expect(t.headerLine).toBe(3);
    expect(t.rows.map(r => r.line)).toEqual([4, 6]);
    expect(readTable(text, { ...p, headerRow: 3, columns: {} }).headers[0]).toBe('Data');
  });
  it('guesses Romanian and English headers', () => {
    expect(guessColumns(['Data', 'Tip', 'Simbol', 'ISIN', 'Cantitate', 'Preț', 'Monedă', 'Comision', 'Cont'])).toEqual({
      date: 'Data', type: 'Tip', ticker: 'Simbol', isin: 'ISIN', quantity: 'Cantitate', price: 'Preț', currency: 'Monedă', fees: 'Comision', account: 'Cont',
    });
    expect(guessColumns(['Trade Date', 'Symbol', 'Qty', 'Price'])).toMatchObject({ date: 'Trade Date', ticker: 'Symbol', quantity: 'Qty', price: 'Price' });
  });
  it('lists distinct values and missing columns', () => {
    const t = readTable('Tip,X\nBuy,1\nSell,2\nBuy,3', { delimiter: ',', columns: {} });
    expect(distinctValues(t, 'tip')).toEqual(['Buy', 'Sell']);
    expect(missingColumns(t, { ...blankPreset(), columns: { type: 'Tip', price: 'Pret' } })).toEqual(['price']);
  });
});

describe('matchInstrument', () => {
  const list: Instrument[] = [
    { id: 'x', ticker: 'AAA', isin: 'IE0000000001', name: 'Alpha', assetClass: 'equity', region: 'global', currency: 'EUR' },
    { id: 'y', ticker: 'BBB', name: 'Beta Corp', assetClass: 'equity', region: 'us', currency: 'USD' },
  ];
  it('prefers ISIN, then ticker, then name', () => {
    expect(matchInstrument({ isin: 'ie0000000001', ticker: 'ZZZ' }, list)?.id).toBe('x');
    expect(matchInstrument({ ticker: 'bbb' }, list)?.id).toBe('y');
    expect(matchInstrument({ name: ' beta corp ' }, list)?.id).toBe('y');
  });
  it('does not match a ticker when the ISINs differ', () => {
    expect(matchInstrument({ ticker: 'AAA', isin: 'IE0000000002' }, list)).toBeUndefined();
  });
});

// A custom layout like a personal Google Sheet: Romanian words, decimal commas, d.m.y dates.
const SHEET = [
  'Data;Tip;Cont;Simbol;ISIN;Denumire;Cantitate;Preț;Monedă;Comision;Impozit;Sumă',
  '05.03.2024;Cumpărare;Broker Test;AAA;IE0000000001;Alpha World ETF;10;100,50;EUR;1,25;;',
  '06.03.2024;Cumpărare;Broker Test;CCC;;Gamma Bond Fund;5;20;EUR;0;;',
  '07.03.2024;Dividend;Broker Test;AAA;IE0000000001;;;;EUR;;0,75;5,00',
  '08.03.2024;Depunere;Broker Test;;;;;;EUR;;;1.000,00',
  '09.03.2024;Swap;Broker Test;AAA;;;1;1;EUR;;;',
  '31.02.2024;Vânzare;Broker Test;AAA;;;1;1;EUR;;;',
  '10.03.2024;Vânzare;Cont Necunoscut;AAA;;;1;1;EUR;;;',
  ';;;;;;;;;;;123',
].join('\n');

function sheetPreset(): ImportPreset {
  const t = readTable(SHEET, { delimiter: 'auto', columns: {} });
  return { ...blankPreset(t.headers), id: 'p1', name: 'Foaia mea', dateOrder: 'dmy' };
}

describe('buildPreview on a custom sheet', () => {
  const preset = sheetPreset();
  const table = readTable(SHEET, preset);
  const data = base();

  it('guessed every column of the invented sheet', () => {
    expect(preset.columns).toMatchObject({ date: 'Data', type: 'Tip', account: 'Cont', ticker: 'Simbol', isin: 'ISIN', name: 'Denumire', quantity: 'Cantitate', price: 'Preț', currency: 'Monedă', fees: 'Comision', withheldTax: 'Impozit', amount: 'Sumă' });
  });

  it('proposes the unknown instrument only', () => {
    const props = findNewInstruments(table, preset, data);
    expect(props.map(p => p.key)).toEqual(['ticker:CCC']);
    expect(props[0].draft).toMatchObject({ name: 'Gamma Bond Fund', ticker: 'CCC', currency: 'EUR' });
    expect(props[0].lines).toEqual([3]);
  });

  it('classifies rows and explains errors', () => {
    const pv = buildPreview(table, preset, data);
    const byLine = Object.fromEntries(pv.rows.map(r => [r.line, r]));
    expect(byLine[2].status).toBe('new');
    expect(byLine[2].tx).toEqual({ date: '2024-03-05', type: 'buy', accountId: 'a1', currency: 'EUR', instrumentId: 'i1', quantity: 10, price: 100.5, fees: 1.25 });
    expect(byLine[3].status).toBe('error');
    expect(byLine[3].reasons).toContain('instrument nou neconfirmat');
    expect(byLine[4].tx).toMatchObject({ type: 'dividend', amount: 5, withheldTax: 0.75, instrumentId: 'i1' });
    expect(byLine[5].tx).toMatchObject({ type: 'deposit', amount: 1000 });
    expect(byLine[6].reasons[0]).toMatch(/Swap/);
    expect(byLine[7].reasons[0]).toMatch(/31\.02\.2024/);
    expect(byLine[8].reasons[0]).toMatch(/Cont Necunoscut/);
    expect(byLine[9].status).toBe('skipped'); // a subtotal: amount only, no date/type/quantity
    expect(pv.counts).toEqual({ new: 3, duplicate: 0, error: 4, skipped: 1 });
  });

  it('accepting the proposal makes the row new; mapping a type to skip ignores it', () => {
    const props = findNewInstruments(table, preset, data);
    const accepted = props.map(p => ({ ...p.draft, id: 'new-ccc', key: p.key }));
    const pv = buildPreview(table, { ...preset, typeMap: { ...preset.typeMap, swap: 'skip' } }, data, accepted);
    const r3 = pv.rows.find(r => r.line === 3)!;
    expect(r3.status).toBe('new');
    expect(r3.newInstrumentKey).toBe('ticker:CCC');
    expect(pv.rows.find(r => r.line === 6)!.status).toBe('skipped');
  });

  it('account mapping and default account', () => {
    const pv = buildPreview(table, { ...preset, accountMap: { 'Cont Necunoscut': 'a2' } }, data);
    expect(pv.rows.find(r => r.line === 8)!.tx?.accountId).toBe('a2');
    const noAcc = readTable('Data,Tip,Ticker,Qty,Price\n2024-03-05,buy,AAA,1,10', { delimiter: ',', columns: {} });
    const p = { ...blankPreset(noAcc.headers), dateOrder: 'ymd' as const };
    expect(buildPreview(noAcc, p, data).rows[0].reasons).toContain('alege contul implicit');
    expect(buildPreview(noAcc, { ...p, defaultAccountId: 'a1' }, data).rows[0].status).toBe('new');
  });
});

describe('duplicates', () => {
  it('matches one-to-one, so two identical fills stay two rows', () => {
    const text = 'date,type,ticker,quantity,price\n2024-03-05,buy,AAA,1,10\n2024-03-05,buy,AAA,1,10\n';
    const t = readTable(text, { delimiter: ',', columns: {} });
    const preset = { ...blankPreset(t.headers), dateOrder: 'ymd' as const, defaultAccountId: 'a1' };
    const data = base();
    const first = buildPreview(t, preset, data);
    expect(first.counts.new).toBe(2);
    const after = applyImport(data, first, new Set([2, 3]), [], ids).data;
    expect(after.transactions).toHaveLength(2);
    const again = buildPreview(t, preset, after);
    expect(again.counts).toMatchObject({ new: 0, duplicate: 2 });
    expect(new Set(again.rows.map(r => r.duplicateOf)).size).toBe(2);
    // a third identical fill on re-import is new
    const three = readTable(text + '2024-03-05,buy,AAA,1,10\n', { delimiter: ',', columns: {} });
    expect(buildPreview(three, preset, after).counts).toMatchObject({ new: 1, duplicate: 2 });
  });
});

describe('applyImport', () => {
  it('adds chosen rows and only the new instruments they use; result passes validation', () => {
    const preset = sheetPreset();
    const table = readTable(SHEET, preset);
    const data = base();
    const accepted = findNewInstruments(table, preset, data).map(p => ({ ...p.draft, id: 'new-ccc', key: p.key }));
    const pv = buildPreview(table, preset, data, accepted);
    const onlyLine2 = applyImport(data, pv, new Set([2]), accepted, ids);
    expect(onlyLine2.instrumentsAdded).toBe(0);
    expect(onlyLine2.data.instruments).toHaveLength(1);
    const all = applyImport(data, pv, new Set(pv.rows.map(r => r.line)), accepted, ids);
    expect(all.added).toBe(4);
    expect(all.instrumentsAdded).toBe(1);
    expect(all.data.instruments.find(i => i.id === 'new-ccc')).not.toHaveProperty('key');
    expect(validateDoc('data', all.data)).toEqual([]);
    expect(data.transactions).toHaveLength(0); // input untouched
  });
});

describe('built-in presets', () => {
  it('round-trips the app\'s own CSV export', () => {
    const src = base();
    src.accounts.push({ id: 'a3', name: 'Cash', type: 'cash', currency: 'EUR' });
    src.transactions = [
      { id: 'x1', date: '2024-01-02', type: 'buy', accountId: 'a1', instrumentId: 'i1', quantity: 3.5, price: 101.25, currency: 'EUR', fees: 1.5, note: 'test; "quoted"' },
      { id: 'x2', date: '2024-02-03', type: 'dividend', accountId: 'a1', instrumentId: 'i1', amount: 4.2, currency: 'EUR', withheldTax: 0.4 },
      { id: 'x3', date: '2024-02-04', type: 'transfer', accountId: 'a1', toAccountId: 'a3', amount: 50, currency: 'EUR' },
    ];
    const csv = transactionsCsv(src);
    const preset = BUILTIN_PRESETS.find(p => p.id === 'builtin-geoli-csv')!;
    const target = { ...src, transactions: [] };
    const pv = buildPreview(readTable(csv, preset), preset, target);
    expect(pv.counts).toEqual({ new: 3, duplicate: 0, error: 0, skipped: 0 });
    expect(pv.rows.map(r => r.tx)).toEqual(src.transactions.map(({ id: _id, ...t }) => t));
    // importing it again into the original data: all duplicates
    expect(buildPreview(readTable(csv, preset), preset, src).counts.duplicate).toBe(3);
  });

  it('reads an invented Interactive Brokers Flex "Trades" CSV', () => {
    const csv = [
      '"ClientAccountID","CurrencyPrimary","Symbol","Description","ISIN","TradeDate","Quantity","TradePrice","IBCommission","Buy/Sell"',
      '"U0000000","EUR","AAA","ALPHA WORLD ETF","IE0000000001","20240305","4","101.2","-1.25","BUY"',
      '"U0000000","USD","ZZZ","ZETA INC","US0000000009","20240306","-2","50","-0.35","SELL"',
    ].join('\r\n');
    const ib = BUILTIN_PRESETS.find(p => p.id === 'builtin-ibkr-flex-trades')!;
    const preset = { ...ib, accountMap: { U0000000: 'a1' } };
    const table = readTable(csv, preset);
    const data = base();
    const props = findNewInstruments(table, preset, data);
    expect(props.map(p => p.key)).toEqual(['isin:US0000000009']);
    expect(props[0].draft).toMatchObject({ ticker: 'ZZZ', currency: 'USD', name: 'ZETA INC' });
    const accepted = props.map(p => ({ ...p.draft, id: 'z', key: p.key }));
    const pv = buildPreview(table, preset, data, accepted);
    expect(pv.rows.map(r => r.tx)).toEqual([
      { date: '2024-03-05', type: 'buy', accountId: 'a1', currency: 'EUR', instrumentId: 'i1', quantity: 4, price: 101.2, fees: 1.25 },
      { date: '2024-03-06', type: 'sell', accountId: 'a1', currency: 'USD', instrumentId: 'z', quantity: 2, price: 50, fees: 0.35 },
    ]);
  });

  it('presets are valid documents when saved', () => {
    const d = base();
    d.importPresets = [{ ...sheetPreset(), accountMap: { 'Cont X': 'a1' }, defaultAccountId: 'a1', defaultCurrency: 'EUR', typeFromSign: true }];
    expect(validateDoc('data', d)).toEqual([]);
    d.importPresets[0].typeMap.foo = 'bar' as never;
    expect(validateDoc('data', d).length).toBeGreaterThan(0);
  });
});
