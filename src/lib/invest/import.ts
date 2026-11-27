// Transaction import from CSV (/vault/invest/import/). Pure functions only: the page reads the file in the
// browser, and nothing leaves the device except the resulting transactions saved to data.json.
//
// Flow: readTable (split the text) → a preset maps columns → findNewInstruments (what must be created)
// → buildPreview (parse every row, flag errors and duplicates) → applyImport (new data.json, saved once).
//
// Accepted input: comma, semicolon or tab separated, quoted cells, UTF-8 BOM; numbers with decimal comma or dot
// and thousands separators; dates as 2024-03-05, 20240305, 05.03.2024, 5/3/2024 (order chosen in the preset).
import {
  CURRENCIES, TX_TYPES,
  type Account, type Currency, type ImportField, type ImportPreset, type Instrument, type InvestData,
  type Transaction, type TxType,
} from './types';

// ─── 1. Splitting the text ───

export type Delimiter = ',' | ';' | '\t';

export interface Table {
  delimiter: Delimiter;
  /** 1-based line of the header row */
  headerLine: number;
  headers: string[];
  rows: { line: number; cells: string[] }[];
}

/** Splits CSV text into rows of cells (RFC 4180 quoting, any line ending). Line numbers are 1-based. */
export function parseCsv(text: string, delimiter: Delimiter): { line: number; cells: string[] }[] {
  const s = text.replace(/^﻿/, '');
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.trim() === '') { cell = ''; quoted = true; }
    else if (c === delimiter) { cells.push(cell); cell = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      cells.push(cell);
      out.push({ line: rowLine, cells });
      cells = []; cell = '';
      line++; rowLine = line;
    } else cell += c;
  }
  if (cell !== '' || cells.length) { cells.push(cell); out.push({ line: rowLine, cells }); }
  return out.filter(r => r.cells.some(x => x.trim() !== ''));
}

/** Picks the separator that splits the first lines into the most consistent number of columns. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t'] as Delimiter[]) {
    const counts = sample.map(l => parseCsv(l, d)[0]?.cells.length ?? 0);
    if (!counts.length) continue;
    // Most common column count, weighted by how often it occurs; 1 column = the separator isn't used.
    const freq = new Map<number, number>();
    for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
    const [cols, times] = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const score = cols > 1 ? times * 1000 + cols : 0;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Splits the text and finds the header row: the given 1-based line, else the first row that contains
 * at least two of the preset's column names (or all of them when only one is set), else the first row.
 * Rows that repeat the header (multi-section exports) are dropped.
 */
export function readTable(text: string, preset: Pick<ImportPreset, 'delimiter' | 'headerRow' | 'columns'>): Table {
  const delimiter = preset.delimiter === 'auto' ? detectDelimiter(text) : preset.delimiter;
  const all = parseCsv(text, delimiter);
  let idx = 0;
  if (preset.headerRow && preset.headerRow > 0) {
    idx = all.findIndex(r => r.line >= preset.headerRow!);
    if (idx < 0) idx = all.length;
  } else {
    const wanted = Object.values(preset.columns).filter((v): v is string => !!v).map(norm);
    if (wanted.length) {
      const need = Math.min(2, wanted.length);
      const found = all.findIndex(r => wanted.filter(w => r.cells.some(c => norm(c) === w)).length >= need);
      if (found >= 0) idx = found;
    }
  }
  const head = all[idx];
  if (!head) return { delimiter, headerLine: 0, headers: [], rows: [] };
  const headers = head.cells.map(c => c.trim());
  const key = headers.map(norm).join('\u0001');
  const rows = all.slice(idx + 1).filter(r => r.cells.map(norm).join('\u0001') !== key);
  return { delimiter, headerLine: head.line, headers, rows };
}

/** Distinct non-empty values of one column (for the type and account mappings), most frequent first. */
export function distinctValues(table: Table, header: string | undefined, limit = 100): string[] {
  const i = header ? table.headers.findIndex(h => norm(h) === norm(header)) : -1;
  if (i < 0) return [];
  const freq = new Map<string, number>();
  for (const r of table.rows) {
    const v = (r.cells[i] ?? '').trim();
    if (v) freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  return [...freq].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([v]) => v);
}

