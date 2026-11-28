// Data model for the private investment section (/vault/invest/).
// Stored as JSON documents in R2 under invest/ and read/written through /vault/api/invest/<doc>.
// Amounts are plain numbers in the stated currency; dates are ISO strings (YYYY-MM-DD).

export const SCHEMA_VERSION = 1;

export type Currency = 'EUR' | 'RON' | 'USD' | 'GBP' | 'CHF';
export const CURRENCIES: readonly Currency[] = ['EUR', 'RON', 'USD', 'GBP', 'CHF'];

export type AccountType = 'foreign_broker' | 'ro_broker' | 'gov_bonds' | 'pillar2' | 'pillar3' | 'cash';
export const ACCOUNT_TYPES: readonly AccountType[] = ['foreign_broker', 'ro_broker', 'gov_bonds', 'pillar2', 'pillar3', 'cash'];

export type AssetClass = 'equity' | 'bond' | 'gov_bond' | 'gold' | 'cash' | 'real_estate' | 'pension' | 'other';
export type Region = 'global' | 'us' | 'europe' | 'romania' | 'emerging' | 'developed_ex_us' | 'other';
export type TxType = 'buy' | 'sell' | 'dividend' | 'interest' | 'fee' | 'deposit' | 'withdrawal' | 'transfer';
export const TX_TYPES: readonly TxType[] = ['buy', 'sell', 'dividend', 'interest', 'fee', 'deposit', 'withdrawal', 'transfer'];

/** Inputs for the plan / projection (Phase 1). All rates are decimals (0.04 = 4%). */
export interface Settings {
  birthYear?: number;
  baseCurrency: 'EUR';
  monthlyContribution?: number;
  /** Real change of the contribution per year, e.g. 0.03 */
  contributionGrowth?: number;
  yearsToInvest?: number;
  /** Desired yearly spending in retirement, in today's money */
  retirementSpending?: number;
  swr?: number;
  inflation?: number;
  /** Fallback capital when the ledger is empty */
  manualCapital?: number;
  /** Market assumptions and Monte Carlo options for the plan page (Phase 1) */
  projection?: ProjectionSettings;
  /** Retirement / withdrawal page (Phase 5) */
  retirement?: RetirementSettings;
  /** Instrument used as the yearly benchmark in the reports (its price change Dec 31 → Dec 31, in EUR) */
  benchmarkInstrumentId?: string;
}

/** One glidepath point: the allocation (decimals, by asset class) George wants at `age`. */
export interface GlidePathPoint { age: number; weights: Partial<Record<AssetClass, number>> }

/** Income in retirement besides the portfolio, entered by George: NET yearly amount in today's EUR. */
export interface RetirementIncome {
  id: string;
  kind: 'pillar2' | 'pillar3' | 'state' | 'other';
  label?: string;
  amount: number;
  startAge: number;
  /** Last age it is paid (inclusive); missing = for life */
  endAge?: number;
}

/** Inputs of /vault/invest/pensie/ (Phase 5). Age, spending, SWR, inflation and returns come from the plan. */
export interface RetirementSettings {
  strategy?: 'constant' | 'guardrails' | 'vpw' | 'floorCeiling';
  /** First withdrawal: spending minus other income (default) or SWR × balance at retirement */
  initial?: 'spending' | 'swr';
  gkGuard?: number;
  gkAdjust?: number;
  gkMinYearsLeft?: number;
  /** Floor / ceiling as a share of the first withdrawal */
  floor?: number;
  ceiling?: number;
  /** VPW fixed real return; missing = expected return of the allocation at that age */
  vpwReturn?: number;
  glidepath?: GlidePathPoint[];
  incomes?: RetirementIncome[];
  /** Net-of-tax estimate */
  gainShare?: number;
  accountType?: 'foreign_broker' | 'ro_broker';
  /** RON per EUR; missing = latest BNR rate */
  eurRon?: number;
}

/** Expected REAL (after inflation) compound return and yearly volatility of one asset class, as decimals. */
export interface ClassAssumption { ret: number; vol: number }

/** One year of historical REAL returns per asset class (decimals), used by the bootstrap Monte Carlo. */
export interface HistoryYear { year: number; returns: Partial<Record<AssetClass, number>> }

