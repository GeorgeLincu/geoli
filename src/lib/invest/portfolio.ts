// Valuation, allocation vs target, "rebalance with contributions" and the government-bond ladder.
// Pure functions on top of the ledger; the page only formats what comes out of here.
import type { AssetClass, Currency, InvestData, Region, TargetAllocation } from './types';
import type { Ledger } from './ledger';
import type { FxSource } from './fx';
import type { PriceSource } from './prices';
import { convert } from './fx';

export type ValueBasis = 'market' | 'face' | 'cost' | 'pension' | 'cash';

export interface Holding {
  key: string;
  kind: 'position' | 'cash' | 'pension';
  accountId: string;
  instrumentId?: string;
  assetClass: AssetClass;
  region: Region;
  currency: Currency;
  quantity?: number;
  price?: number;
  priceDate?: string;
  basis: ValueBasis;
  /** In `currency` */
  value: number;
  cost?: number;
  /** value − cost, in `currency` (positions only) */
  unrealized?: number;
  valueEur: number | null;
  valueRon: number | null;
}

export interface Valuation {
  date: string;
  holdings: Holding[];
  totalEur: number;
  totalRon: number;
  /** Currencies without a usable rate (their holdings are left out of the totals) */
  missingFx: Currency[];
}

const regionOfCurrency = (c: Currency): Region => (c === 'RON' ? 'romania' : c === 'EUR' ? 'europe' : c === 'USD' ? 'us' : 'other');

export function valuePortfolio(data: InvestData, ledger: Ledger, prices: PriceSource, fx: FxSource, date: string): Valuation {
  const instruments = new Map(data.instruments.map(i => [i.id, i]));
  const accounts = new Map(data.accounts.map(a => [a.id, a]));
  const holdings: Holding[] = [];
  const missing = new Set<Currency>();

  const finish = (h: Omit<Holding, 'valueEur' | 'valueRon'>): Holding => {
    const valueEur = convert(fx, h.value, h.currency, 'EUR', date);
    const valueRon = convert(fx, h.value, h.currency, 'RON', date);
    if (valueEur === null || valueRon === null) missing.add(h.currency === 'RON' ? 'EUR' : h.currency);
    return { ...h, valueEur, valueRon };
  };

  for (const p of ledger.positions) {
    const inst = instruments.get(p.instrumentId);
    if (!inst) continue;
    const q = prices.price(inst.id, date);
    let price: number, basis: ValueBasis, priceDate: string | undefined;
    if (q) { price = q.price; basis = 'market'; priceDate = q.date; }
    else if (inst.faceValue !== undefined) { price = inst.faceValue; basis = 'face'; }
    else { price = p.avgCost; basis = 'cost'; }
    const value = p.quantity * price;
    holdings.push(finish({
      key: `pos:${p.accountId}:${inst.id}`, kind: 'position', accountId: p.accountId, instrumentId: inst.id,
      assetClass: inst.assetClass, region: inst.region, currency: inst.currency,
      quantity: p.quantity, price, priceDate, basis, value, cost: p.cost, unrealized: value - p.cost,
    }));
  }

  for (const c of ledger.cash) {
    if (!ledger.cashTracked.has(c.accountId)) continue;
    const acc = accounts.get(c.accountId);
    if (!acc || acc.type === 'pillar2' || acc.type === 'pillar3') continue;
    holdings.push(finish({
      key: `cash:${c.accountId}:${c.currency}`, kind: 'cash', accountId: c.accountId,
      assetClass: 'cash', region: regionOfCurrency(c.currency), currency: c.currency, basis: 'cash', value: c.amount,
    }));
  }

  for (const acc of data.accounts) {
    if (acc.type !== 'pillar2' && acc.type !== 'pillar3') continue;
    const v = latestPensionValue(data, acc.id, date);
    if (!v) continue;
    holdings.push(finish({
      key: `pen:${acc.id}`, kind: 'pension', accountId: acc.id, assetClass: 'pension', region: 'romania',
      currency: acc.currency, basis: 'pension', value: v.value, priceDate: v.date,
    }));
  }

  let totalEur = 0, totalRon = 0;
  for (const h of holdings) { totalEur += h.valueEur ?? 0; totalRon += h.valueRon ?? 0; }
  return { date, holdings, totalEur, totalRon, missingFx: [...missing] };
}