// ─── 2. Numbers and dates ───

/**
 * "1.234,56" / "1,234.56" / "1 234,56" / "(12,50)" / "-3" / "€ 12.5" → number. Empty → undefined, unreadable → NaN.
 * decimal 'auto': with both separators the last one is the decimal mark; a lone comma is a decimal mark
 * (Romanian sheets) unless it groups thousands more than once ("1,234,567"); same rule for a lone dot.
 */
export function parseNumber(raw: string | undefined, decimal: ImportPreset['decimal'] = 'auto'): number | undefined {
  let t = (raw ?? '').trim();
  if (!t) return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[\s  ']/g, '').replace(/^[A-Za-z€$£]+|[A-Za-z€$£%]+$/g, '');
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); } else if (t.startsWith('+')) t = t.slice(1);
  if (t.endsWith('-')) { neg = !neg; t = t.slice(0, -1); }
  if (!t) return NaN;
  let dec = decimal;
  if (dec === 'auto') {
    const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) dec = lastComma > lastDot ? ',' : '.';
    else if (lastComma >= 0) dec = /^\d{1,3}(,\d{3}){2,}$/.test(t) ? '.' : ',';
    else dec = /^\d{1,3}(\.\d{3}){2,}$/.test(t) ? ',' : '.';
  }
  const thousands = dec === ',' ? '.' : ',';
  const cleaned = t.split(thousands).join('').replace(dec, '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

const pad = (n: number) => String(n).padStart(2, '0');
function isoIfValid(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Reads a date into YYYY-MM-DD. Always understood: 2024-03-05 (also with a time after it, as in
 * "2024-03-05, 10:30:00" or "2024-03-05T10:30"), 2024/03/05, 20240305 (optionally ";103000").
 * Otherwise three numbers separated by . / - or space, read in `order`; 2-digit years are 20xx.
 */
export function parseDate(raw: string | undefined, order: ImportPreset['dateOrder']): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[\sT,;])/.exec(t);
  if (m) return isoIfValid(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})(?:$|[\sT,;])/.exec(t);
  if (m) return isoIfValid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,4})[./\-\s](\d{1,2})[./\-\s](\d{1,4})(?:$|[\sT,;])/.exec(t);
  if (!m) return null;
  const a = +m[1], b = +m[2], c = +m[3];
  const year = (y: number, len: number) => (len <= 2 ? 2000 + y : y);
  if (order === 'ymd') return isoIfValid(year(a, m[1].length), b, c);
  if (order === 'dmy') return isoIfValid(year(c, m[3].length), b, a);
  return isoIfValid(year(c, m[3].length), a, b);
}

// ─── 3. Presets ───

/** Default words for the type column, English and Romanian (with and without diacritics). Lower-case keys. */
export const DEFAULT_TYPE_MAP: Record<string, TxType | 'skip'> = {
  buy: 'buy', bought: 'buy', 'cumpărare': 'buy', cumparare: 'buy', 'cumpărat': 'buy', cumparat: 'buy', b: 'buy',
  sell: 'sell', sold: 'sell', 'vânzare': 'sell', vanzare: 'sell', 'vândut': 'sell', vandut: 'sell', s: 'sell',
  dividend: 'dividend', dividends: 'dividend', dividende: 'dividend',
  interest: 'interest', 'dobândă': 'interest', dobanda: 'interest', cupon: 'interest', coupon: 'interest',
  fee: 'fee', fees: 'fee', commission: 'fee', comision: 'fee', taxa: 'fee', 'taxă': 'fee',
  deposit: 'deposit', depunere: 'deposit', 'alimentare': 'deposit',
  withdrawal: 'withdrawal', retragere: 'withdrawal',
  transfer: 'transfer',
};

