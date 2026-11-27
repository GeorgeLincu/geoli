// Romanian UI labels for the enum values in types.ts (shared by the invest pages).
import type { AccountType, AssetClass, Region, TxType } from './types';

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  foreign_broker: 'Broker străin',
  ro_broker: 'Broker RO (BVB)',
  gov_bonds: 'Titluri de stat',
  pillar2: 'Pilon 2',
  pillar3: 'Pilon 3',
  cash: 'Cash / bancă',
};

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  equity: 'Acțiuni',
  bond: 'Obligațiuni',
  gov_bond: 'Titluri de stat',
  gold: 'Aur',
  cash: 'Cash',
  real_estate: 'Imobiliare',
  pension: 'Pensii (Pilon 2/3)',
  other: 'Altele',
};

export const REGION_LABEL: Record<Region, string> = {
  global: 'Global',
  us: 'SUA',
  europe: 'Europa',
  romania: 'România',
  emerging: 'Piețe emergente',
  developed_ex_us: 'Dezvoltate fără SUA',
  other: 'Altele',
};

export const TX_TYPE_LABEL: Record<TxType, string> = {
  buy: 'Cumpărare',
  sell: 'Vânzare',
  dividend: 'Dividend',
  interest: 'Dobândă / cupon',
  fee: 'Comision',
  deposit: 'Depunere',
  withdrawal: 'Retragere',
  transfer: 'Transfer',
};
