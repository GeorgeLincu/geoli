// /vault/invest/pensie/ — withdrawal strategies, glidepath, other income, net income after tax (Phase 5).
// Plan inputs (age, spending, SWR, inflation, returns, Monte Carlo mode/seed) come from data.json settings,
// edited on the plan page. This page edits only settings.retirement and saves it with "Salvează".
// The simulation runs in the shared Monte Carlo Web Worker (mc.worker.ts → runRetirement).
import { loadDoc, loadMarket, saveDoc, type Loaded } from './api';
import { mountChart, axisStyle, type ChartTheme } from './charts';
import { toast, fmtEur, fmtDateTime } from './common';
import type { AssetClass, RetirementIncome, RetirementSettings, Settings, TaxRules, IpsDoc, TaxRuleSet } from '../../lib/invest/types';
import { ASSET_CLASSES, DEFAULTS, inputsFromSettings, type PlanInputs, type RequiredKey, type Weights } from '../../lib/invest/projection';
import { STRATEGIES, WITHDRAWAL_DEFAULTS, weightsAtAge, netIncome, type RetireInputs, type RetireResult, type StrategyKey } from '../../lib/invest/withdrawal';
import { rulesFor, unconfirmedParams, missingParams } from '../../lib/invest/tax-ro';
import { activeIpsRules, latestIpsVersion } from '../../lib/invest/ips-checks';
import { rateOn } from '../../lib/invest/market';
import type { McRequest, McResponse } from './mc.worker';

