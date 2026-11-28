// Mortgage maths for /vault/invest/imobiliare/ (pure, tested in mortgage.test.ts).
//
// Conventions (as Romanian banks quote them):
//   - yearly nominal rates, monthly rate = yearly / 12; one instalment per month;
//   - fixed rate for the first `fixedMonths`, then IRCC + margin; at the switch the instalment is recomputed
//     over the remaining term (annuity) — the term doesn't change;
//   - annuity = equal instalments (P = B·r / (1 − (1 + r)^−n)); decreasing = equal principal parts (B / n) + interest;
//   - a prepayment is applied after that month's instalment. "term": the instalment stays and the loan ends earlier;
//     "installment": the term stays and the instalment drops. A prepayment fee (share of the amount) can apply,
//     different in the fixed and variable periods (parameters George confirms).
//   - DAE (APR) = yearly effective rate (XIRR) of: amount received − signing fees, then every instalment + monthly fee +
//     insurance, without prepayments.
import type { MortgageLoan, Prepayment } from './types';
import { xirr } from './returns';

export const addMonths = (ym: string, n: number) => {
  let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};
export const monthsBetween = (a: string, b: string) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

/** Instalment of an annuity: balance B, monthly rate r, n months. */
export function annuityPayment(balance: number, r: number, n: number): number {
  if (n <= 0) return balance;
  if (Math.abs(r) < 1e-12) return balance / n;
  return (balance * r) / (1 - Math.pow(1 + r, -n));
}

/** Months an annuity with instalment P needs to repay B at monthly rate r (Infinity if P doesn't cover the interest). */
export function annuityMonths(balance: number, r: number, payment: number): number {
  if (balance <= 0) return 0;
  if (Math.abs(r) < 1e-12) return Math.ceil(balance / payment - 1e-9);
  if (payment <= balance * r) return Infinity;
  return Math.ceil(-Math.log(1 - (balance * r) / payment) / Math.log(1 + r) - 1e-9);
}

/** Prepayment amounts per month (YYYY-MM), recurring ones expanded. */
export function prepaymentPlan(list: readonly Prepayment[]): Map<string, { amount: number; effect: Prepayment['effect'] }> {
  const out = new Map<string, { amount: number; effect: Prepayment['effect'] }>();
  for (const p of list) {
    if (!(p.amountRon > 0)) continue;
    const n = p.kind === 'recurring' ? Math.max(1, p.count ?? 1) : 1;
    const step = p.kind === 'recurring' ? Math.max(1, p.everyMonths ?? 1) : 1;
    for (let k = 0; k < n; k++) {
      const ym = addMonths(p.month, k * step);
      const cur = out.get(ym);
      // Several prepayments in one month: amounts add up; "installment" wins if any asks for it
      out.set(ym, { amount: (cur?.amount ?? 0) + p.amountRon, effect: cur?.effect === 'installment' ? 'installment' : p.effect });
    }
  }
  return out;
}

export interface MortgageRow {
  /** 1-based instalment number */
  n: number;
  month: string;
  phase: 'fixed' | 'variable';
  /** Yearly rate applied this month */
  rate: number;
  interest: number;
  principal: number;
  /** interest + principal */
  payment: number;
  prepayment: number;
  prepaymentFee: number;
  insurance: number;
  fee: number;
  /** Balance after this month */
  balance: number;
  /** Everything paid this month */
  cash: number;
}

export interface MortgageSummary {
  months: number;
  endMonth: string;
  totalInterest: number;
  totalPrepaid: number;
  prepaymentFees: number;
  insurance: number;
  fees: number;
  /** Everything paid, signing fees included */
  totalCash: number;
  firstPayment: number;
  /** First instalment after the switch to IRCC + margin (null = no variable period reached) */
  variablePayment: number | null;
  maxPayment: number;
  /** IRCC missing while a variable period exists: the fixed rate was kept */
  variableRateMissing: boolean;
}

export interface ScheduleOptions {
  /** Added to IRCC in the variable period (scenario), decimal */
  irccShift?: number;
  prepayments?: readonly Prepayment[];
  /** Prepayment fee as a share of the amount, per period */
  prepayFee?: { fixed: number; variable: number };
}

/** Yearly rate in force for instalment n (1-based). */
export function rateFor(loan: MortgageLoan, n: number, irccShift = 0): { rate: number; phase: 'fixed' | 'variable'; missing: boolean } {
  if (n <= loan.fixedMonths) return { rate: loan.fixedRate, phase: 'fixed', missing: false };
  if (loan.ircc === undefined) return { rate: loan.fixedRate, phase: 'variable', missing: true };
  return { rate: Math.max(0, loan.ircc + irccShift) + (loan.margin ?? 0), phase: 'variable', missing: false };
}

