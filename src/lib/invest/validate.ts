// Structural validation for the invest/ JSON documents. Used by the Worker before every save
// (and testable with vitest). It checks shape and types, not business rules.
import {
  SCHEMA_VERSION, ACCOUNT_TYPES, CURRENCIES, TX_TYPES, DOC_NAMES, IMPORT_FIELDS,
  type DocName,
} from './types';

export const MAX_DOC_BYTES = 5 * 1024 * 1024;

type Check = (v: unknown, path: string, errs: string[]) => void;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (max = 500): Check => (v, p, e) => { if (typeof v !== 'string' || v.length > max) e.push(`${p}: text expected (max ${max})`); };
const num: Check = (v, p, e) => { if (typeof v !== 'number' || !Number.isFinite(v)) e.push(`${p}: number expected`); };
const bool: Check = (v, p, e) => { if (typeof v !== 'boolean') e.push(`${p}: true/false expected`); };
const date: Check = (v, p, e) => { if (typeof v !== 'string' || !DATE.test(v)) e.push(`${p}: date YYYY-MM-DD expected`); };
const oneOf = (allowed: readonly string[]): Check => (v, p, e) => { if (typeof v !== 'string' || !allowed.includes(v)) e.push(`${p}: one of ${allowed.join(', ')}`); };
const anyObj: Check = (v, p, e) => { if (!isObj(v)) e.push(`${p}: object expected`); };

/** required keys = true, optional = false */
function record(fields: Record<string, [Check, boolean]>, { strict = true } = {}): Check {
  return (v, p, e) => {
    if (!isObj(v)) { e.push(`${p}: object expected`); return; }
    for (const [k, [check, required]] of Object.entries(fields)) {
      if (v[k] === undefined) { if (required) e.push(`${p}.${k}: required`); continue; }
      check(v[k], `${p}.${k}`, e);
    }
    if (strict) for (const k of Object.keys(v)) if (!(k in fields)) e.push(`${p}.${k}: unknown field`);
  };
}
function list(item: Check, max = 100_000): Check {
  return (v, p, e) => {
    if (!Array.isArray(v)) { e.push(`${p}: list expected`); return; }
    if (v.length > max) { e.push(`${p}: too many items (max ${max})`); return; }
    v.forEach((x, i) => { if (e.length < 50) item(x, `${p}[${i}]`, e); });
  };
}
const id = str(64);

const ASSET_CLASSES = ['equity', 'bond', 'gov_bond', 'gold', 'cash', 'real_estate', 'pension', 'other'];
/** Object whose keys are asset classes and whose values pass `item`. */
const byClass = (item: Check): Check => (v, p, e) => {
  if (!isObj(v)) { e.push(`${p}: object expected`); return; }
  for (const [k, x] of Object.entries(v)) {
    if (!ASSET_CLASSES.includes(k)) e.push(`${p}.${k}: unknown asset class`);
    else item(x, `${p}.${k}`, e);
  }
};
const projection = record({
  planToAge: [num, false],
  assumptions: [byClass(record({ ret: [num, true], vol: [num, true] })), false],
  weights: [byClass(num), false], correlation: [num, false],
  mcMode: [oneOf(['normal', 'bootstrap']), false], mcRuns: [num, false], mcSeed: [num, false],
  history: [list(record({ year: [num, true], returns: [byClass(num), true] }), 300), false],
  historySource: [str(500), false],
});