export interface ProjectionSettings {
  /** Age until which the money must last (Monte Carlo horizon) */
  planToAge?: number;
  assumptions?: Partial<Record<AssetClass, ClassAssumption>>;
  /** Plan-only weights, used while the target allocation (Phase 2) is empty. Sum to 1. */
  weights?: Partial<Record<AssetClass, number>>;
  /** Average correlation between asset classes (normal Monte Carlo) */
  correlation?: number;
  mcMode?: 'normal' | 'bootstrap';
  mcRuns?: number;
  mcSeed?: number;
  /** Historical real returns for bootstrap mode, entered/pasted by George, with their source */
  history?: HistoryYear[];
  historySource?: string;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  /** Broker or institution name, free text */
  institution?: string;
  currency: Currency;
  notes?: string;
  closed?: boolean;
}

export interface Instrument {
  id: string;
  ticker?: string;
  isin?: string;
  name: string;
  assetClass: AssetClass;
  region: Region;
  currency: Currency;
  /** Accumulating (no payouts) or distributing */
  distribution?: 'accumulating' | 'distributing';
  /** Exchange / source key used by the price job (Phase 3), e.g. "xetra:VWCE" */
  priceSource?: string;
  /** Government bonds (Tezaur/Fidelis) */
  coupon?: number;
  maturity?: string;
  /** Nominal value per unit (Tezaur/Fidelis), used for the maturity ladder */
  faceValue?: number;
  /** Yearly fund cost (TER) as a decimal (0.0022 = 0.22%), entered by George; used on the Costuri page */
  ter?: number;
}

export interface Transaction {
  id: string;
  date: string;
  type: TxType;
  accountId: string;
  instrumentId?: string;
  quantity?: number;
  price?: number;
  /** Total cash amount for dividend/interest/fee/deposit/withdrawal */
  amount?: number;
  currency: Currency;
  fees?: number;
  /** Tax withheld at source (dividends, RO broker) */
  withheldTax?: number;
  /** For transfers between accounts */
  toAccountId?: string;
  note?: string;
}

/** One row of the target allocation. Weights are decimals and must sum to 1 across rows. */
export interface TargetAllocation {
  id: string;
  label: string;
  assetClass: AssetClass;
  region?: Region;
  instrumentId?: string;
  weight: number;
  /** Rebalancing band (absolute), e.g. 0.05 = ±5 percentage points */
  band?: number;
}

export interface Scenario {
  id: string;
  name: string;
  settings: Settings;
  createdAt: string;
}

/**
 * Year-end snapshot (Phase 7): invest/snapshots/<year>-12-31.json.
 * `computed` is filled automatically from the ledger + prices (+ netWorthAt); the top-level fields are
 * George's corrections and inputs, which win over the computed values in the reports.
 */
export interface YearSnapshot {
  version: typeof SCHEMA_VERSION;
  year: number;
  /** Always `<year>-12-31` */
  date: string;
  createdAt: string;
  updatedAt: string;
  computed: {
    computedAt: string;
    /** Report scope: every account except Pillar 2/3 */
    portfolioEur: number;
    portfolioRon: number;
    byAssetClass: Partial<Record<AssetClass, number>>;
    netWorthEur: number;
    netWorthRon: number;
    /** Positions valued at cost (no price on 31 Dec) */
    atCost: number;
    missingFx: Currency[];
  };
  /** Corrected portfolio value (EUR) */
  portfolioEur?: number;
  /** Corrected net worth (EUR) */
  netWorthEur?: number;
  /** Inflation of that year as a decimal (0.051 = 5.1%), entered by George, with where it comes from */
  inflation?: { rate: number; source?: string };
  note?: string;
}

/** invest/data.json */
export interface InvestData {
  version: typeof SCHEMA_VERSION;
  settings: Settings;
  accounts: Account[];
  instruments: Instrument[];
  transactions: Transaction[];
  targets: TargetAllocation[];
  scenarios: Scenario[];
  /** Manual prices per instrument and date, in the instrument's currency (Phase 2; Phase 3 overrides reuse this) */
  prices?: PricePoint[];
  /** Manual FX rates: RON per 1 unit of `currency` (BNR convention) */
  fxRates?: FxRate[];
  /** Pillar 2/3 account values entered by hand over time */
  pensionValues?: PensionValue[];
  /** Saved column mappings for the CSV import (/vault/invest/import/) */
  importPresets?: ImportPreset[];
  /** Income calendar (/vault/invest/calendar/): dividend schedules, planned cash-ins, coupon frequency, reinvest markers */
  calendar?: IncomeCalendar;
  /** Assets and debts outside the portfolio, for the full net worth (/vault/invest/avere/) */
  netWorth?: NetWorthDoc;
  /** Decision journal (/vault/invest/jurnal/): why George bought, sold or changed something */
  journal?: JournalEntry[];
  /** Real-estate purchases being considered or bought (/vault/invest/imobiliare/) */
  realEstate?: RealEstateDoc;
}