export function schedule(loan: MortgageLoan, principal: number, opts: ScheduleOptions = {}): { rows: MortgageRow[]; summary: MortgageSummary } {
  const plan = prepaymentPlan(opts.prepayments ?? []);
  const rows: MortgageRow[] = [];
  let balance = principal;
  let termLeft = loan.months;
  let payment = 0;
  let principalPart = loan.months > 0 ? principal / loan.months : principal;
  let prevRate: number | null = null;
  let missing = false;

  for (let n = 1; balance > 0.005 && n <= 1200; n++) {
    const month = addMonths(loan.startMonth, n - 1);
    const { rate, phase, missing: miss } = rateFor(loan, n, opts.irccShift);
    if (miss) missing = true;
    const r = rate / 12;
    if (loan.type === 'annuity' && (prevRate === null || rate !== prevRate)) payment = annuityPayment(balance, r, termLeft);
    prevRate = rate;

    const interest = balance * r;
    let princ: number;
    if (loan.type === 'annuity') princ = Math.min(balance, Math.max(0, payment - interest));
    else princ = Math.min(balance, principalPart);
    if (termLeft <= 1) princ = balance; // last instalment clears rounding
    const insurance = balance * (loan.lifeInsuranceRate ?? 0) / 12 + (loan.propertyInsuranceRon ?? 0) / 12;
    const fee = loan.monthlyFeeRon ?? 0;
    balance -= princ;

    let prepayment = 0, prepaymentFee = 0;
    const extra = plan.get(month);
    if (extra && balance > 0.005) {
      prepayment = Math.min(extra.amount, balance);
      prepaymentFee = prepayment * (phase === 'fixed' ? opts.prepayFee?.fixed ?? 0 : opts.prepayFee?.variable ?? 0);
      balance -= prepayment;
      const left = termLeft - 1;
      if (balance > 0.005 && left > 0) {
        if (extra.effect === 'installment') {
          if (loan.type === 'annuity') payment = annuityPayment(balance, r, left);
          else principalPart = balance / left;
        } else {
          // Keep the instalment (annuity) or the principal part (decreasing): fewer months left
          const need = loan.type === 'annuity' ? annuityMonths(balance, r, payment) : Math.ceil(balance / principalPart - 1e-9);
          termLeft = Math.min(left, need) + 1;
        }
      }
    }
    const pay = interest + princ;
    rows.push({
      n, month, phase, rate, interest, principal: princ, payment: pay, prepayment, prepaymentFee, insurance, fee,
      balance: Math.max(0, balance), cash: pay + prepayment + prepaymentFee + insurance + fee,
    });
    termLeft -= 1;
    if (termLeft <= 0 && balance > 0.005) termLeft = 1; // safety: clear what's left next month
  }

  const sum = (k: keyof MortgageRow) => rows.reduce((s, x) => s + (x[k] as number), 0);
  const variable = rows.find(x => x.phase === 'variable');
  return {
    rows,
    summary: {
      months: rows.length,
      endMonth: rows.at(-1)?.month ?? loan.startMonth,
      totalInterest: sum('interest'),
      totalPrepaid: sum('prepayment'),
      prepaymentFees: sum('prepaymentFee'),
      insurance: sum('insurance'),
      fees: sum('fee'),
      totalCash: sum('cash') + (loan.upfrontFeesRon ?? 0),
      firstPayment: rows[0]?.payment ?? 0,
      variablePayment: variable ? variable.payment : null,
      maxPayment: rows.reduce((m, x) => Math.max(m, x.payment), 0),
      variableRateMissing: missing,
    },
  };
}

/** DAE: yearly effective cost of the loan with all its costs (no prepayments). */
export function dae(loan: MortgageLoan, principal: number, rows: readonly MortgageRow[]): number | null {
  const start = `${addMonths(loan.startMonth, -1)}-01`;
  const flows = [{ date: start, amount: principal - (loan.upfrontFeesRon ?? 0) }];
  for (const x of rows) flows.push({ date: `${x.month}-01`, amount: -(x.payment + x.fee + x.insurance) });
  return xirr(flows, 0.05);
}

export interface PrepaymentSavings {
  interestSaved: number;
  insuranceSaved: number;
  feesSaved: number;
  prepaymentFees: number;
  /** Everything not paid thanks to the prepayments, minus their fees */
  netSaved: number;
  monthsSaved: number;
  endBefore: string;
  endAfter: string;
}

export function prepaymentSavings(base: MortgageSummary, withPrepay: MortgageSummary): PrepaymentSavings {
  const interestSaved = base.totalInterest - withPrepay.totalInterest;
  const insuranceSaved = base.insurance - withPrepay.insurance;
  const feesSaved = base.fees - withPrepay.fees;
  return {
    interestSaved, insuranceSaved, feesSaved, prepaymentFees: withPrepay.prepaymentFees,
    netSaved: interestSaved + insuranceSaved + feesSaved - withPrepay.prepaymentFees,
    monthsSaved: base.months - withPrepay.months,
    endBefore: base.endMonth, endAfter: withPrepay.endMonth,
  };
}

/** Age in a month (YYYY-MM) from the birth year; approximate (birthday unknown). */
export const ageIn = (birthYear: number | undefined, ym: string) => (birthYear === undefined ? null : +ym.slice(0, 4) - birthYear);

/** Debt-to-income: (instalment + other debt instalments) / net monthly income. */
export const debtToIncome = (payment: number, income: number | undefined, otherDebt = 0) =>
  income && income > 0 ? (payment + otherDebt) / income : null;

/** Balance on a date (end of that month's instalment), for the net-worth link. */
export function balanceAt(rows: readonly MortgageRow[], principal: number, month: string): number {
  let b = principal;
  for (const x of rows) { if (x.month > month) break; b = x.balance; }
  return b;
}

/** Repayment schedule as CSV (semicolons, decimal commas, BOM — opens in Excel set to Romanian). */
export function scheduleCsv(rows: readonly MortgageRow[]): string {
  const n = (x: number) => (Math.round(x * 100) / 100).toString().replace('.', ',');
  const head = ['nr', 'luna', 'perioada', 'dobanda_anuala_%', 'rata', 'din_care_dobanda', 'din_care_principal', 'plata_anticipata', 'comision_anticipata', 'asigurari', 'comision_lunar', 'sold_dupa', 'total_platit_luna'];
  const lines = rows.map(r => [r.n, r.month, r.phase === 'fixed' ? 'fixa' : 'variabila', n(r.rate * 100), n(r.payment), n(r.interest), n(r.principal),
    n(r.prepayment), n(r.prepaymentFee), n(r.insurance), n(r.fee), n(r.balance), n(r.cash)].join(';'));
  return '\uFEFF' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}