/** Header words recognised by guessColumns (lower-case, compared without spaces, dots, dashes and underscores). */
const HEADER_HINTS: Record<ImportField, string[]> = {
  date: ['data', 'date', 'tradedate', 'datatranzactiei', 'datatranzacției', 'settledate', 'datetime', 'ziua'],
  type: ['tip', 'type', 'buy/sell', 'operatiune', 'operațiune', 'tiptranzactie', 'tiptranzacție', 'action', 'side'],
  ticker: ['ticker', 'symbol', 'simbol'],
  isin: ['isin'],
  name: ['instrument', 'nume', 'name', 'description', 'descriere', 'denumire', 'titlu', 'security'],
  quantity: ['cantitate', 'quantity', 'qty', 'units', 'unitati', 'unități', 'shares', 'nr', 'bucati', 'bucăți'],
  price: ['pret', 'preț', 'price', 'tradeprice', 'pretunitar', 'prețunitar', 'cost/unitate', 'priceperunit'],
  currency: ['moneda', 'monedă', 'currency', 'currencyprimary', 'valuta', 'valută', 'ccy'],
  fees: ['comision', 'comisioane', 'fee', 'fees', 'commission', 'ibcommission'],
  withheldTax: ['impozitretinut', 'impozitreținut', 'impozit', 'withholdingtax', 'withheldtax', 'tax', 'taxes'],
  amount: ['suma', 'sumă', 'amount', 'total', 'valoare', 'value', 'netcash', 'proceeds'],
  account: ['cont', 'account', 'clientaccountid', 'accountid', 'broker'],
  toAccount: ['contdestinatie', 'contdestinație', 'toaccount'],
  note: ['nota', 'notă', 'note', 'notes', 'comentariu', 'observatii', 'observații'],
};
const squash = (s: string) => norm(s).replace(/[\s._-]/g, '');

/** Suggests a mapping from the header names (exact word match only). */
export function guessColumns(headers: string[]): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {};
  const used = new Set<string>();
  for (const field of Object.keys(HEADER_HINTS) as ImportField[]) {
    for (const hint of HEADER_HINTS[field]) {
      const h = headers.find(x => !used.has(x) && squash(x) === squash(hint));
      if (h) { out[field] = h; used.add(h); break; }
    }
  }
  return out;
}

/**
 * Built-in presets. NOT verified on a real file yet: the page shows them as „neverificat pe un fișier real”
 * until George confirms one works (then set `verified: true`).
 */
export interface BuiltinPreset extends ImportPreset { builtin: true; verified: boolean; doc: string }

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: 'builtin-geoli-csv',
    builtin: true,
    verified: false,
    name: 'Exportul acestei aplicații (CSV din Portofoliu)',
    doc: 'Fișierul descărcat cu „Exportă CSV” din Portofoliu: separat cu punct și virgulă, zecimale cu virgulă, date AAAA-LL-ZZ. Contul și contul destinație se potrivesc după nume.',
    delimiter: ';', decimal: ',', dateOrder: 'ymd',
    columns: {
      date: 'data', type: 'tip', account: 'cont', name: 'instrument', ticker: 'ticker', isin: 'isin', quantity: 'cantitate',
      price: 'pret', amount: 'suma', currency: 'moneda', fees: 'comision', withheldTax: 'impozit_retinut',
      toAccount: 'cont_destinatie', note: 'nota',
    },
    typeMap: Object.fromEntries(TX_TYPES.map(t => [t, t])),
  },
  {
    id: 'builtin-ibkr-flex-trades',
    builtin: true,
    verified: false,
    name: 'Interactive Brokers — Flex Query „Trades” (CSV)',
    doc: 'Flex Query cu secțiunea Trades, format CSV, câmpurile ClientAccountID, TradeDate, Symbol, Description, ISIN, CurrencyPrimary, Buy/Sell, Quantity, TradePrice, IBCommission. Data în formatul implicit IB (yyyyMMdd) sau AAAA-LL-ZZ. Comisionul IB e negativ și se ia în valoare absolută; vânzările au cantitate negativă. Asociază o singură dată contul IB (ClientAccountID) cu contul tău din aplicație.',
    delimiter: ',', decimal: '.', dateOrder: 'ymd',
    columns: {
      account: 'ClientAccountID', date: 'TradeDate', ticker: 'Symbol', name: 'Description', isin: 'ISIN',
      currency: 'CurrencyPrimary', type: 'Buy/Sell', quantity: 'Quantity', price: 'TradePrice', fees: 'IBCommission',
    },
    typeMap: { buy: 'buy', sell: 'sell', 'buy (ca.)': 'buy', 'sell (ca.)': 'sell' },
    typeFromSign: true,
  },
];

