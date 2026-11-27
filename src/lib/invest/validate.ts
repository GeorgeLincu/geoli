// Structural validation for the invest/ JSON documents. Used by the Worker before every save
// (and testable with vitest). It checks shape and types, not business rules.
import {
  SCHEMA_VERSION, ACCOUNT_TYPES, CURRENCIES, TX_TYPES, DOC_NAMES,
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
  priceSource: [str(80), false], coupon: [num, false], maturity: [date, false],
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

const versionCheck: Check = (v, p, e) => { if (v !== SCHEMA_VERSION) e.push(`${p}: must be ${SCHEMA_VERSION}`); };

const data = record({
  version: [versionCheck, true], settings: [settings, true], accounts: [list(account, 500), true],
  instruments: [list(instrument, 2000), true], transactions: [list(transaction), true],
  targets: [list(target, 200), true], scenarios: [list(scenario, 200), true],
});

const taxParam = record({ value: [num, true], source: [str(500), false], verifiedOn: [date, false], note: [str(1000), false] });
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
const ips = record({
  version: [versionCheck, true],
  versions: [list(record({ date: [date, true], changeNote: [str(1000), false], sections: [ipsSections, true] }), 500), true],
});

const CHECKS: Record<DocName, Check> = { data, 'tax-rules': taxRules, ips };

export const isDocName = (s: string): s is DocName => (DOC_NAMES as readonly string[]).includes(s);

/** Returns a list of problems (empty = valid). */
export function validateDoc(name: DocName, doc: unknown): string[] {
  const errs: string[] = [];
  (CHECKS[name] ?? anyObj)(doc, name, errs);
  return errs.slice(0, 50);
}
