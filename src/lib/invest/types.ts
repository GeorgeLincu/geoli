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

/** Year-end snapshot (Phase 7). */
export interface Snapshot {
  date: string;
  totalEur: number;
  byAssetClass: Partial<Record<AssetClass, number>>;
  contributionsYtd?: number;
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

/** invest/ips.json — written by George (Phase 6) */
export interface IpsVersion {
  date: string;
  changeNote?: string;
  sections: Record<string, string>;
}
export interface IpsDoc {
  version: typeof SCHEMA_VERSION;
  versions: IpsVersion[];
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