/** A blank custom preset, with the columns guessed from the headers. */
export function blankPreset(headers: string[] = []): ImportPreset {
  return {
    id: '', name: '', delimiter: 'auto', decimal: 'auto', dateOrder: 'dmy',
    columns: guessColumns(headers), typeMap: { ...DEFAULT_TYPE_MAP },
  };
}

// ─── 4. Instruments ───

export interface InstrumentRef { ticker?: string; isin?: string; name?: string; currency?: Currency }

/** Stable key of an instrument reference: ISIN, else ticker, else name. */
export function instrumentKey(ref: InstrumentRef): string | null {
  if (ref.isin) return `isin:${ref.isin.toUpperCase()}`;
  if (ref.ticker) return `ticker:${ref.ticker.toUpperCase()}`;
  if (ref.name) return `name:${norm(ref.name)}`;
  return null;
}

/** Finds an existing instrument: same ISIN; else same ticker (when the ISINs don't contradict); else same name. */
export function matchInstrument(ref: InstrumentRef, instruments: Instrument[]): Instrument | undefined {
  const isin = ref.isin?.toUpperCase();
  if (isin) {
    const byIsin = instruments.find(i => i.isin?.toUpperCase() === isin);
    if (byIsin) return byIsin;
  }
  const ticker = ref.ticker?.toUpperCase();
  if (ticker) {
    const byTicker = instruments.find(i => i.ticker?.toUpperCase() === ticker && (!isin || !i.isin));
    if (byTicker) return byTicker;
  }
  if (ref.name) {
    const n = norm(ref.name);
    return instruments.find(i => norm(i.name) === n && (!isin || !i.isin));
  }
  return undefined;
}

export interface InstrumentProposal {
  key: string;
  ref: InstrumentRef;
  /** CSV lines that use it */
  lines: number[];
  /** Suggested instrument (George confirms or edits every field) */
  draft: Omit<Instrument, 'id'>;
}

// ─── 5. Rows → transactions ───

export type RowStatus = 'new' | 'duplicate' | 'error' | 'skipped';

export interface PreviewRow {
  line: number;
  status: RowStatus;
  /** Why the row is an error / skipped / duplicate (Romanian, for the page) */
  reasons: string[];
  /** The transaction to add (without id). Present for 'new' and 'duplicate'. */
  tx?: Omit<Transaction, 'id'>;
  /** Key of the instrument proposal the row needs, when the instrument is new */
  newInstrumentKey?: string;
  /** Existing transaction this row duplicates */
  duplicateOf?: string;
  /** Raw cells, for display */
  cells: string[];
}

export interface Preview {
  rows: PreviewRow[];
  counts: Record<RowStatus, number>;
}

interface Ctx {
  table: Table;
  preset: ImportPreset;
  accounts: Account[];
  col: Partial<Record<ImportField, number>>;
}

function makeCtx(table: Table, preset: ImportPreset, accounts: Account[]): Ctx {
  const col: Partial<Record<ImportField, number>> = {};
  for (const [field, header] of Object.entries(preset.columns) as [ImportField, string | undefined][]) {
    if (!header) continue;
    const i = table.headers.findIndex(h => norm(h) === norm(header));
    if (i >= 0) col[field] = i;
  }
  return { table, preset, accounts, col };
}