export function latestPensionValue(data: InvestData, accountId: string, date: string) {
  let best: { date: string; value: number } | undefined;
  for (const v of data.pensionValues ?? []) {
    if (v.accountId !== accountId || v.date > date) continue;
    if (!best || v.date >= best.date) best = v;
  }
  return best;
}

// ─── Allocation tree (sunburst) ───

export interface TreeNode { name: string; value: number; children?: TreeNode[] }

/** asset class → region → instrument/account, values in EUR (positive holdings only). */
export function allocationTree(holdings: readonly Holding[], label: (h: Holding) => string): TreeNode[] {
  const classes = new Map<string, Map<string, Map<string, number>>>();
  for (const h of holdings) {
    const v = h.valueEur ?? 0;
    if (v <= 0) continue;
    const regions = classes.get(h.assetClass) ?? new Map<string, Map<string, number>>();
    const leaves = regions.get(h.region) ?? new Map<string, number>();
    const name = label(h);
    leaves.set(name, (leaves.get(name) ?? 0) + v);
    regions.set(h.region, leaves);
    classes.set(h.assetClass, regions);
  }
  const sum = (ns: TreeNode[]) => ns.reduce((s, n) => s + n.value, 0);
  return [...classes].map(([cls, regions]) => {
    const rs = [...regions].map(([reg, leaves]) => {
      const ls = [...leaves].map(([name, value]) => ({ name, value }));
      return { name: reg, value: sum(ls), children: ls };
    });
    return { name: cls, value: sum(rs), children: rs };
  });
}

// ─── Target allocation and drift ───

/**
 * The most specific target row a holding belongs to: same instrument, else same class + region
 * (row without instrument), else same class (row without region or instrument). Null = not in the target.
 */
export function matchTarget(h: Pick<Holding, 'instrumentId' | 'assetClass' | 'region'>, targets: readonly TargetAllocation[]): TargetAllocation | null {
  if (h.instrumentId) {
    const t = targets.find(t => t.instrumentId === h.instrumentId);
    if (t) return t;
  }
  return targets.find(t => !t.instrumentId && t.assetClass === h.assetClass && t.region === h.region)
    ?? targets.find(t => !t.instrumentId && !t.region && t.assetClass === h.assetClass)
    ?? null;
}

export interface DriftRow {
  target: TargetAllocation;
  /** EUR */
  value: number;
  actualWeight: number;
  /** actual − target, as a decimal (0.03 = +3 pp) */
  diff: number;
  status: 'ok' | 'over' | 'under';
}

export interface DriftResult {
  rows: DriftRow[];
  /** EUR value of holdings in scope that match no target row (left out of the weights) */
  unmatched: number;
  /** EUR value of the holdings that match a target row: the base for the weights */
  total: number;
  weightSum: number;
}

/**
 * Drift of the holdings against the target rows. Weights are relative to the value the target covers, so a
 * holding with no matching row (e.g. cash when the target has no cash row) doesn't distort the others.
 */
