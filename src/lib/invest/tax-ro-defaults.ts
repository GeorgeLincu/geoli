// Researched Romanian tax parameters, offered on the Taxe page as a starting point ("Încarcă valorile cercetate").
// Every value carries its official source and the date it was checked. `confirmed` is true only for the values
// George confirmed; the rest stay unconfirmed until he ticks them in the UI.
// Loading them writes a copy into invest/tax-rules.json; later edits happen there, never here.
import type { TaxParam, TaxRuleSet } from './types';

const CF = 'https://legislatie.just.ro/Public/DetaliiDocument/171282';
const NM = 'https://legislatie.just.ro/Public/DetaliiDocument/307847';
const L239 = 'https://static.anaf.ro/static/10/Anaf/legislatie/L_239_2025.pdf';
const L141 = 'https://static.anaf.ro/static/10/Anaf/legislatie/L_141_2025.pdf';
const DIV2025 = 'https://static.anaf.ro/static/3/Cluj/20250130125605_cj_dividende_30ian2025.pdf';
const US_TREATY = 'https://www.irs.gov/pub/irs-trty/romania.pdf';
const HG146 = 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/308231';
const CHECKED = '2026-11-27';

const p = (value: number, source: string, note: string): TaxParam => ({ value, source, verifiedOn: CHECKED, note, confirmed: false });

/** Rules that are the same in 2025 and 2026 (Codul fiscal consolidated to 25.10.2026). */
const common = (): Record<string, TaxParam> => ({
  'cg.ro.holdDays': p(365, CF, 'CF art. 97 alin. (8^1). From 2026 the holding period is counted FIFO per symbol.'),
  'loss.carryYears': p(5, CF, 'CF art. 119 alin. (2)-(4) (OUG 115/2023, from 1.01.2024). Losses only offset foreign gains "pe fiecare țară" (not modelled). Losses left at 31.12.2023 keep their old 7-year window, under the 70% cap (art. 133 alin. (27)).'),
  'loss.offsetShare': p(0.7, CF, 'CF art. 119: carried losses offset at most 70% of each year’s net gain.'),
  'div.foreignCredit': p(1, CF, 'CF art. 131: credit capped at the RO tax, per country and income type; proof = document from the foreign tax authority or the payer/withholding agent.'),
  'div.usTreatyRate': p(0.1, US_TREATY, 'US–Romania treaty art. 10(2): US withholding on dividends at most 10% (with W-8BEN).'),
  'int.rate': p(0.1, CF, 'CF art. 97 alin. (1)-(3), art. 64. Unchanged 2025–2027.'),
  'int.govExempt': p(1, CF, 'CF art. 93 alin. (1) lit. a): interest on government securities (Tezaur, Fidelis) is non-taxable.'),
  'cass.rate': p(0.1, CF, 'CF art. 156.'),
  'cass.t1': p(6, CF, 'CF art. 170 alin. (2)-(3): 6–12 minimum wages → base of 6.'),
  'cass.t2': p(12, CF, 'CF art. 170: 12–24 → base of 12.'),
  'cass.t3': p(24, CF, 'CF art. 170: 24 and above → base of 24. Not changed by Legea 141/2025 or 239/2025.'),
  'cass.countRoGains': p(1, CF, 'CF art. 155 alin. (1) lit. g): all investment income counts, including RO-broker gains (a DU is needed when CASS is due, art. 122 alin. (7)). Open doubt: gross or net.'),
  'cass.countExemptInterest': p(0, CF, 'CF art. 170 alin. (5): non-taxable income (Tezaur/Fidelis) does not count.'),
  'cass.netOfWithheld': p(1, CF, 'CF art. 170 alin. (4) lit. d): dividends and interest count net of the tax withheld. Open doubt for foreign income (net of the foreign tax?).'),
  'cass.lossReducesBase': p(0, CF, 'Open doubt: the code does not say clearly whether carried losses reduce the CASS base; conservative = no.'),
  'cas.rate': p(0, CF, 'CF art. 137 alin. (1): investment income is not subject to CAS.'),
  'pillar3.maxEur': p(400, CF, 'CF art. 78 alin. (2) lit. a) pct. (iii) (reworded by OUG 8/2026): deducted from salary by the employer; no effect on investment income.'),
  'fx.gains': p(0, NM, 'Norme HG 1/2016 Titlul IV pct. 23 alin. (1): BNR rate valid for the day the gain is determined (foreign broker: date the sale price is paid, CF art. 94 alin. (10) lit. b)). Open doubt for the purchase leg; practice = daily BNR rate on each leg.'),
  'fx.income': p(1, CF, 'CF art. 131 alin. (6), Norme pct. 46 alin. (1): foreign dividends/interest and the foreign tax at the yearly average BNR rate.'),
  'fx.prevDay': p(0, NM, 'Norme pct. 23: the rate valid for that day (not the previous day).'),
  'du.month': p(5, CF, 'CF art. 122 alin. (3): Declarația Unică by 25 May of the next year; payment the same day.'),
  'du.day': p(25, CF, 'CF art. 122 alin. (3).'),
});