const get = (ctx: Ctx, cells: string[], f: ImportField) => {
  const i = ctx.col[f];
  return i === undefined ? '' : (cells[i] ?? '').trim();
};

function rowRef(ctx: Ctx, cells: string[]): InstrumentRef {
  const cur = get(ctx, cells, 'currency').toUpperCase();
  const ref: InstrumentRef = {
    ticker: get(ctx, cells, 'ticker') || undefined,
    isin: get(ctx, cells, 'isin').toUpperCase() || undefined,
    name: get(ctx, cells, 'name') || undefined,
    currency: (CURRENCIES as readonly string[]).includes(cur) ? (cur as Currency) : undefined,
  };
  if (ref.isin && !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(ref.isin)) ref.isin = undefined;
  return ref;
}

/** Which mapped columns are missing from the file (so the page can say so before anything else). */
export function missingColumns(table: Table, preset: ImportPreset): ImportField[] {
  return (Object.entries(preset.columns) as [ImportField, string | undefined][])
    .filter(([, h]) => h && !table.headers.some(x => norm(x) === norm(h)))
    .map(([f]) => f);
}

function resolveType(ctx: Ctx, cells: string[], qty: number | undefined): TxType | 'skip' | null {
  const raw = norm(get(ctx, cells, 'type'));
  if (raw) {
    const mapped = ctx.preset.typeMap[raw];
    if (mapped) return mapped;
  }
  if (ctx.preset.typeFromSign && qty !== undefined && !Number.isNaN(qty) && qty !== 0) return qty > 0 ? 'buy' : 'sell';
  return null;
}

function resolveAccount(ctx: Ctx, value: string): string | null {
  if (!value) return null;
  const mapped = ctx.preset.accountMap?.[value];
  if (mapped && ctx.accounts.some(a => a.id === mapped)) return mapped;
  const v = norm(value);
  return ctx.accounts.find(a => a.id === value || norm(a.name) === v)?.id ?? null;
}

const isInstrumentType = (t: TxType) => t === 'buy' || t === 'sell';
const usesAmount = (t: TxType) => t === 'dividend' || t === 'interest' || t === 'fee' || t === 'deposit' || t === 'withdrawal';
const r6 = (n: number | undefined) => (n === undefined ? '' : String(Math.round(n * 1e6) / 1e6));

/** Unknown instruments referenced by buy/sell/dividend rows, grouped by key, in file order. */
export function findNewInstruments(table: Table, preset: ImportPreset, data: Pick<InvestData, 'accounts' | 'instruments'>): InstrumentProposal[] {
  const ctx = makeCtx(table, preset, data.accounts);
  const out = new Map<string, InstrumentProposal>();
  for (const r of table.rows) {
    const ref = rowRef(ctx, r.cells);
    const key = instrumentKey(ref);
    if (!key || matchInstrument(ref, data.instruments)) continue;
    const type = resolveType(ctx, r.cells, parseNumber(get(ctx, r.cells, 'quantity'), preset.decimal));
    if (!type || type === 'skip' || usesAmount(type) && type !== 'dividend' && type !== 'interest') continue;
    const p = out.get(key);
    if (p) { p.lines.push(r.line); continue; }
    out.set(key, {
      key, ref, lines: [r.line],
      draft: {
        name: ref.name || ref.ticker || ref.isin || key,
        ticker: ref.ticker, isin: ref.isin,
        assetClass: 'equity', region: 'global',
        currency: ref.currency ?? preset.defaultCurrency ?? 'EUR',
      },
    });
  }
  return [...out.values()];
}

/**
 * Parses every row. `newInstruments` are the proposals George accepted, already with ids; a row whose
 * instrument is neither existing nor accepted is an error. Duplicates are matched one-to-one against
 * existing transactions (same account, instrument, date, type, quantity, price and amount), so two identical
 * fills in the same file are both new the first time and both duplicates on a re-import.
 */