const settings = record({
  birthYear: [num, false], baseCurrency: [oneOf(['EUR']), true], monthlyContribution: [num, false],
  contributionGrowth: [num, false], yearsToInvest: [num, false], retirementSpending: [num, false],
  swr: [num, false], inflation: [num, false], manualCapital: [num, false],
  projection: [projection, false],
});
const account = record({
  id: [id, true], name: [str(120), true], type: [oneOf(ACCOUNT_TYPES), true], institution: [str(120), false],
  currency: [oneOf(CURRENCIES), true], notes: [str(2000), false], closed: [bool, false],
});
const instrument = record({
  id: [id, true], ticker: [str(32), false], isin: [str(12), false], name: [str(160), true],
  assetClass: [oneOf(['equity', 'bond', 'gov_bond', 'gold', 'cash', 'real_estate', 'pension', 'other']), true],
  region: [oneOf(['global', 'us', 'europe', 'romania', 'emerging', 'developed_ex_us', 'other']), true],
  currency: [oneOf(CURRENCIES), true], distribution: [oneOf(['accumulating', 'distributing']), false],
  priceSource: [str(80), false], coupon: [num, false], maturity: [date, false], faceValue: [num, false],
});
const transaction = record({
  id: [id, true], date: [date, true], type: [oneOf(TX_TYPES), true], accountId: [id, true],
  instrumentId: [id, false], quantity: [num, false], price: [num, false], amount: [num, false],
  currency: [oneOf(CURRENCIES), true], fees: [num, false], withheldTax: [num, false],
  toAccountId: [id, false], note: [str(500), false],
});
const target = record({
  id: [id, true], label: [str(120), true],
  assetClass: [oneOf(['equity', 'bond', 'gov_bond', 'gold', 'cash', 'real_estate', 'pension', 'other']), true],
  region: [oneOf(['global', 'us', 'europe', 'romania', 'emerging', 'developed_ex_us', 'other']), false],
  instrumentId: [id, false], weight: [num, true], band: [num, false],
});
const scenario = record({ id: [id, true], name: [str(120), true], settings: [settings, true], createdAt: [str(40), true] });

const pricePoint = record({ instrumentId: [id, true], date: [date, true], price: [num, true], note: [str(200), false] });
const fxRate = record({ date: [date, true], currency: [oneOf(CURRENCIES), true], ron: [num, true], note: [str(200), false] });
const pensionValue = record({ id: [id, true], accountId: [id, true], date: [date, true], value: [num, true], note: [str(200), false] });

/** Object with free text keys (max 200 chars, max `max` entries) whose values pass `item`. */
const strMap = (item: Check, max = 500): Check => (v, p, e) => {
  if (!isObj(v)) { e.push(`${p}: object expected`); return; }
  const entries = Object.entries(v);
  if (entries.length > max) { e.push(`${p}: too many entries (max ${max})`); return; }
  for (const [k, x] of entries) {
    if (k.length > 200) e.push(`${p}: key too long`);
    else item(x, `${p}.${k}`, e);
  }
};
const importColumns: Check = (v, p, e) => {
  if (!isObj(v)) { e.push(`${p}: object expected`); return; }
  for (const [k, x] of Object.entries(v)) {
    if (!(IMPORT_FIELDS as readonly string[]).includes(k)) e.push(`${p}.${k}: unknown field`);
    else str(200)(x, `${p}.${k}`, e);
  }
};
const importPreset = record({
  id: [id, true], name: [str(120), true], delimiter: [oneOf(['auto', ',', ';', '	']), true],
  decimal: [oneOf(['auto', ',', '.']), true], dateOrder: [oneOf(['dmy', 'mdy', 'ymd']), true],
  headerRow: [num, false], columns: [importColumns, true],
  typeMap: [strMap(oneOf([...TX_TYPES, 'skip'])), true], typeFromSign: [bool, false],
  accountMap: [strMap(id), false], defaultAccountId: [id, false], defaultCurrency: [oneOf(CURRENCIES), false],
});