export function computeDrift(holdings: readonly Holding[], targets: readonly TargetAllocation[], defaultBand = 0.05): DriftResult {
  const byTarget = new Map<string, number>();
  let unmatched = 0, total = 0;
  for (const h of holdings) {
    const v = h.valueEur ?? 0;
    const t = matchTarget(h, targets);
    if (t) { byTarget.set(t.id, (byTarget.get(t.id) ?? 0) + v); total += v; } else unmatched += v;
  }
  const rows = targets.map(target => {
    const value = byTarget.get(target.id) ?? 0;
    const actualWeight = total > 0 ? value / total : 0;
    const diff = actualWeight - target.weight;
    const band = target.band ?? defaultBand;
    const status: DriftRow['status'] = diff > band + 1e-12 ? 'over' : diff < -band - 1e-12 ? 'under' : 'ok';
    return { target, value, actualWeight, diff, status };
  });
  return { rows, unmatched, total, weightSum: targets.reduce((s, t) => s + t.weight, 0) };
}

/**
 * "Rebalance with contributions": split a new contribution across target rows without selling, so the
 * portfolio moves as close as possible to the target. Water-filling: find the level L where
 * Σ max(0, L·wᵢ − currentᵢ) = contribution, then buyᵢ = max(0, L·wᵢ − currentᵢ). This tops up the most
 * underweight rows first (relative to their weight) and never buys a row that would end above its target.
 * Weights are normalised to sum to 1. Values in any single currency.
 */
export function rebalanceWithContribution(rows: readonly { id: string; weight: number; value: number }[], contribution: number): Map<string, number> {
  const out = new Map<string, number>(rows.map(r => [r.id, 0]));
  const wSum = rows.reduce((s, r) => s + Math.max(0, r.weight), 0);
  if (!(contribution > 0) || wSum <= 0) return out;
  const items = rows.filter(r => r.weight > 0).map(r => ({ id: r.id, w: r.weight / wSum, v: Math.max(0, r.value) }));
  // Level where the row starts receiving money: v/w. Sort by it and fill.
  items.sort((a, b) => a.v / a.w - b.v / b.w);
  let remaining = contribution;
  let level = items[0].v / items[0].w;
  let wActive = 0;
  for (let i = 0; i < items.length; i++) {
    wActive += items[i].w;
    const nextLevel = i + 1 < items.length ? items[i + 1].v / items[i + 1].w : Infinity;
    // Money needed to lift all active rows from `level` to `nextLevel`
    const need = (nextLevel - level) * wActive;
    if (need >= remaining) { level += remaining / wActive; remaining = 0; break; }
    remaining -= need; level = nextLevel;
  }
  for (const it of items) out.set(it.id, Math.max(0, level * it.w - it.v));
  // Remove floating-point dust so the parts add up exactly to the contribution
  const sum = [...out.values()].reduce((s, x) => s + x, 0);
  if (sum > 0) for (const [k, x] of out) out.set(k, (x * contribution) / sum);
  return out;
}

// ─── Government bonds: maturity ladder ───

export interface LadderRow {
  accountId: string;
  instrumentId: string;
  maturity: string;
  currency: Currency;
  quantity: number;
  /** Nominal amount repaid at maturity (quantity × face value, else the cost) */
  face: number;
  /** Yearly coupon in currency (face × coupon), if the coupon is known */
  yearlyCoupon: number | null;
  faceRon: number | null;
  matured: boolean;
}

export function bondLadder(data: InvestData, ledger: Ledger, fx: FxSource, today: string): LadderRow[] {
  const instruments = new Map(data.instruments.map(i => [i.id, i]));
  const rows: LadderRow[] = [];
  for (const p of ledger.positions) {
    const inst = instruments.get(p.instrumentId);
    if (!inst?.maturity) continue;
    const face = inst.faceValue !== undefined ? p.quantity * inst.faceValue : p.cost;
    rows.push({
      accountId: p.accountId, instrumentId: inst.id, maturity: inst.maturity, currency: inst.currency,
      quantity: p.quantity, face, yearlyCoupon: inst.coupon !== undefined ? face * inst.coupon : null,
      faceRon: convert(fx, face, inst.currency, 'RON', today), matured: inst.maturity <= today,
    });
  }
  return rows.sort((a, b) => a.maturity.localeCompare(b.maturity));
}