export function buildPreview(
  table: Table,
  preset: ImportPreset,
  data: Pick<InvestData, 'accounts' | 'instruments' | 'transactions'>,
  newInstruments: (Instrument & { key: string })[] = [],
): Preview {
  const ctx = makeCtx(table, preset, data.accounts);
  const instruments = [...data.instruments, ...newInstruments];
  const newIds = new Set(newInstruments.map(i => i.id));
  const rows: PreviewRow[] = [];

  // Remaining existing transactions per duplicate key (each can absorb one imported row).
  const dupKey = (t: Omit<Transaction, 'id'>) =>
    [t.accountId, t.instrumentId ?? '', t.date, t.type, r6(t.quantity), r6(t.price), r6(t.amount)].join('|');
  const existing = new Map<string, string[]>();
  for (const t of data.transactions) {
    const k = dupKey(t);
    existing.set(k, [...(existing.get(k) ?? []), t.id]);
  }

  for (const r of table.rows) {
    const cells = r.cells;
    const reasons: string[] = [];
    const out: PreviewRow = { line: r.line, status: 'error', reasons, cells };
    rows.push(out);
    const dec = preset.decimal;

    const rawQty = parseNumber(get(ctx, cells, 'quantity'), dec);
    const type = resolveType(ctx, cells, rawQty);
    const typeText = get(ctx, cells, 'type');
    if (type === 'skip') { out.status = 'skipped'; reasons.push(`tipul „${typeText}” e marcat „ignoră”`); continue; }

    const dateText = get(ctx, cells, 'date');
    if (!dateText && !typeText && rawQty === undefined) { out.status = 'skipped'; reasons.push('rând fără dată, tip și cantitate (subtotal sau rând gol)'); continue; }

    const date = parseDate(dateText, preset.dateOrder);
    if (!date) reasons.push(dateText ? `data „${dateText}” nu se poate citi` : 'lipsește data');
    if (!type) reasons.push(typeText ? `tipul „${typeText}” nu e asociat cu un tip de tranzacție` : 'lipsește tipul');

    const nums: Partial<Record<'quantity' | 'price' | 'amount' | 'fees' | 'withheldTax', number>> = {};
    for (const f of ['quantity', 'price', 'amount', 'fees', 'withheldTax'] as const) {
      const text = get(ctx, cells, f);
      const n = f === 'quantity' ? rawQty : parseNumber(text, dec);
      if (n !== undefined && Number.isNaN(n)) reasons.push(`„${text}” nu e un număr (${FIELD_LABEL[f]})`);
      else if (n !== undefined) nums[f] = n;
    }

    const accText = get(ctx, cells, 'account');
    const accountId = accText ? resolveAccount(ctx, accText) : preset.defaultAccountId && data.accounts.some(a => a.id === preset.defaultAccountId) ? preset.defaultAccountId : null;
    if (!accountId) reasons.push(accText ? `contul „${accText}” nu e asociat cu un cont din aplicație` : 'alege contul implicit');

    const ref = rowRef(ctx, cells);
    const inst = instrumentKey(ref) ? matchInstrument(ref, instruments) : undefined;

    const curText = get(ctx, cells, 'currency').toUpperCase();
    let currency: Currency | undefined;
    if (curText) {
      if ((CURRENCIES as readonly string[]).includes(curText)) currency = curText as Currency;
      else reasons.push(`moneda „${curText}” nu e suportată (doar ${CURRENCIES.join(', ')})`);
    } else {
      currency = inst?.currency ?? data.accounts.find(a => a.id === accountId)?.currency ?? preset.defaultCurrency;
      if (!currency) reasons.push('lipsește moneda');
    }

    if (reasons.length || !type || !date || !accountId || !currency) continue;

    const tx: Omit<Transaction, 'id'> = { date, type, accountId, currency };
    const qty = nums.quantity === undefined ? undefined : Math.abs(nums.quantity);
    const amount = nums.amount === undefined ? undefined : Math.abs(nums.amount);
    if (isInstrumentType(type)) {
      if (!inst) { reasons.push(instrumentKey(ref) ? 'instrument nou neconfirmat' : 'lipsește instrumentul (ticker, ISIN sau nume)'); continue; }
      tx.instrumentId = inst.id;
      tx.quantity = qty;
      tx.price = nums.price !== undefined ? Math.abs(nums.price) : qty && amount !== undefined ? amount / qty : undefined;
      if (!(tx.quantity! > 0)) reasons.push('cantitatea lipsește sau e zero');
      if (tx.price === undefined) reasons.push('lipsește prețul (sau suma totală)');
    } else if (usesAmount(type)) {
      if (inst && (type === 'dividend' || type === 'interest')) tx.instrumentId = inst.id;
      tx.amount = amount ?? (qty !== undefined && nums.price !== undefined ? qty * Math.abs(nums.price) : undefined);
      if (!(tx.amount! > 0)) reasons.push('lipsește suma');
    } else {
      // transfer
      const toText = get(ctx, cells, 'toAccount');
      const to = toText ? resolveAccount(ctx, toText) : null;
      if (!to) reasons.push(toText ? `contul destinație „${toText}” nu există` : 'transferul are nevoie de contul destinație');
      else if (to === accountId) reasons.push('contul destinație e același cu contul sursă');
      else tx.toAccountId = to;
      if (inst) { tx.instrumentId = inst.id; tx.quantity = qty; if (!(qty! > 0)) reasons.push('lipsește cantitatea'); }
      else { tx.amount = amount; if (!(amount! > 0)) reasons.push('lipsește suma'); }
    }
    if (nums.fees) tx.fees = Math.abs(nums.fees);
    if (nums.withheldTax) tx.withheldTax = Math.abs(nums.withheldTax);
    const note = get(ctx, cells, 'note');
    if (note) tx.note = note.slice(0, 500);
    if (reasons.length) continue;

    out.tx = tx;
    if (tx.instrumentId && newIds.has(tx.instrumentId)) out.newInstrumentKey = newInstruments.find(i => i.id === tx.instrumentId)!.key;
    const k = dupKey(tx);
    const left = existing.get(k);
    if (left?.length) {
      out.status = 'duplicate';
      out.duplicateOf = left.shift();
      reasons.push('există deja în registru');
    } else out.status = 'new';
  }

  const counts: Record<RowStatus, number> = { new: 0, duplicate: 0, error: 0, skipped: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, counts };
}