const month = (v: unknown, p: string, e: string[]) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 12) e.push(`${p}: month 1–12 expected`);
};
const couponFreq: Check = (v, p, e) => { if (v !== 1 && v !== 2 && v !== 4 && v !== 12) e.push(`${p}: 1, 2, 4 or 12 expected`); };
const calendar = record({
  dividends: [list(record({
    id: [id, true], instrumentId: [id, true], mode: [oneOf(['manual', 'lastYear']), true],
    months: [list(month, 12), false], day: [num, false], perUnit: [num, false],
    currency: [oneOf(CURRENCIES), false], note: [str(500), false],
  }), 500), false],
  planned: [list(record({
    id: [id, true], date: [date, true], label: [str(120), true], amount: [num, true], currency: [oneOf(CURRENCIES), true],
    repeat: [oneOf(['none', 'monthly', 'quarterly', 'yearly']), false], until: [date, false], taxRate: [num, false],
    note: [str(500), false],
  }), 500), false],
  bonds: [list(record({ instrumentId: [id, true], frequency: [couponFreq, true] }), 2000), false],
  reinvest: [list(record({
    instrumentId: [id, true], maturity: [date, true], remind: [bool, true], daysBefore: [num, true], note: [str(500), false],
  }), 2000), false],
});

const versionCheck: Check = (v, p, e) => { if (v !== SCHEMA_VERSION) e.push(`${p}: must be ${SCHEMA_VERSION}`); };

const data = record({
  version: [versionCheck, true], settings: [settings, true], accounts: [list(account, 500), true],
  instruments: [list(instrument, 2000), true], transactions: [list(transaction), true],
  targets: [list(target, 200), true], scenarios: [list(scenario, 200), true],
  prices: [list(pricePoint, 50_000), false], fxRates: [list(fxRate, 50_000), false],
  pensionValues: [list(pensionValue, 5000), false],
  importPresets: [list(importPreset, 50), false],
  calendar: [calendar, false],
});

const taxParam = record({ value: [num, true], source: [str(500), false], verifiedOn: [date, false], note: [str(1000), false], confirmed: [bool, false] });
const taxParams: Check = (v, p, e) => {
  if (!isObj(v)) { e.push(`${p}: object expected`); return; }
  for (const [k, x] of Object.entries(v)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(k)) e.push(`${p}.${k}: bad parameter name`);
    taxParam(x, `${p}.${k}`, e);
  }
};
const taxRules = record({
  version: [versionCheck, true],
  years: [list(record({ year: [num, true], confirmed: [bool, true], params: [taxParams, true] }), 200), true],
});

const ipsSections: Check = (v, p, e) => {
  if (!isObj(v)) { e.push(`${p}: object expected`); return; }
  for (const [k, x] of Object.entries(v)) str(50_000)(x, `${p}.${k}`, e);
};
const range = (min: number, max: number, int = false): Check => (v, p, e) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    e.push(`${p}: ${int ? 'whole ' : ''}number between ${min} and ${max} expected`);
  }
};
const ipsRules = record({
  driftAlerts: [bool, false],
  emergencyFund: [record({ months: [range(0, 120), true], monthlyExpenses: [range(0, 1e9), true], accountIds: [list(id, 100), true] }), false],
  contribution: [record({ amount: [range(0, 1e9), true], day: [range(1, 31, true), true], graceDays: [range(0, 31, true), false] }), false],
  reviewMonth: [range(1, 12, true), false],
  taxReturn: [record({ month: [range(1, 12, true), true], day: [range(1, 31, true), true], remindDaysBefore: [range(0, 366, true), false] }), false],
  crash: [record({
    referenceInstrumentId: [id, false],
    rules: [list(record({ id: [id, true], dropPct: [range(0, 1), true], action: [str(1000), false], extraAmount: [range(0, 1e9), false] }), 50), true],
  }), false],
});
const ips = record({
  version: [versionCheck, true],
  versions: [list(record({ date: [date, true], changeNote: [str(1000), false], sections: [ipsSections, true], rules: [ipsRules, false] }), 500), true],
  draft: [record({ savedAt: [str(40), true], sections: [ipsSections, true], rules: [ipsRules, false] }), false],
});

const CHECKS: Record<DocName, Check> = { data, 'tax-rules': taxRules, ips };

export const isDocName = (s: string): s is DocName => (DOC_NAMES as readonly string[]).includes(s);

/** Returns a list of problems (empty = valid). */
export function validateDoc(name: DocName, doc: unknown): string[] {
  const errs: string[] = [];
  (CHECKS[name] ?? anyObj)(doc, name, errs);
  return errs.slice(0, 50);
}
