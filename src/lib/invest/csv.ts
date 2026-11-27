// CSV export of transactions. Semicolon-separated with decimal commas, so it opens directly in Excel
// set to Romanian; UTF-8 with BOM so diacritics survive.
import type { InvestData } from './types';

const cell = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_COLUMNS = [
  'data', 'tip', 'cont', 'instrument', 'ticker', 'isin', 'cantitate', 'pret', 'suma', 'moneda', 'comision', 'impozit_retinut', 'cont_destinatie', 'nota', 'id',
] as const;

export function transactionsCsv(data: Pick<InvestData, 'accounts' | 'instruments' | 'transactions'>): string {
  const acc = new Map(data.accounts.map(a => [a.id, a.name]));
  const inst = new Map(data.instruments.map(i => [i.id, i]));
  const rows = [...data.transactions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(t => {
      const i = t.instrumentId ? inst.get(t.instrumentId) : undefined;
      return [
        t.date, t.type, acc.get(t.accountId) ?? t.accountId, i?.name, i?.ticker, i?.isin, t.quantity, t.price, t.amount,
        t.currency, t.fees, t.withheldTax, t.toAccountId ? acc.get(t.toAccountId) ?? t.toAccountId : undefined, t.note, t.id,
      ].map(cell).join(';');
    });
  return '﻿' + [CSV_COLUMNS.join(';'), ...rows].join('\r\n') + '\r\n';
}