const YEAR = new Date().getFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ─── Formatting (ro-RO) ───
const fmtPct = (x: number, d = 1) => new Intl.NumberFormat('ro-RO', { style: 'percent', maximumFractionDigits: d }).format(x);
const fmtNum = (x: number, d = 1) => new Intl.NumberFormat('ro-RO', { maximumFractionDigits: d }).format(x);
const fmtC = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${fmtNum(n / 1e6, 2)} mil. €`;
  if (a >= 1e4) return `${fmtNum(n / 1e3, 0)} mii €`;
  return `${fmtNum(n, 0)} €`;
};

const STRAT_LABEL: Record<StrategyKey, string> = {
  constant: 'Sumă constantă', guardrails: 'Guyton-Klinger', vpw: 'VPW', floorCeiling: 'Podea și plafon',
};
const CLASS_LABEL: Record<AssetClass, string> = {
  equity: 'Acțiuni', bond: 'Obligațiuni', gov_bond: 'Titluri de stat', gold: 'Aur', cash: 'Numerar',
  real_estate: 'Imobiliare', pension: 'Pensii', other: 'Altele',
};
const KIND_LABEL: Record<RetirementIncome['kind'], string> = {
  pillar2: 'Pilon 2', pillar3: 'Pilon 3', state: 'Pensie de stat', other: 'Alt venit',
};
const MISSING_LABEL: Record<RequiredKey, string> = {
  age: 'vârsta', capital: 'capitalul investit', monthlyContribution: 'contribuția lunară',
  yearsToInvest: 'anii de investit', spending: 'cheltuiala la pensie', weights: 'ponderile claselor de active',
};

// ─── State ───
let loaded: Loaded<'data'>;
let settings: Settings = { baseCurrency: 'EUR' };
let ret: RetirementSettings = {};
let inputs: PlanInputs | null = null;
let baseWeights: Weights = {};
let result: RetireResult | null = null;
let taxSet: TaxRuleSet | null = null;
let taxExact = false;
let bnrEur: { rate: number; date: string } | null = null;
let dirty = false;

const strategy = (): StrategyKey => ret.strategy ?? WITHDRAWAL_DEFAULTS.strategy;
const eurRon = () => ret.eurRon ?? bnrEur?.rate ?? null;
const gainShare = () => ret.gainShare ?? 1;
const setOrDelete = <K extends keyof RetirementSettings>(k: K, v: RetirementSettings[K] | undefined) => {
  if (v === undefined) delete ret[k]; else ret[k] = v;
};
const parseNum = (raw: string): number | undefined => {
  if (raw.trim() === '') return undefined;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};
const shown = (v: number, pct = false) => String(pct ? Math.round(v * 100 * 1000) / 1000 : Math.round(v * 10000) / 10000);
const newId = () => Math.random().toString(36).slice(2, 10);

// ─── Plan summary ───
function renderFrom() {
  const res = inputsFromSettings(settings, loaded.doc.targets, YEAR, null);
  inputs = res.inputs;
  baseWeights = res.weights;
  $('emptyState').hidden = !!inputs;
  $('fromStats').hidden = !inputs;
  if (!inputs) { $('missingList').textContent = res.missing.map(k => MISSING_LABEL[k]).join(', '); return; }
  const p = settings.projection ?? {};
  const retAge = inputs.age + inputs.yearsToInvest;
  $('pRetAge').textContent = `${retAge} ani`;
  $('pAge').textContent = `acum ${inputs.age} ani, peste ${inputs.yearsToInvest} ani`;
  $('pPlanTo').textContent = `${inputs.planToAge} ani`;
  $('pSpend').textContent = fmtC(inputs.spending);
  $('pSwr').textContent = `${fmtPct(inputs.swr)} · ${fmtPct(inputs.inflation)}`;
  const wantBoot = p.mcMode === 'bootstrap';
  const boot = wantBoot && (p.history?.length ?? 0) > 0;
  $('pMc').textContent = `${fmtNum(p.mcRuns ?? DEFAULTS.mcRuns, 0)} × ${boot ? 'istoric' : 'normal'}`;
  $('pMcHint').textContent = wantBoot && !boot ? 'modul istoric nu are date, se folosește normal' : `sămânța ${p.mcSeed ?? DEFAULTS.mcSeed}`;
}

// ─── Strategy controls ───
type NumKey = 'gkGuard' | 'gkAdjust' | 'gkMinYearsLeft' | 'floor' | 'ceiling' | 'vpwReturn';
const NUM_FIELDS: Record<NumKey, { def?: number; pct: boolean }> = {
  gkGuard: { def: WITHDRAWAL_DEFAULTS.gkGuard, pct: true },
  gkAdjust: { def: WITHDRAWAL_DEFAULTS.gkAdjust, pct: true },
  gkMinYearsLeft: { def: WITHDRAWAL_DEFAULTS.gkMinYearsLeft, pct: false },
  floor: { def: WITHDRAWAL_DEFAULTS.floor, pct: true },
  ceiling: { def: WITHDRAWAL_DEFAULTS.ceiling, pct: true },
  vpwReturn: { pct: true },
};

function renderStrategy() {
  document.querySelectorAll<HTMLInputElement>('input[name="strategy"]').forEach(r => { r.checked = r.value === strategy(); });
  const init = $<HTMLSelectElement>('initial');
  init.value = ret.initial ?? WITHDRAWAL_DEFAULTS.initial;
  $('initialHint').textContent = init.value === 'spending'
    ? 'Portofoliul plătește cheltuiala din Plan minus veniturile de mai jos. Guyton-Klinger și podea/plafon pornesc de la această sumă.'
    : 'Prima retragere = SWR din Plan × soldul din acel scenariu la pensionare; celelalte venituri se adaugă peste.';
  document.querySelectorAll<HTMLElement>('.ret-params').forEach(el => { el.hidden = el.dataset.for !== strategy(); });
  let anyDefault = false;
  for (const [k, f] of Object.entries(NUM_FIELDS) as [NumKey, typeof NUM_FIELDS[NumKey]][]) {
    const el = $<HTMLInputElement>(k);
    const v = ret[k];
    if (document.activeElement !== el) el.value = v === undefined ? (f.def === undefined ? '' : shown(f.def, f.pct)) : shown(v, f.pct);
    const isDef = v === undefined && f.def !== undefined;
    el.classList.toggle('is-default', isDef);
    if (isDef && !$<HTMLElement>(k).closest<HTMLElement>('.ret-params')!.hidden) anyDefault = true;
  }
  $('paramNote').textContent = anyDefault
    ? strategy() === 'guardrails'
      ? 'Valorile implicite sunt cele din articolul Guyton & Klinger (2006). Modifică-le dacă vrei alte reguli.'
      : 'Valori implicite (ipoteză), modifică-le.'
    : '';
}

function bindStrategy() {
  document.querySelectorAll<HTMLInputElement>('input[name="strategy"]').forEach(r => r.addEventListener('change', () => {
    if (r.checked) { ret.strategy = r.value as StrategyKey; changed(false); }
  }));
  $<HTMLSelectElement>('initial').addEventListener('change', e => { ret.initial = (e.target as HTMLSelectElement).value as 'spending' | 'swr'; changed(); });
  for (const [k, f] of Object.entries(NUM_FIELDS) as [NumKey, typeof NUM_FIELDS[NumKey]][]) {
    $<HTMLInputElement>(k).addEventListener('input', e => {
      const n = parseNum((e.target as HTMLInputElement).value);
      setOrDelete(k, n === undefined ? undefined : f.pct ? n / 100 : Math.round(n));
      changed();
    });
  }
}

// ─── Other income ───
function cell(child: HTMLElement | string) {
  const td = document.createElement('td');
  if (typeof child === 'string') td.textContent = child; else td.append(child);
  return td;
}
function numInput(value: number | undefined, label: string, onInput: (v: number | undefined) => void, step = '1') {
  const el = document.createElement('input');
  el.type = 'number'; el.inputMode = 'decimal'; el.step = step; el.setAttribute('aria-label', label);
  el.value = value === undefined ? '' : String(value);
  el.addEventListener('input', () => onInput(parseNum(el.value)));
  return el;
}
function delBtn(label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'inv-btn inv-btn--ghost'; b.textContent = 'Șterge'; b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function renderIncomes() {
  const body = $('incBody');
  body.replaceChildren();
  const list = ret.incomes ?? [];
  $('incEmpty').hidden = list.length > 0;
  for (const inc of list) {
    const tr = document.createElement('tr');
    const kind = document.createElement('select');
    kind.setAttribute('aria-label', 'Tip venit');
    for (const [k, l] of Object.entries(KIND_LABEL)) kind.append(new Option(l, k, false, k === inc.kind));
    kind.addEventListener('change', () => { inc.kind = kind.value as RetirementIncome['kind']; changed(); });
    const label = document.createElement('input');
    label.type = 'text'; label.maxLength = 120; label.value = inc.label ?? ''; label.setAttribute('aria-label', 'Descriere');
    label.addEventListener('input', () => { if (label.value.trim()) inc.label = label.value; else delete inc.label; markDirty(); });
    tr.append(
      cell(kind), cell(label),
      cell(numInput(inc.amount, 'Sumă netă pe an', v => { inc.amount = Math.max(0, v ?? 0); changed(); }, '100')),
      cell(numInput(inc.startAge, 'De la vârsta', v => { inc.startAge = Math.round(v ?? 0); changed(); })),
      cell(numInput(inc.endAge, 'Până la vârsta', v => { if (v === undefined) delete inc.endAge; else inc.endAge = Math.round(v); changed(); })),
      cell(delBtn('Șterge venitul', () => { ret.incomes = list.filter(x => x !== inc); if (!ret.incomes.length) delete ret.incomes; changed(); renderIncomes(); })),
    );
    body.append(tr);
  }
}

function bindIncomes() {
  $('incAdd').addEventListener('click', () => {
    const start = inputs ? inputs.age + inputs.yearsToInvest : 65;
    (ret.incomes ??= []).push({ id: newId(), kind: 'state', amount: 0, startAge: start });
    changed();
    renderIncomes();
  });
}

// ─── Glidepath ───
function renderGlidepath() {
  const body = $('gpBody');
  body.replaceChildren();
  const pts = ret.glidepath ?? [];
  for (const pt of pts) {
    const tr = document.createElement('tr');
    const age = numInput(pt.age, 'Vârstă', v => { pt.age = Math.round(v ?? 0); changed(); });
    tr.append(cell(age));
    const total = document.createElement('td');
    const sum = () => Object.values(pt.weights).reduce((s, x) => s + (x ?? 0), 0);
    const showTotal = () => { const s = sum(); total.textContent = fmtPct(s, 0); total.classList.toggle('is-warn', Math.abs(s - 1) > 0.001); };
    for (const c of ASSET_CLASSES) {
      tr.append(cell(numInput(pt.weights[c] === undefined ? undefined : Math.round(pt.weights[c]! * 1000) / 10, `${CLASS_LABEL[c]} %`, v => {
        if (v === undefined || v <= 0) delete pt.weights[c]; else pt.weights[c] = v / 100;
        showTotal();
        changed();
      })));
    }
    showTotal();
    tr.append(total, cell(delBtn('Șterge punctul', () => {
      ret.glidepath = pts.filter(x => x !== pt);
      if (!ret.glidepath.length) delete ret.glidepath;
      changed(); renderGlidepath();
    })));
    body.append(tr);
  }
  const ageEl = $<HTMLInputElement>('gpAge');
  if (!ageEl.value && inputs) ageEl.value = String(inputs.age + inputs.yearsToInvest);
}

function bindGlidepath() {
  $('gpAdd').addEventListener('click', () => {
    const age = Math.round(parseNum($<HTMLInputElement>('gpAge').value) ?? (inputs ? inputs.age + inputs.yearsToInvest : 65));
    const pts = (ret.glidepath ??= []);
    if (pts.some(p => p.age === age)) { toast(`Există deja un punct la ${age} ani.`, 'err'); return; }
    // start from the allocation the curve has at that age, rounded to whole percent
    const w = weightsAtAge(pts, age, baseWeights);
    const weights = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round((v ?? 0) * 100) / 100]));
    pts.push({ age, weights });
    pts.sort((a, b) => a.age - b.age);
    changed();
    renderGlidepath();
  });
}

// ─── Tax ───
function renderTax() {
  const g = $<HTMLInputElement>('gainShare'), fx = $<HTMLInputElement>('eurRon'), acc = $<HTMLSelectElement>('accountType');
  if (document.activeElement !== g) g.value = shown(gainShare(), true);
  g.classList.toggle('is-default', ret.gainShare === undefined);
  if (document.activeElement !== fx) fx.value = eurRon() === null ? '' : shown(eurRon()!);
  acc.value = ret.accountType ?? 'foreign_broker';
  const hints: string[] = [];
  if (ret.gainShare === undefined) hints.push('Câștig 100% = estimare prudentă (tot ce vinzi e tratat drept câștig); pune procentul tău: 1 − cost ÷ valoare.');
  if (ret.eurRon === undefined) hints.push(bnrEur ? `Curs BNR din ${bnrEur.date.split('-').reverse().join('.')}.` : 'Nu există curs BNR salvat: introdu cursul.');
  $('taxHint').textContent = hints.join(' ');
  const warn = $('taxWarn');
  if (!taxSet) {
    warn.hidden = false;
    warn.textContent = 'Nu există reguli fiscale salvate: venitul net nu poate fi calculat. Încarcă și confirmă valorile pe pagina Taxe.';
  } else {
    const unconf = unconfirmedParams(taxSet), miss = missingParams(taxSet);
    const parts: string[] = [];
    if (unconf.length) parts.push(`Valorile fiscale pentru ${taxSet.year} nu sunt confirmate încă (${unconf.length} parametri): venitul net e doar orientativ până le verifici pe pagina Taxe.`);
    if (miss.length) parts.push(`Lipsesc parametri: ${miss.join(', ')}.`);
    if (!taxExact) parts.push(`Nu există reguli pentru ${YEAR}; se folosesc cele din ${taxSet.year}.`);
    warn.hidden = parts.length === 0;
    warn.textContent = parts.join(' ');
  }
}

function bindTax() {
  $<HTMLInputElement>('gainShare').addEventListener('input', e => {
    const n = parseNum((e.target as HTMLInputElement).value);
    setOrDelete('gainShare', n === undefined ? undefined : Math.min(1, Math.max(0, n / 100)));
    changed(false);
  });
  $<HTMLInputElement>('eurRon').addEventListener('input', e => {
    const n = parseNum((e.target as HTMLInputElement).value);
    setOrDelete('eurRon', n !== undefined && n > 0 ? n : undefined);
    changed(false);
  });
  $<HTMLSelectElement>('accountType').addEventListener('change', e => {
    ret.accountType = (e.target as HTMLSelectElement).value as 'foreign_broker' | 'ro_broker';
    changed(false);
  });
}

/** Net income for the median withdrawal path (null when no tax rules or no rate). */
function netSeries(r: RetireResult, key: StrategyKey): number[] | null {
  const fx = eurRon();
  if (!taxSet || !fx) return null;
  const s = r.strategies[key];
  const opts = { year: YEAR, eurRon: fx, gainShare: gainShare(), accountType: ret.accountType ?? 'foreign_broker' } as const;
  return s.withdrawal.p50.map((w, i) => netIncome(taxSet!, w, r.other[i], opts).net);
}

// ─── Results ───
function renderResults() {
  const set = (id: string, t: string) => { $(id).textContent = t; };
  $('resStrat').textContent = STRAT_LABEL[strategy()];
  const body = $('cmpBody');
  body.replaceChildren();
  if (!result) {
    for (const id of ['rSucc', 'rFail', 'rBeq', 'rInc', 'rMin', 'rRate']) set(id, '—');
    for (const id of ['rDepl', 'rShort', 'rBeq10', 'rIncNet', 'rRet']) set(id, '');
    charts.bal?.update(); charts.inc?.update();
    return;
  }
  const r = result, s = r.strategies[strategy()];
  set('rSucc', fmtPct(s.successRate, 0));
  $('rSucc').dataset.kind = s.successRate >= 0.9 ? 'ok' : s.successRate >= 0.75 ? 'near' : 'under';
  set('rDepl', s.medianDepletionAge === null ? `ajung până la ${r.planToAge} ani în toate simulările` : `când nu ajung, se termină pe la ${fmtNum(s.medianDepletionAge, 0)} ani`);
  set('rFail', fmtPct(1 - s.successRate, 0));
  set('rShort', `${fmtPct(s.shortfallRate, 0)} din simulări au cel puțin un an cu venit sub cheltuiala dorită`);
  set('rBeq', fmtC(s.medianBequest));
  set('rBeq10', `la ${r.planToAge} ani; pesimist (p10): ${fmtC(s.p10Bequest)}`);
  set('rInc', fmtC(s.income.p50[0]));
  const net = netSeries(r, strategy());
  set('rIncNet', net ? `pe an; net de taxe ≈ ${fmtEur(net[0] / 12)}/lună` : 'pe an; net: lipsesc regulile fiscale sau cursul');
  set('rMin', fmtC(s.medianMinIncome));
  set('rRate', fmtPct(s.initialRate, 2));
  set('rRet', `sold median la pensionare ${fmtC(r.medianAtRetirement)} (p10: ${fmtC(r.p10AtRetirement)})`);
  for (const key of STRATEGIES) {
    const x = r.strategies[key];
    const tr = document.createElement('tr');
    if (key === strategy()) tr.className = 'is-current';
    const th = document.createElement('th'); th.scope = 'row'; th.textContent = STRAT_LABEL[key];
    tr.append(th, cell(fmtPct(x.successRate, 0)), cell(fmtPct(x.shortfallRate, 0)), cell(fmtC(x.income.p50[0])),
      cell(fmtC(x.medianMinIncome)), cell(fmtC(x.medianBequest)), cell(fmtC(x.p10Bequest)));
    body.append(tr);
  }
  charts.bal?.update(); charts.inc?.update();
}

// ─── Charts ───
const charts = {
  bal: null as null | ReturnType<typeof mountChart>,
  inc: null as null | ReturnType<typeof mountChart>,
  gp: null as null | ReturnType<typeof mountChart>,
};
const yMoney = (t: ChartTheme) => ({ type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => fmtC(v) } });
const xAges = (t: ChartTheme, ages: number[]) => ({
  type: 'category', data: ages.map(String), boundaryGap: false, name: 'vârstă', nameLocation: 'middle', nameGap: 28,
  nameTextStyle: { color: t.muted }, ...axisStyle(t), splitLine: { show: false },
});
const emptyOption = (t: ChartTheme, text: string) => ({
  title: { text, left: 'center', top: 'middle', textStyle: { color: t.muted, fontSize: 14, fontWeight: 'normal' } },
  xAxis: { show: false }, yAxis: { show: false }, series: [],
});
const tip = (t: ChartTheme, extra: Record<string, unknown>) => ({
  trigger: 'axis', backgroundColor: t.bg, borderColor: t.border, textStyle: { color: t.text, fontFamily: t.font }, ...extra,
});
const tipLines = (title: string, lines: [string, string][]) =>
  `${title}<br/>` + lines.map(([k, v]) => `${k}: <b>${v}</b>`).join('<br/>');
const legend = (t: ChartTheme, data: string[]) => ({ top: 0, data, textStyle: { color: t.muted }, icon: 'roundRect', itemWidth: 12, itemHeight: 8 });

function balOption(t: ChartTheme) {
  if (!inputs) return emptyOption(t, 'Completează datele din Plan');
  if (!result) return emptyOption(t, 'Se calculează…');
  const r = result, s = r.strategies[strategy()], b = s.balance;
  const ages = [...r.ages, r.planToAge];
  const gr = s.guardrails;
  const names = ['Median', 'Interval p10–p90', ...(gr ? ['Parapet tăiere', 'Parapet creștere'] : [])];
  return {
    tooltip: tip(t, {
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        const lines: [string, string][] = [['Optimist (p90)', fmtEur(b.p90[i])], ['Median (p50)', fmtEur(b.p50[i])], ['Pesimist (p10)', fmtEur(b.p10[i])]];
        if (gr && i < gr.cut.length) lines.push(['Sub acest sold, tai (median)', fmtEur(gr.cut[i])], ['Peste acest sold, crești', fmtEur(gr.raise[i])]);
        return tipLines(`${ages[i]} ani`, lines);
      },
    }),
    legend: legend(t, names),
    grid: { left: 8, right: 16, top: 40, bottom: 28, containLabel: true },
    xAxis: xAges(t, ages),
    yAxis: yMoney(t),
    series: [
      { name: 'Pesimist (p10)', type: 'line', stack: 'band', data: b.p10, showSymbol: false, color: t.series[0], lineStyle: { width: 1, opacity: 0.7 } },
      { name: 'Interval p10–p90', type: 'line', stack: 'band', data: b.p90.map((x, i) => x - b.p10[i]), showSymbol: false, color: t.series[0], lineStyle: { width: 1, opacity: 0.7 }, areaStyle: { opacity: 0.18 } },
      { name: 'Median', type: 'line', data: b.p50, showSymbol: false, color: t.series[0], lineStyle: { width: 2.5 } },
      ...(gr ? [
        { name: 'Parapet tăiere', type: 'line', data: gr.cut, showSymbol: false, color: t.err, lineStyle: { width: 1.5, type: 'dashed' } },
        { name: 'Parapet creștere', type: 'line', data: gr.raise, showSymbol: false, color: t.ok, lineStyle: { width: 1.5, type: 'dashed' } },
      ] : []),
    ],
  };
}

function incOption(t: ChartTheme) {
  if (!inputs) return emptyOption(t, 'Completează datele din Plan');
  if (!result) return emptyOption(t, 'Se calculează…');
  const r = result, s = r.strategies[strategy()], inc = s.income;
  const net = netSeries(r, strategy());
  const names = ['Venit median', 'Venit p10', 'Venit p90', ...(net ? ['Net median după taxe'] : []), 'Cheltuiala dorită', 'Alte venituri'];
  return {
    tooltip: tip(t, {
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        const lines: [string, string][] = [['p90', fmtEur(inc.p90[i])], ['Median', fmtEur(inc.p50[i])], ['p10', fmtEur(inc.p10[i])]];
        if (net) lines.push(['Net median', fmtEur(net[i])]);
        lines.push(['din care alte venituri', fmtEur(r.other[i])], ['Cheltuiala dorită', fmtEur(r.need[i])]);
        return tipLines(`${r.ages[i]} ani`, lines);
      },
    }),
    legend: legend(t, names),
    grid: { left: 8, right: 16, top: 56, bottom: 28, containLabel: true },
    xAxis: xAges(t, r.ages),
    yAxis: yMoney(t),
    series: [
      { name: 'Venit p90', type: 'line', data: inc.p90, showSymbol: false, color: t.series[0], lineStyle: { width: 1, opacity: 0.6 } },
      { name: 'Venit median', type: 'line', data: inc.p50, showSymbol: false, color: t.series[0], lineStyle: { width: 2.5 } },
      { name: 'Venit p10', type: 'line', data: inc.p10, showSymbol: false, color: t.series[0], lineStyle: { width: 1, opacity: 0.6, type: 'dotted' } },
      ...(net ? [{ name: 'Net median după taxe', type: 'line', data: net, showSymbol: false, color: t.series[2], lineStyle: { width: 2 } }] : []),
      { name: 'Cheltuiala dorită', type: 'line', data: r.need, showSymbol: false, color: t.warn, lineStyle: { width: 1.5, type: 'dashed' } },
      { name: 'Alte venituri', type: 'line', data: r.other, showSymbol: false, color: t.series[1], lineStyle: { width: 1 }, areaStyle: { opacity: 0.2 } },
    ],
  };
}

function gpOption(t: ChartTheme) {
  if (!inputs) return emptyOption(t, 'Completează datele din Plan');
  const ages: number[] = [];
  for (let a = inputs.age; a <= inputs.planToAge; a++) ages.push(a);
  const rows = ages.map(a => weightsAtAge(ret.glidepath, a, baseWeights));
  const used = ASSET_CLASSES.filter(c => rows.some(w => (w[c] ?? 0) > 0));
  if (!used.length) return emptyOption(t, 'Nicio alocare');
  const retAge = inputs.age + inputs.yearsToInvest;
  return {
    tooltip: tip(t, {
      formatter: (ps: { dataIndex: number }[]) => {
        const w = rows[ps[0].dataIndex];
        return tipLines(`${ages[ps[0].dataIndex]} ani`, used.map(c => [CLASS_LABEL[c], fmtPct(w[c] ?? 0, 0)]));
      },
    }),
    legend: legend(t, used.map(c => CLASS_LABEL[c])),
    grid: { left: 8, right: 16, top: 40, bottom: 28, containLabel: true },
    xAxis: xAges(t, ages),
    yAxis: { type: 'value', max: 100, ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => `${v}%` } },
    series: used.map((c, i) => ({
      name: CLASS_LABEL[c], type: 'line', stack: 'w', data: rows.map(w => Math.round((w[c] ?? 0) * 1000) / 10), showSymbol: false,
      color: t.series[i % t.series.length], lineStyle: { width: 1 }, areaStyle: { opacity: 0.55 },
      ...(i === 0 ? {
        markLine: {
          silent: true, symbol: 'none', label: { color: t.muted, formatter: 'pensionare' },
          lineStyle: { color: t.muted, type: 'dotted' }, data: [{ xAxis: String(retAge) }],
        },
      } : {}),
    })),
  };
}

// ─── Simulation (shared Monte Carlo worker) ───
let worker: Worker | null = null;
let reqId = 0, liveId = 0;
let simTimer: ReturnType<typeof setTimeout> | undefined;
let simKey = '';

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./mc.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent<McResponse>) => {
    const msg = e.data;
    if (msg.id !== liveId) return;
    if (msg.kind === 'retire') { result = msg.result; $('resState').textContent = `${fmtNum(result.runs, 0)} simulări`; renderResults(); }
    else if (msg.kind === 'error') { $('resState').textContent = ''; toast(`Simularea a eșuat: ${msg.message}`, 'err'); }
  });
  worker.addEventListener('error', () => toast('Simularea nu poate porni în acest browser.', 'err'));
  return worker;
}

function retireInputs(inp: PlanInputs): RetireInputs {
  const p = settings.projection ?? {};
  const hist = p.history ?? [];
  const mode = p.mcMode === 'bootstrap' && hist.length ? 'bootstrap' : 'normal';
  return {
    ...inp, mode, runs: p.mcRuns ?? DEFAULTS.mcRuns, seed: p.mcSeed ?? DEFAULTS.mcSeed, history: mode === 'bootstrap' ? hist : undefined,
    assumptions: p.assumptions, correlation: p.correlation ?? DEFAULTS.correlation, baseWeights,
    glidepath: ret.glidepath, incomes: (ret.incomes ?? []).map(({ amount, startAge, endAge }) => ({ amount, startAge, endAge })),
    params: {
      initial: ret.initial ?? WITHDRAWAL_DEFAULTS.initial,
      gk: { guard: ret.gkGuard ?? WITHDRAWAL_DEFAULTS.gkGuard, adjust: ret.gkAdjust ?? WITHDRAWAL_DEFAULTS.gkAdjust, minYearsLeft: ret.gkMinYearsLeft ?? WITHDRAWAL_DEFAULTS.gkMinYearsLeft },
      floor: ret.floor ?? WITHDRAWAL_DEFAULTS.floor, ceiling: ret.ceiling ?? WITHDRAWAL_DEFAULTS.ceiling, vpwReturn: ret.vpwReturn,
    },
  };
}

function scheduleSim() {
  if (!inputs) { result = null; renderResults(); return; }
  const req = retireInputs(inputs);
  const key = JSON.stringify(req);
  if (key === simKey) return;
  simKey = key;
  clearTimeout(simTimer);
  $('resState').textContent = 'Se calculează…';
  simTimer = setTimeout(() => {
    liveId = ++reqId;
    getWorker().postMessage({ id: liveId, kind: 'retire', inputs: req } satisfies McRequest);
  }, 250);
}

// ─── IPS ───
function renderIps(doc: IpsDoc | null) {
  const version = activeIpsRules(doc)?.version ?? latestIpsVersion(doc);
  const text = version?.sections?.withdrawal?.trim();
  $('ipsBox').hidden = !text;
  if (!version || !text) return;
  $('ipsMeta').textContent = `Din IPS-ul în vigoare, versiunea din ${version.date.split('-').reverse().join('.')}. Îl modifici pe pagina IPS.`;
  const box = $('ipsText');
  box.replaceChildren(...text.split(/\n{2,}/).map(par => { const p = document.createElement('p'); p.textContent = par; return p; }));
}

// ─── Save ───
function markDirty() {
  dirty = true;
  $('saveState').textContent = 'Modificări nesalvate';
  $<HTMLButtonElement>('saveBtn').disabled = false;
}
function showSaved() {
  dirty = false;
  $('saveState').textContent = loaded.saved ? `Salvat ${fmtDateTime(loaded.saved)}` : 'Nimic salvat încă';
  $<HTMLButtonElement>('saveBtn').disabled = true;
}
async function save() {
  $<HTMLButtonElement>('saveBtn').disabled = true;
  $('saveState').textContent = 'Se salvează…';
  try {
    const next: Settings = { ...loaded.doc.settings };
    if (Object.keys(ret).length) next.retirement = structuredClone(ret); else delete next.retirement;
    loaded = await saveDoc('data', loaded, { ...loaded.doc, settings: next });
    showSaved();
    toast('Setările de pensie au fost salvate.');
  } catch (e) {
    markDirty();
    toast((e as Error).message, 'err');
  }
}

// ─── Wiring ───
/** `resim` = false when only the display (strategy shown, tax) changed: no new simulation needed. */
function changed(resim = true) {
  markDirty();
  renderStrategy();
  renderTax();
  charts.gp?.update();
  if (resim) scheduleSim();
  renderResults();
}

async function init() {
  try {
    loaded = await loadDoc('data');
  } catch (e) {
    $('saveState').textContent = (e as Error).message;
    toast((e as Error).message, 'err');
    return;
  }
  settings = loaded.doc.settings;
  ret = structuredClone(settings.retirement ?? {});
  const [taxRules, ips, market] = await Promise.all([
    loadDoc('tax-rules').then(l => l.doc as TaxRules).catch(() => null),
    loadDoc('ips').then(l => l.doc as IpsDoc).catch(() => null),
    loadMarket([YEAR - 1, YEAR]).catch(() => ({ fx: [], prices: [] })),
  ]);
  const rs = rulesFor(taxRules, YEAR);
  taxSet = rs?.set ?? null;
  taxExact = rs?.exact ?? false;
  const r = rateOn(market.fx, TODAY, 'EUR', 30);
  bnrEur = r ? { rate: r.rate, date: r.date } : null;

  renderFrom();
  bindStrategy(); bindIncomes(); bindGlidepath(); bindTax();
  $('saveBtn').addEventListener('click', save);
  window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
  renderStrategy(); renderIncomes(); renderGlidepath(); renderTax(); renderIps(ips);
  showSaved();
  charts.bal = mountChart($('balChart'), balOption);
  charts.inc = mountChart($('incChart'), incOption);
  charts.gp = mountChart($('gpChart'), gpOption);
  renderResults();
  scheduleSim();
}

init();
