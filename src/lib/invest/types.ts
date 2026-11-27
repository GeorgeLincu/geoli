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