/** Expected dividends of one instrument, entered by George ('manual') or copied from last year's payments ('lastYear'). */
export interface DividendSchedule {
  id: string;
  instrumentId: string;
  mode: 'manual' | 'lastYear';
  /** manual: months of payment (1–12) */
  months?: number[];
  /** manual: day of the month (default 15) */
  day?: number;
  /** manual: gross amount per unit held */
  perUnit?: number;
  /** manual: currency of perUnit (default: the instrument's) */
  currency?: Currency;
  note?: string;
}

/** Another cash-in George expects (rent, bonus, a loan repaid…), one-off or repeating. */
export interface PlannedIncome {
  id: string;
  date: string;
  label: string;
  /** Gross amount */
  amount: number;
  currency: Currency;
  repeat?: 'none' | 'monthly' | 'quarterly' | 'yearly';
  /** Last date of a repeating cash-in (inclusive) */
  until?: string;
  /** George's own tax estimate as a decimal (no rule exists in tax-ro for this income) */
  taxRate?: number;
  note?: string;
}

/** Coupon schedule of a bond (Tezaur/Fidelis): payments per year, counted back from the maturity date. */
export interface BondSchedule { instrumentId: string; frequency: 1 | 2 | 4 | 12 }

/** "De reinvestit" marker for a maturity, with an optional e-mail reminder N days before. */
export interface ReinvestMarker {
  instrumentId: string;
  /** The instrument's maturity the marker belongs to (a changed maturity drops the marker) */
  maturity: string;
  remind: boolean;
  daysBefore: number;
  note?: string;
}

export interface IncomeCalendar {
  dividends?: DividendSchedule[];
  planned?: PlannedIncome[];
  bonds?: BondSchedule[];
  reinvest?: ReinvestMarker[];
}


// ─── Full net worth (/vault/invest/avere/) ───
// The investment portfolio is never re-entered here: it comes from the ledger + prices.

export type NetWorthAssetCategory = 'cash' | 'savings' | 'real_estate' | 'vehicle' | 'other';
export const NET_WORTH_ASSET_CATEGORIES: readonly NetWorthAssetCategory[] = ['cash', 'savings', 'real_estate', 'vehicle', 'other'];
export type LiabilityKind = 'mortgage' | 'loan' | 'credit_card' | 'other';
export const LIABILITY_KINDS: readonly LiabilityKind[] = ['mortgage', 'loan', 'credit_card', 'other'];

/** A value (asset) or balance (debt) recorded on a date, in the item's currency. Valid until the next entry. */
export interface DatedValue { date: string; value: number; note?: string }

export interface NetWorthAsset {
  id: string;
  name: string;
  category: NetWorthAssetCategory;
  currency: Currency;
  /** Can be turned into cash quickly. Missing = cash/savings yes, the rest no. */
  liquid?: boolean;
  /** Counts toward the emergency fund. Missing = cash/savings yes, the rest no. */
  emergency?: boolean;
  notes?: string;
  values: DatedValue[];
}

export interface Liability {
  id: string;
  name: string;
  kind: LiabilityKind;
  currency: Currency;
  /** Yearly interest rate as a decimal (0.055 = 5.5%) */
  rate?: number;
  /** Monthly instalment, in `currency` */
  monthlyPayment?: number;
  notes?: string;
  /** Outstanding balance over time (positive numbers) */
  balances: DatedValue[];
}

export interface NetWorthDoc {
  assets: NetWorthAsset[];
  liabilities: Liability[];
  /** Monthly expenses in EUR for the emergency-fund months. Missing = taken from the IPS rule, if any. */
  monthlyExpenses?: number;
}

/** Fields a CSV column can be mapped to by the transaction import. */
export type ImportField =
  | 'date' | 'type' | 'ticker' | 'isin' | 'name' | 'quantity' | 'price' | 'currency'
  | 'fees' | 'withheldTax' | 'amount' | 'account' | 'toAccount' | 'note';
export const IMPORT_FIELDS: readonly ImportField[] = [
  'date', 'type', 'ticker', 'isin', 'name', 'quantity', 'price', 'currency', 'fees', 'withheldTax', 'amount', 'account', 'toAccount', 'note',
];