export const DEFAULT_RULE_SETS: TaxRuleSet[] = [
  {
    year: 2025, confirmed: false,
    params: {
      ...common(),
      'cg.foreign.rate': p(0.1, CF, 'CF art. 123 alin. (1^2) (text in force until 31.12.2025), art. 96, art. 119.'),
      'cg.ro.rateLong': p(0.01, CF, 'CF art. 97 alin. (8^1) (text 2023–2025): 1% for securities held ≥ 365 days; final.'),
      'cg.ro.rateShort': p(0.03, CF, 'CF art. 97 alin. (8^1) (text 2023–2025): 3% under 365 days; final. RO-broker losses are definitive (alin. (8^5)).'),
      'div.rate': p(0.1, DIV2025, 'CF art. 97 alin. (7) as amended by OUG 156/2024: 10% for dividends distributed from 1.01.2025.'),
      'cass.minWage': p(4050, CF, 'CF art. 135^1 alin. (3): minimum wage in force on 1 January of the income year (HG 1506/2024: 4 050 lei).'),
      'wage.min': p(4050, CF, 'HG 1506/2024: 4 050 lei from 1.01.2025.'),
    },
  },
  {
    year: 2026, confirmed: false,
    params: {
      ...common(),
      'cg.foreign.rate': p(0.16, L239, 'CF art. 123 alin. (1^2) as amended by Legea 239/2025 art. XII pct. 16; from income year 2026.'),
      'cg.ro.rateLong': p(0.03, L239, 'CF art. 97 alin. (8^1) as amended by Legea 239/2025 (art. XII pct. 12, art. XIII alin. (2) lit. c)): 3% for ≥ 365 days, transactions from 1.01.2026.'),
      'cg.ro.rateShort': p(0.06, L239, 'Same: 6% under 365 days, from 1.01.2026; final. RO-broker losses are definitive.'),
      'div.rate': p(0.16, L141, 'CF art. 97 alin. (7) as amended by Legea 141/2025 art. II pct. 5: 16% for dividends distributed from 1.01.2026.'),
      'cass.minWage': p(4050, CF, 'CF art. 135^1 alin. (3): wage in force on 1.01.2026 = 4 050 lei (the 4 325 lei from 1.07.2026 does not apply to 2026 income).'),
      'wage.min': p(4050, HG146, '4 050 lei until 30.06.2026; 4 325 lei from 1.07.2026 (HG 146/2026).'),
    },
  },
];

export const RESEARCHED_YEARS = DEFAULT_RULE_SETS.map(s => s.year);

/** Researched rule set for a year (the latest researched year at or before it, re-labelled), or null. */
export function proposedRuleSet(year: number): TaxRuleSet | null {
  const base = [...DEFAULT_RULE_SETS].sort((a, b) => b.year - a.year).find(s => s.year <= year);
  if (!base) return null;
  const params: Record<string, TaxParam> = {};
  for (const [k, p] of Object.entries(base.params)) params[k] = { ...p, confirmed: base.year === year ? p.confirmed : false };
  return { year, confirmed: Object.values(params).every(p => p.confirmed), params };
}