/**
 * Returns a copy of `data` with the chosen rows added as transactions and the new instruments they use.
 * `include` = lines to import (new rows by default; duplicates only if George ticked them). Error rows never.
 */
export function applyImport(
  data: InvestData,
  preview: Preview,
  include: Set<number>,
  newInstruments: (Instrument & { key: string })[],
  newId: () => string,
): { data: InvestData; added: number; instrumentsAdded: number } {
  const next = structuredClone(data);
  const chosen = preview.rows.filter(r => r.tx && include.has(r.line) && (r.status === 'new' || r.status === 'duplicate'));
  const usedIds = new Set(chosen.map(r => r.tx!.instrumentId).filter(Boolean));
  const toAdd = newInstruments.filter(i => usedIds.has(i.id) && !next.instruments.some(x => x.id === i.id));
  for (const { key: _key, ...inst } of toAdd) next.instruments.push(clean(inst));
  for (const r of chosen) next.transactions.push(clean({ id: newId(), ...r.tx! }));
  return { data: next, added: chosen.length, instrumentsAdded: toAdd.length };
}

/** Drops undefined keys so the strict validator doesn't reject them. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

/** Romanian names of the fields (mapping step and error messages). */
export const FIELD_LABEL: Record<ImportField, string> = {
  date: 'Data', type: 'Tipul tranzacției', ticker: 'Ticker', isin: 'ISIN', name: 'Nume instrument',
  quantity: 'Cantitate', price: 'Preț / unitate', currency: 'Moneda', fees: 'Comision', withheldTax: 'Impozit reținut',
  amount: 'Sumă (totală)', account: 'Cont', toAccount: 'Cont destinație (transfer)', note: 'Notă',
};