/** A named CSV column mapping, so the next import of the same file layout is one click. */
export interface ImportPreset {
  id: string;
  name: string;
  delimiter: 'auto' | ',' | ';' | '	';
  decimal: 'auto' | ',' | '.';
  /** Order of day/month/year in dates that are not ISO (2024-03-05) or compact (20240305) */
  dateOrder: 'dmy' | 'mdy' | 'ymd';
  /** 1-based line of the header row; 0 or missing = detect it */
  headerRow?: number;
  /** Field → header text of the CSV column */
  columns: Partial<Record<ImportField, string>>;
  /** Value found in the type column (lower-case) → transaction type, or 'skip' to ignore the row */
  typeMap: Record<string, TxType | 'skip'>;
  /** No type column (or unmapped value): positive quantity = buy, negative = sell */
  typeFromSign?: boolean;
  /** Value found in the account column → account id */
  accountMap?: Record<string, string>;
  /** Account used when there is no account column or it is empty */
  defaultAccountId?: string;
  /** Currency used when neither the row nor the instrument gives one */
  defaultCurrency?: Currency;
}

export interface PricePoint {
  instrumentId: string;
  date: string;
  price: number;
  note?: string;
}

export interface FxRate {
  date: string;
  currency: Currency;
  /** RON per 1 unit of currency */
  ron: number;
  note?: string;
}

export interface PensionValue {
  id: string;
  accountId: string;
  date: string;
  /** Account value in the account's currency */
  value: number;
  note?: string;
}

/** A tax parameter with provenance — values are never hard-coded (Phase 4). */
export interface TaxParam {
  value: number;
  source?: string;
  verifiedOn?: string;
  note?: string;
  /** Confirmed by George for this year (Phase 4). Missing = falls back to the year's `confirmed`. */
  confirmed?: boolean;
}

/** Romanian tax parameters for one fiscal year (Phase 4). Keys are free-form so new rules can be added. */
export interface TaxRuleSet {
  year: number;
  confirmed: boolean;
  params: Record<string, TaxParam>;
}

/** invest/tax-rules.json */
export interface TaxRules {
  version: typeof SCHEMA_VERSION;
  years: TaxRuleSet[];
}

/** One "extra buy on a market drop" rule: when the reference is `dropPct` below its high, do `action`. */
export interface IpsCrashRule {
  id: string;
  /** Drop below the high, as a decimal (0.2 = 20% below the high) */
  dropPct: number;
  /** What George decided to do, in his own words */
  action?: string;
  /** Optional extra amount to invest, EUR */
  extraAmount?: number;
}

/**
 * Machine-checkable IPS rules (Phase 6). Every field is optional: no field = no check.
 * The allocation and its bands are NOT here: they live in data.json `targets` (Phase 2) and are linked.
 * Other phases read these through `activeIpsRules()` in src/lib/invest/ips-checks.ts.
 */
export interface IpsRules {
  /** Alert when a target row leaves its band (bands from data.json targets) */
  driftAlerts?: boolean;
  /** Emergency fund: N months × monthly expenses (EUR), held in the listed accounts */
  emergencyFund?: { months: number; monthlyExpenses: number; accountIds: string[] };
  /** Monthly contribution: amount (EUR) by `day` of the month, with optional grace days */
  contribution?: { amount: number; day: number; graceDays?: number };
  /** Month (1–12) of the yearly IPS review */
  reviewMonth?: number;
  /** Tax-return reminder (Declarația Unică): deadline month/day entered by George, remind N days before */
  taxReturn?: { month: number; day: number; remindDaysBefore?: number };
  /** Extra buys on market drops, measured on `referenceInstrumentId` (its price vs its high) */
  crash?: { referenceInstrumentId?: string; rules: IpsCrashRule[] };
}

/** invest/ips.json — written by George (Phase 6) */
export interface IpsVersion {
  date: string;
  changeNote?: string;
  sections: Record<string, string>;
  /** Structured rules in force from this version on */
  rules?: IpsRules;
}
/** Work in progress, not yet a version (rules here are not enforced) */
export interface IpsDraft {
  savedAt: string;
  sections: Record<string, string>;
  rules?: IpsRules;
}
export interface IpsDoc {
  version: typeof SCHEMA_VERSION;
  versions: IpsVersion[];
  draft?: IpsDraft;
}

export type DocName = 'data' | 'tax-rules' | 'ips';
export const DOC_NAMES: readonly DocName[] = ['data', 'tax-rules', 'ips'];

export const emptyData = (): InvestData => ({
  version: SCHEMA_VERSION,
  settings: { baseCurrency: 'EUR' },
  accounts: [], instruments: [], transactions: [], targets: [], scenarios: [],
});
export const emptyTaxRules = (): TaxRules => ({ version: SCHEMA_VERSION, years: [] });
export const emptyIps = (): IpsDoc => ({ version: SCHEMA_VERSION, versions: [] });

export const emptyDoc = (name: DocName) =>
  name === 'data' ? emptyData() : name === 'tax-rules' ? emptyTaxRules() : emptyIps();

/** One decision-journal entry, written by George. `review` is what he notes later about how it turned out. */
export interface JournalEntry {
  id: string;
  date: string;
  title: string;
  text: string;
  /** Linked transaction(s), optional */
  txIds?: string[];
  instrumentId?: string;
  review?: string;
  reviewedOn?: string;
}

// ─── Real estate (/vault/invest/imobiliare/) ───
// Everything here is typed by George (prices, rates, IRCC, rents); nothing is pre-filled.

export type PropertyUse = 'home' | 'rental';

/** One purchase cost besides the price: notary, land registry, valuation, agency, renovation, furniture… */
export interface CostItem { id: string; label: string; amount: number; currency: Currency }

/** Mortgage in RON. Rates are yearly decimals (0.055 = 5.5%), monthly rate = yearly / 12 as banks quote them. */
export interface MortgageLoan {
  /** Loan amount; missing = price − down payment at the scenario's EUR/RON rate */
  principalRon?: number;
  months: number;
  type: 'annuity' | 'decreasing';
  /** First instalment month, YYYY-MM */
  startMonth: string;
  /** Fixed rate for the first `fixedMonths` (0 months = variable from the start) */
  fixedRate: number;
  fixedMonths: number;
  /** After the fixed period: IRCC + margin */
  ircc?: number;
  margin?: number;
  /** IRCC changes to test, as decimals (0.01 = +1 pp) */
  irccScenarios?: number[];
  /** Fees at signing (analysis, valuation…), RON */
  upfrontFeesRon?: number;
  /** Monthly account/administration fee, RON */
  monthlyFeeRon?: number;
  /** Life insurance: yearly share of the outstanding balance */
  lifeInsuranceRate?: number;
  /** Home insurance, RON per year */
  propertyInsuranceRon?: number;
}

/** Extra repayment: once, or `count` times every `everyMonths` months from `month`. */
export interface Prepayment {
  id: string;
  kind: 'once' | 'recurring';
  amountRon: number;
  /** First (or only) month, YYYY-MM */
  month: string;
  count?: number;
  everyMonths?: number;
  /** Keep the instalment and shorten the loan, or keep the term and lower the instalment */
  effect: 'term' | 'installment';
  /** Months (YYYY-MM) George marked as actually paid */
  done?: string[];
  note?: string;
}

/** Rent received (rental) or rent George would otherwise pay (home), with running costs. */
export interface RentAssumptions {
  /** EUR per month */
  monthlyEur?: number;
  /** Share of the year rented (rental), e.g. 0.92 */
  occupancy?: number;
  /** Agency/management, share of the rent collected */
  managementPct?: number;
  /** Repairs and upkeep, yearly share of the property value */
  maintenancePct?: number;
  /** Other yearly costs (property tax, building fees not paid by the tenant…), EUR */
  otherYearlyEur?: number;
  /** Yearly rent increase, decimal */
  growth?: number;
}

export interface PropertyScenario {
  id: string;
  name: string;
  use: PropertyUse;
  priceEur: number;
  /** Planned or actual purchase date */
  purchaseDate: string;
  /** Down payment as a share of the price (0.15 = 15%) */
  downPct: number;
  /** RON per EUR used for this scenario; missing = latest BNR rate */
  eurRon?: number;
  costs: CostItem[];
  /** No loan = cash purchase */
  loan?: MortgageLoan;
  prepayments: Prepayment[];
  rent?: RentAssumptions;
  /** Expected yearly price change, decimal */
  appreciation?: number;
  /** Years to compare / hold before a (hypothetical) sale */
  holdYears?: number;
  /** Selling costs, share of the sale price */
  sellCostPct?: number;
  /** Household net income and other debt instalments per month, RON (debt-to-income) */
  monthlyIncomeRon?: number;
  otherDebtRon?: number;
  status: 'draft' | 'bought';
  /** Items created in data.json netWorth when George marks it as bought */
  netWorthAssetId?: string;
  netWorthLiabilityId?: string;
  note?: string;
}

/** A legal/market rule with provenance (like the tax parameters): prepayment fees, rent tax, BNR limits. */
export interface RealEstateParam { value: number; source?: string; verifiedOn?: string; confirmed?: boolean; note?: string }

export interface RealEstateDoc {
  scenarios: PropertyScenario[];
  params?: Record<string, RealEstateParam>;
  /** Scenario ids picked for the comparison (2–3) */
  compare?: string[];
}
