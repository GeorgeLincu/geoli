// /vault/invest/plan/ — inputs, deterministic projection, Monte Carlo (Web Worker), sensitivity, scenarios.
// Inputs live in data.json (settings + scenarios) and are saved only when George presses "Salvează"
// (every save also writes a backup, so we don't autosave on every slider move).
import { loadDoc, saveDoc, type Loaded } from './api';
import { mountChart, axisStyle, type ChartTheme } from './charts';
import { toast, fmtEur, fmtDateTime } from './common';
import type { AssetClass, Settings, Scenario, ProjectionSettings, TargetAllocation } from '../../lib/invest/types';
import {
  ASSET_CLASSES, DEFAULTS, DEFAULT_ASSUMPTIONS, inputsFromSettings, summarize, project, sensitivity,
  portfolioStats, SENSITIVITY_STEPS, type PlanInputs, type RequiredKey, type SensitivityKey, type Weights,
} from '../../lib/invest/projection';
import { portfolioHistory, parseHistoryCsv, type McInputs, type McResult } from '../../lib/invest/montecarlo';
import type { McRequest, McResponse } from './mc.worker';

const YEAR = new Date().getFullYear();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ─── Formatting (ro-RO) ───
const fmtPct = (x: number, d = 1) => new Intl.NumberFormat('ro-RO', { style: 'percent', maximumFractionDigits: d }).format(x);
const fmtNum = (x: number, d = 1) => new Intl.NumberFormat('ro-RO', { maximumFractionDigits: d }).format(x);
/** Short amounts: "1,25 mil. €", "890 mii €", "9.500 €". */
const fmtC = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${fmtNum(n / 1e6, 2)} mil. €`;
  if (a >= 1e4) return `${fmtNum(n / 1e3, 0)} mii €`;
  return `${fmtNum(n, 0)} €`;
};
const fmtAge = (a: number) => `${fmtNum(a)} ani`;

// ─── State ───
let loaded: Loaded<'data'>;
let settings: Settings = { baseCurrency: 'EUR' };
let scenarios: Scenario[] = [];
let targets: TargetAllocation[] = [];
let dirty = false;
let view: 'real' | 'nominal' = 'real';
let inputs: PlanInputs | null = null;
let weights: Weights = {};
let mc: McResult | null = null;
const compare = new Set<string>();
const scenarioMc = new Map<string, { successRate: number }>();

const proj = (): ProjectionSettings => (settings.projection ??= {});

const CLASS_LABEL: Record<AssetClass, string> = {
  equity: 'Acțiuni', bond: 'Obligațiuni', gov_bond: 'Titluri de stat', gold: 'Aur', cash: 'Numerar',
  real_estate: 'Imobiliare', pension: 'Pensii', other: 'Altele',
};
const MISSING_LABEL: Record<RequiredKey, string> = {
  age: 'vârsta', capital: 'capitalul investit', monthlyContribution: 'contribuția lunară',
  yearsToInvest: 'anii de investit', spending: 'cheltuiala la pensie', weights: 'ponderile claselor de active',
};
const SENS_LABEL: Record<SensitivityKey, string> = {
  capital: 'Capital inițial', monthlyContribution: 'Contribuție lunară', contributionGrowth: 'Creșterea contribuției',
  realReturn: 'Randament real', spending: 'Cheltuială la pensie', swr: 'SWR',
};

// ─── Fields (slider + number) ───
interface FieldDef {
  get: (s: Settings) => number | undefined;
  set: (s: Settings, v: number | undefined) => void;
  def?: number;
  pct?: boolean;
}
const setOrDelete = <T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined) => {
  if (v === undefined) delete o[k]; else o[k] = v;
};
const projField = (k: 'planToAge' | 'correlation', def: number): FieldDef => ({
  get: s => s.projection?.[k], set: (_s, v) => setOrDelete(proj(), k, v), def,
});
const FIELDS: Record<string, FieldDef> = {
  age: { get: s => (s.birthYear === undefined ? undefined : YEAR - s.birthYear), set: (s, v) => setOrDelete(s, 'birthYear', v === undefined ? undefined : YEAR - Math.round(v)) },
  capital: { get: s => s.manualCapital, set: (s, v) => setOrDelete(s, 'manualCapital', v) },
  monthlyContribution: { get: s => s.monthlyContribution, set: (s, v) => setOrDelete(s, 'monthlyContribution', v) },
  contributionGrowth: { get: s => s.contributionGrowth, set: (s, v) => setOrDelete(s, 'contributionGrowth', v), def: DEFAULTS.contributionGrowth, pct: true },
  yearsToInvest: { get: s => s.yearsToInvest, set: (s, v) => setOrDelete(s, 'yearsToInvest', v === undefined ? undefined : Math.round(v)) },
  spending: { get: s => s.retirementSpending, set: (s, v) => setOrDelete(s, 'retirementSpending', v) },
  planToAge: projField('planToAge', DEFAULTS.planToAge),
  swr: { get: s => s.swr, set: (s, v) => setOrDelete(s, 'swr', v), def: DEFAULTS.swr, pct: true },
  inflation: { get: s => s.inflation, set: (s, v) => setOrDelete(s, 'inflation', v), def: DEFAULTS.inflation, pct: true },
  correlation: projField('correlation', DEFAULTS.correlation),
};

const toShown = (v: number, pct?: boolean) => String(pct ? Math.round(v * 100 * 1000) / 1000 : Math.round(v * 1000) / 1000);
const parseShown = (raw: string, pct?: boolean): number | undefined => {
  if (raw.trim() === '') return undefined;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return pct ? n / 100 : n;
};

function renderField(id: string) {
  const f = FIELDS[id];
  const box = document.querySelector<HTMLElement>(`[data-field="${id}"]`)!;
  const num = $<HTMLInputElement>(`f-${id}`), range = $<HTMLInputElement>(`r-${id}`);
  const v = f.get(settings);
  const isDefault = v === undefined && f.def !== undefined;
  const shown = v ?? f.def;
  if (document.activeElement !== num) num.value = shown === undefined ? '' : toShown(shown, f.pct);
  if (document.activeElement !== range) {
    range.value = shown === undefined ? String((Number(range.min) + Number(range.max)) / 2) : toShown(shown, f.pct);
  }
  box.classList.toggle('is-empty', shown === undefined);
  box.classList.toggle('is-default', isDefault);
  (box.querySelector('.plan-default') as HTMLElement).hidden = !isDefault;
}

function bindFields() {
  for (const id of Object.keys(FIELDS)) {
    const f = FIELDS[id];
    const num = $<HTMLInputElement>(`f-${id}`), range = $<HTMLInputElement>(`r-${id}`);
    num.addEventListener('input', () => { f.set(settings, parseShown(num.value, f.pct)); changed(); });
    range.addEventListener('input', () => {
      num.value = range.value;
      f.set(settings, parseShown(range.value, f.pct));
      changed();
    });
  }
}

// ─── Asset class table ───
function renderClassTable() {
  const fromTargets = targets.length > 0;
  const shownWeights: Weights = fromTargets ? weights : (settings.projection?.weights ?? {});
  for (const cls of ASSET_CLASSES) {
    const row = document.querySelector<HTMLTableRowElement>(`tr[data-class="${cls}"]`)!;
    const w = row.querySelector<HTMLInputElement>('[data-k="weight"]')!;
    const r = row.querySelector<HTMLInputElement>('[data-k="ret"]')!;
    const v = row.querySelector<HTMLInputElement>('[data-k="vol"]')!;
    const custom = settings.projection?.assumptions?.[cls];
    const a = custom ?? DEFAULT_ASSUMPTIONS[cls];
    w.disabled = fromTargets;
    if (document.activeElement !== w) w.value = shownWeights[cls] === undefined ? '' : toShown(shownWeights[cls] as number, true);
    if (document.activeElement !== r) r.value = toShown(a.ret, true);
    if (document.activeElement !== v) v.value = toShown(a.vol, true);
    r.classList.toggle('is-default', !custom);
    v.classList.toggle('is-default', !custom);
    r.title = v.title = custom ? '' : 'Valoare implicită (ipoteză), modific-o.';
  }
  const rawSum = fromTargets
    ? targets.reduce((s, t) => s + t.weight, 0)
    : Object.values(settings.projection?.weights ?? {}).reduce((s, x) => s + (x ?? 0), 0);
  $('wSum').textContent = rawSum ? fmtPct(rawSum, 1) : '—';
  $('wSum').classList.toggle('is-warn', rawSum > 0 && Math.abs(rawSum - 1) > 0.001);
  const stats = Object.keys(weights).length
    ? portfolioStats(weights, settings.projection?.assumptions, settings.projection?.correlation ?? DEFAULTS.correlation)
    : null;
  $('pRet').textContent = stats ? fmtPct(stats.ret, 2) : '—';
  $('pVol').textContent = stats ? fmtPct(stats.vol, 1) : '—';
  $('weightsNote').textContent = fromTargets
    ? 'Ponderile vin din alocarea-țintă (pagina Portofoliu). Randamentele și volatilitățile le setezi aici.'
    : 'Până când există o alocare-țintă în Portofoliu, ponderile se setează aici. Dacă nu însumează 100%, sunt scalate proporțional.';
}

function bindClassTable() {
  for (const cls of ASSET_CLASSES) {
    const row = document.querySelector<HTMLTableRowElement>(`tr[data-class="${cls}"]`)!;
    const w = row.querySelector<HTMLInputElement>('[data-k="weight"]')!;
    const r = row.querySelector<HTMLInputElement>('[data-k="ret"]')!;
    const v = row.querySelector<HTMLInputElement>('[data-k="vol"]')!;
    w.addEventListener('input', () => {
      const ws = (proj().weights ??= {});
      setOrDelete(ws, cls, parseShown(w.value, true));
      if (!Object.keys(ws).length) delete proj().weights;
      changed();
    });
    const onAssumption = () => {
      const ret = parseShown(r.value, true), vol = parseShown(v.value, true);
      const as = (proj().assumptions ??= {});
      if (ret === undefined && vol === undefined) delete as[cls];
      else as[cls] = { ret: ret ?? DEFAULT_ASSUMPTIONS[cls].ret, vol: Math.max(0, vol ?? DEFAULT_ASSUMPTIONS[cls].vol) };
      if (!Object.keys(as).length) delete proj().assumptions;
      changed();
    };
    r.addEventListener('input', onAssumption);
    v.addEventListener('input', onAssumption);
  }
}

// ─── Results ───
function renderResults() {
  const res = inputsFromSettings(settings, targets, YEAR, ledgerCapital());
  inputs = res.inputs;
  weights = res.weights;
  $('emptyState').hidden = !!inputs;
  $('results').hidden = !inputs;
  if (!inputs) {
    $('missingList').textContent = res.missing.map(k => MISSING_LABEL[k]).join(', ');
    return;
  }
  const s = summarize(inputs);
  const set = (id: string, t: string) => { $(id).textContent = t; };
  set('kFi', fmtC(s.fiNumber));
  set('kRetAge', String(s.retirementAge));
  set('kBal', fmtC(s.balanceAtRetirement));
  set('kNom', `≈ ${fmtC(s.nominalAtRetirement)} nominal, la ${fmtPct(inputs.inflation)} inflație`);
  set('kInc', fmtC(s.incomeAtSwr) + '/an');
  set('kIncM', `≈ ${fmtEur(s.incomeAtSwr / 12)}/lună la SWR ${fmtPct(inputs.swr)}`);
  set('kFiAge', s.fiAge === null ? 'peste 100 de ani' : `la ${fmtAge(s.fiAge)}`);
  set('kYtf', s.yearsToFI === null ? 'cu planul actual' : s.yearsToFI === 0 ? 'deja atins' : `în ${fmtAge(s.yearsToFI)}, dacă continui contribuțiile`);
  set('kCoast', fmtC(s.coast.number));
  set('kCoastAge', s.coast.reachedNow ? 'atins deja: poți opri contribuțiile' : s.coast.age === null ? 'nu se atinge până la pensionare' : `atins la ${s.coast.age} ani`);
  set('kPaid', fmtC(s.totalContributed));
  const v = $('verdict');
  const gap = s.fiNumber - s.balanceAtRetirement;
  v.dataset.kind = s.ratio >= 1 ? 'ok' : s.ratio >= 0.9 ? 'near' : 'under';
  v.textContent = s.ratio >= 1
    ? `Pe traiectorie: la ${s.retirementAge} ani depășești numărul FI cu ${fmtC(-gap)}.`
    : `La ${s.retirementAge} ani ai acoperi ${fmtPct(s.ratio, 0)} din numărul FI; lipsesc ~${fmtC(gap)}.`;
}

/** Portfolio value from the ledger (Phase 2/3). Until it exists, the manual capital is used. */
function ledgerCapital(): number | null {
  return null;
}

// ─── Charts ───
const charts = {
  proj: null as null | ReturnType<typeof mountChart>,
  fan: null as null | ReturnType<typeof mountChart>,
  seq: null as null | ReturnType<typeof mountChart>,
  tornado: null as null | ReturnType<typeof mountChart>,
  sc: null as null | ReturnType<typeof mountChart>,
};
const yMoney = (t: ChartTheme) => ({
  type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => fmtC(v) },
});
const xAges = (t: ChartTheme, ages: number[]) => ({
  type: 'category', data: ages.map(String), boundaryGap: false, name: 'vârstă', nameLocation: 'middle', nameGap: 28,
  nameTextStyle: { color: t.muted }, ...axisStyle(t), splitLine: { show: false },
});
const emptyOption = (t: ChartTheme, text: string) => ({
  title: { text, left: 'center', top: 'middle', textStyle: { color: t.muted, fontSize: 14, fontWeight: 'normal' } },
  xAxis: { show: false }, yAxis: { show: false }, series: [],
});
/** Tooltip with the theme colours (a chart's own `tooltip` replaces the base one). */
const tip = (t: ChartTheme, extra: Record<string, unknown>) => ({
  trigger: 'axis', backgroundColor: t.bg, borderColor: t.border, textStyle: { color: t.text, fontFamily: t.font }, ...extra,
});
/** Plain-text tooltip lines (no inline styles, CSP-safe). */
const tipLines = (title: string, lines: [string, string][]) =>
  `${title}<br/>` + lines.map(([k, v]) => `${k}: <b>${v}</b>`).join('<br/>');

function projOption(t: ChartTheme) {
  if (!inputs) return emptyOption(t, 'Completează datele pentru proiecție');
  const inp = inputs;
  const rows = project(inp);
  const f = (y: number) => (view === 'nominal' ? Math.pow(1 + inp.inflation, y) : 1);
  const fi = inp.spending / inp.swr;
  return {
    tooltip: tip(t, {
      formatter: (ps: { dataIndex: number }[]) => {
        const r = rows[ps[0].dataIndex], k = f(r.year);
        return tipLines(`${r.age} ani (anul ${YEAR + r.year})`, [
          ['Valoare', fmtEur(r.balance * k)], ['Bani depuși', fmtEur(r.contributed * k)],
          ['Creștere', fmtEur(r.growth * k)], ['Număr FI', fmtEur(fi * k)],
        ]);
      },
    }),
    grid: { left: 8, right: 16, top: 40, bottom: 28, containLabel: true },
    xAxis: xAges(t, rows.map(r => r.age)),
    yAxis: yMoney(t),
    series: [
      { name: 'Bani depuși', type: 'line', stack: 'v', data: rows.map(r => r.contributed * f(r.year)), showSymbol: false, color: t.series[1], lineStyle: { width: 1 }, areaStyle: { opacity: 0.35 } },
      { name: 'Creștere din randament', type: 'line', stack: 'v', data: rows.map(r => r.growth * f(r.year)), showSymbol: false, color: t.series[0], lineStyle: { width: 2 }, areaStyle: { opacity: 0.3 } },
      { name: 'Număr FI', type: 'line', data: rows.map(r => fi * f(r.year)), showSymbol: false, color: t.warn, lineStyle: { width: 1.5, type: 'dashed' } },
    ],
  };
}

function fanOption(t: ChartTheme) {
  if (!inputs) return emptyOption(t, 'Completează datele pentru simulare');
  if (!mc) return emptyOption(t, 'Se calculează…');
  const r = mc, fi = inputs.spending / inputs.swr;
  return {
    tooltip: tip(t, {
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        return tipLines(`${r.ages[i]} ani`, [
          ['Optimist (p90)', fmtEur(r.p90[i])], ['Median (p50)', fmtEur(r.p50[i])], ['Pesimist (p10)', fmtEur(r.p10[i])],
        ]);
      },
    }),
    legend: { top: 0, data: ['Median', 'Interval p10–p90', 'Număr FI'], textStyle: { color: t.muted }, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
    grid: { left: 8, right: 16, top: 40, bottom: 28, containLabel: true },
    xAxis: xAges(t, r.ages),
    yAxis: yMoney(t),
    series: [
      { name: 'Pesimist (p10)', type: 'line', stack: 'band', data: r.p10, showSymbol: false, color: t.series[0], lineStyle: { width: 1, opacity: 0.7 } },
      { name: 'Interval p10–p90', type: 'line', stack: 'band', data: r.p90.map((x, i) => x - r.p10[i]), showSymbol: false, color: t.series[0], lineStyle: { width: 1, opacity: 0.7 }, areaStyle: { opacity: 0.18 } },
      {
        name: 'Median', type: 'line', data: r.p50, showSymbol: false, color: t.series[0], lineStyle: { width: 2.5 },
        markLine: {
          silent: true, symbol: 'none', label: { color: t.muted, formatter: 'pensionare' },
          lineStyle: { color: t.muted, type: 'dotted' }, data: [{ xAxis: String(r.retirementAge) }],
        },
      },
      { name: 'Număr FI', type: 'line', data: r.ages.map(() => fi), showSymbol: false, color: t.warn, lineStyle: { width: 1.5, type: 'dashed' } },
    ],
  };
}

function seqOption(t: ChartTheme) {
  if (!mc || !mc.sequence.length) return emptyOption(t, mc ? 'Fără perioadă de pensie în orizont' : '');
  const names = ['Cei mai slabi 20%', '20–40%', '40–60%', '60–80%', 'Cei mai buni 20%'];
  const seq = mc.sequence;
  return {
    legend: { show: false },
    tooltip: tip(t, {
      formatter: (ps: { dataIndex: number }[]) => {
        const b = seq[ps[0].dataIndex];
        return tipLines(names[ps[0].dataIndex], [
          ['Randament mediu', `${fmtPct(b.from)} … ${fmtPct(b.to)}`], ['Șanse de reușită', fmtPct(b.successRate, 0)],
        ]);
      },
    }),
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: names, ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.muted, interval: 0, fontSize: 11 } },
    yAxis: { type: 'value', max: 100, ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => `${v}%` } },
    series: [{
      name: 'Șanse de reușită', type: 'bar', data: seq.map(b => Math.round(b.successRate * 1000) / 10), color: t.series[1], barMaxWidth: 48,
      label: { show: true, position: 'top', color: t.text, formatter: (p: { value: number }) => `${fmtNum(p.value, 0)}%` },
    }],
  };
}

function tornadoOption(t: ChartTheme) {
  if (!inputs) return emptyOption(t, 'Completează datele pentru senzitivitate');
  const { baseAge, bars } = sensitivity(inputs);
  if (baseAge === null) return emptyOption(t, 'Cu planul actual nu atingi numărul FI în 100 de ani');
  const CAP = 30;
  const delta = (a: number | null) => (a === null ? CAP : Math.max(-CAP, Math.min(CAP, a - baseAge)));
  const fmtIn = (k: SensitivityKey, v: number) =>
    k === 'capital' || k === 'monthlyContribution' || k === 'spending' ? fmtEur(v) : fmtPct(v, 2);
  const step = (k: SensitivityKey, sign: 1 | -1) => {
    const s = SENSITIVITY_STEPS[k];
    return s.kind === 'rel' ? `${sign > 0 ? '+' : '−'}${fmtPct(s.d, 0)}` : `${sign > 0 ? '+' : '−'}${fmtNum(s.d * 100, 1)} pp`;
  };
  const rows = bars.slice().reverse();
  const ageText = (a: number | null) => (a === null ? 'nu se atinge' : fmtAge(a));
  return {
    legend: { top: 0 },
    tooltip: tip(t, {
      axisPointer: { type: 'shadow' },
      formatter: (ps: { dataIndex: number }[]) => {
        const b = rows[ps[0].dataIndex];
        return tipLines(SENS_LABEL[b.key], [
          [`${step(b.key, -1)} (${fmtIn(b.key, b.lowInput)})`, ageText(b.lowAge)],
          [`${step(b.key, 1)} (${fmtIn(b.key, b.highInput)})`, ageText(b.highAge)],
          ['Acum', fmtAge(baseAge)],
        ]);
      },
    }),
    grid: { left: 8, right: 24, top: 40, bottom: 8, containLabel: true },
    xAxis: {
      type: 'value', ...axisStyle(t),
      axisLabel: { color: t.muted, formatter: (v: number) => `${v > 0 ? '+' : ''}${fmtNum(v, 1)} ani` },
    },
    yAxis: { type: 'category', data: rows.map(b => SENS_LABEL[b.key]), ...axisStyle(t), splitLine: { show: false } },
    series: [
      { name: 'Valoare mai mică', type: 'bar', data: rows.map(b => delta(b.lowAge)), color: t.series[1], barGap: '-100%', barMaxWidth: 22 },
      { name: 'Valoare mai mare', type: 'bar', data: rows.map(b => delta(b.highAge)), color: t.series[0], barMaxWidth: 22 },
    ],
  };
}

function scOption(t: ChartTheme) {
  const lines: { name: string; data: [number, number][] }[] = [];
  if (inputs) lines.push({ name: 'Acum', data: project(inputs).map(r => [r.age, r.balance]) });
  for (const sc of scenarios) {
    if (!compare.has(sc.id)) continue;
    const inp = scenarioInputs(sc);
    if (inp) lines.push({ name: sc.name, data: project(inp).map(r => [r.age, r.balance]) });
  }
  return {
    tooltip: tip(t, { valueFormatter: (v: unknown) => fmtEur(Number(v)) }),
    grid: { left: 8, right: 16, top: 40, bottom: 28, containLabel: true },
    xAxis: { type: 'value', min: 'dataMin', max: 'dataMax', name: 'vârstă', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: t.muted }, ...axisStyle(t), splitLine: { show: false } },
    yAxis: yMoney(t),
    series: lines.map((l, i) => ({
      name: l.name, type: 'line', data: l.data, showSymbol: false, color: t.series[i % t.series.length],
      lineStyle: { width: i === 0 ? 2.5 : 1.75 },
    })),
  };
}

function mountCharts() {
  charts.proj = mountChart($('projChart'), projOption);
  charts.fan = mountChart($('fanChart'), fanOption);
  charts.seq = mountChart($('seqChart'), seqOption);
  charts.tornado = mountChart($('tornadoChart'), tornadoOption);
}

// ─── Monte Carlo (Web Worker) ───
let worker: Worker | null = null;
let reqId = 0, mainId = 0, batchId = 0;
let mcTimer: ReturnType<typeof setTimeout> | undefined;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./mc.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent<McResponse>) => {
    const msg = e.data;
    if (msg.kind === 'main' && msg.id === mainId) { mc = msg.result; renderMc(); }
    else if (msg.kind === 'batch' && msg.id === batchId) {
      const ids = pendingBatch;
      msg.results.forEach((r, i) => scenarioMc.set(ids[i], r));
      renderScenarios();
    } else if (msg.kind === 'error') toast(`Simularea a eșuat: ${msg.message}`, 'err');
  });
  worker.addEventListener('error', () => toast('Simularea nu poate porni în acest browser.', 'err'));
  return worker;
}

/** Monte Carlo inputs for a plan; falls back to normal mode when no history is available. */
function mcInputs(inp: PlanInputs, s: Settings, w: Weights, runs?: number): { mc: McInputs; fellBack: boolean } {
  const p = s.projection ?? {}, cur = settings.projection ?? {};
  const wantBoot = (p.mcMode ?? 'normal') === 'bootstrap';
  const hist = wantBoot ? portfolioHistory(cur.history ?? [], w, p.assumptions) : [];
  const mode = wantBoot && hist.length ? 'bootstrap' : 'normal';
  return {
    mc: { ...inp, mode, runs: runs ?? p.mcRuns ?? DEFAULTS.mcRuns, seed: p.mcSeed ?? DEFAULTS.mcSeed, history: hist },
    fellBack: wantBoot && mode === 'normal',
  };
}

function scheduleMc() {
  clearTimeout(mcTimer);
  if (!inputs) { mc = null; renderMc(); return; }
  const inp = inputs;
  mcTimer = setTimeout(() => {
    const { mc: req, fellBack } = mcInputs(inp, settings, weights);
    $('mcNote').textContent = fellBack
      ? 'Modul istoric nu are date (vezi „Randamente istorice” mai jos), așa că se folosește modul normal.'
      : 'Acumulare cu contribuțiile tale, apoi retragi cheltuiala anuală (reală) până la vârsta aleasă. Reușită = banii nu se termină înainte.';
    mainId = ++reqId;
    getWorker().postMessage({ id: mainId, kind: 'main', inputs: req } satisfies McRequest);
  }, 250);
}

function renderMc() {
  const set = (id: string, t: string) => { $(id).textContent = t; };
  if (!mc || !inputs) {
    for (const id of ['mSucc', 'mRet', 'mEnd', 'mEnd10']) set(id, '—');
    for (const id of ['mDepl', 'mRet10', 'mSeed']) set(id, '');
  } else {
    set('mSucc', fmtPct(mc.successRate, 0));
    $('mSucc').dataset.kind = mc.successRate >= 0.9 ? 'ok' : mc.successRate >= 0.75 ? 'near' : 'under';
    set('mDepl', mc.medianDepletionAge === null ? `banii ajung până la ${inputs.planToAge} ani în toate simulările` : `când nu ajung, se termină de obicei pe la ${fmtAge(mc.medianDepletionAge)}`);
    set('mRet', fmtC(mc.medianAtRetirement));
    set('mRet10', `p10: ${fmtC(mc.p10AtRetirement)}`);
    set('mEnd', fmtC(mc.medianAtEnd));
    set('mEnd10', fmtC(mc.p10AtEnd));
    set('mSeed', `${fmtNum(mc.runs, 0)} simulări, ${mc.mode === 'bootstrap' ? 'istoric' : 'normal'}, sămânța ${settings.projection?.mcSeed ?? DEFAULTS.mcSeed}`);
  }
  charts.fan?.update();
  charts.seq?.update();
}

function bindMcControls() {
  const mode = $<HTMLSelectElement>('mcMode'), runs = $<HTMLInputElement>('mcRuns');
  mode.addEventListener('change', () => { proj().mcMode = mode.value as 'normal' | 'bootstrap'; changed(); });
  runs.addEventListener('change', () => {
    const n = Math.round(Number(runs.value));
    setOrDelete(proj(), 'mcRuns', Number.isFinite(n) && runs.value !== '' ? Math.min(20000, Math.max(2000, n)) : undefined);
    changed();
  });
  $('mcRerun').addEventListener('click', () => {
    proj().mcSeed = 1 + Math.floor(Math.random() * 1_000_000);
    changed();
  });
}
function renderMcControls() {
  $<HTMLSelectElement>('mcMode').value = settings.projection?.mcMode ?? 'normal';
  const runs = $<HTMLInputElement>('mcRuns');
  if (document.activeElement !== runs) runs.value = String(settings.projection?.mcRuns ?? DEFAULTS.mcRuns);
}

// ─── Historical returns ───
function renderHistory() {
  const h = settings.projection?.history ?? [];
  const src = settings.projection?.historySource;
  $('histState').textContent = h.length
    ? `${h.length} ani încărcați (${h[0].year}–${h[h.length - 1].year}), clase: ${[...new Set(h.flatMap(y => Object.keys(y.returns)))].map(c => CLASS_LABEL[c as AssetClass]).join(', ')}.${src ? ` Sursa: ${src}` : ' Sursa nu e notată.'}`
    : 'Nu există date istorice.';
  const srcInput = $<HTMLInputElement>('histSource');
  if (document.activeElement !== srcInput) srcInput.value = src ?? '';
}
function bindHistory() {
  $('histApply').addEventListener('click', () => {
    const { years, errors } = parseHistoryCsv($<HTMLTextAreaElement>('histText').value);
    if (!years.length) { toast(errors[0] ?? 'Nu am găsit date.', 'err'); return; }
    years.sort((a, b) => a.year - b.year);
    proj().history = years;
    setOrDelete(proj(), 'historySource', $<HTMLInputElement>('histSource').value.trim() || undefined);
    changed();
    toast(errors.length ? `Am citit ${years.length} ani; ${errors.length} probleme: ${errors[0]}` : `Am citit ${years.length} ani.`, errors.length ? 'err' : 'ok');
  });
  $('histSource').addEventListener('input', () => {
    if (!settings.projection?.history?.length) return;
    setOrDelete(proj(), 'historySource', $<HTMLInputElement>('histSource').value.trim() || undefined);
    markDirty();
  });
  $('histClear').addEventListener('click', () => {
    if (!settings.projection?.history?.length) return;
    if (!confirm('Ștergi datele istorice din plan? (Se aplică după „Salvează”.)')) return;
    delete proj().history;
    delete proj().historySource;
    changed();
  });
}

// ─── Scenarios ───
/** Scenario copies leave out the (large, shared) historical series. */
function scenarioSettings(): Settings {
  const copy = structuredClone(settings);
  if (copy.projection) { delete copy.projection.history; delete copy.projection.historySource; }
  return copy;
}
function scenarioInputs(sc: Scenario): PlanInputs | null {
  return inputsFromSettings(sc.settings, targets, YEAR, ledgerCapital()).inputs;
}

let pendingBatch: string[] = [];
let lastBatchKey = '';
function runScenarioMc() {
  const list: McInputs[] = [], ids: string[] = [];
  for (const sc of scenarios) {
    const r = inputsFromSettings(sc.settings, targets, YEAR, ledgerCapital());
    if (!r.inputs) continue;
    list.push(mcInputs(r.inputs, sc.settings, r.weights, 2000).mc);
    ids.push(sc.id);
  }
  const key = JSON.stringify(list);
  if (key === lastBatchKey) return;
  lastBatchKey = key;
  scenarioMc.clear();
  if (!list.length) return;
  pendingBatch = ids;
  batchId = ++reqId;
  getWorker().postMessage({ id: batchId, kind: 'batch', list } satisfies McRequest);
}

function cell(text: string) { const td = document.createElement('td'); td.textContent = text; return td; }

function renderScenarios() {
  const body = $('scBody');
  body.replaceChildren();
  $('scEmpty').hidden = scenarios.length > 0;
  for (const sc of scenarios) {
    const tr = document.createElement('tr');
    const inp = scenarioInputs(sc);
    const s = inp ? summarize(inp) : null;

    const tdC = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = compare.has(sc.id); cb.setAttribute('aria-label', `Compară ${sc.name}`);
    cb.addEventListener('change', () => { if (cb.checked) compare.add(sc.id); else compare.delete(sc.id); renderScChart(); });
    tdC.append(cb);

    const tdN = document.createElement('th');
    tdN.scope = 'row'; tdN.textContent = sc.name;
    const when = document.createElement('small');
    when.textContent = fmtDateTime(sc.createdAt);
    tdN.append(document.createElement('br'), when);

    const m = scenarioMc.get(sc.id);
    const tdA = document.createElement('td');
    tdA.className = 'plan-row-actions';
    const load = document.createElement('button');
    load.type = 'button'; load.className = 'inv-btn'; load.textContent = 'Încarcă';
    load.addEventListener('click', () => {
      const history = settings.projection?.history, historySource = settings.projection?.historySource;
      settings = structuredClone(sc.settings);
      if (history) { proj().history = history; if (historySource) proj().historySource = historySource; }
      changed();
      toast(`Scenariul „${sc.name}” e acum varianta curentă (nesalvată).`);
    });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'inv-btn inv-btn--ghost'; del.textContent = 'Șterge';
    del.addEventListener('click', () => {
      if (!confirm(`Ștergi scenariul „${sc.name}”? (Se aplică după „Salvează”.)`)) return;
      scenarios = scenarios.filter(x => x.id !== sc.id);
      compare.delete(sc.id);
      markDirty();
      renderScenarios();
      runScenarioMc();
    });
    tdA.append(load, del);

    tr.append(tdC, tdN,
      cell(s ? fmtC(s.fiNumber) : 'incomplet'),
      cell(s ? `${fmtC(s.balanceAtRetirement)} la ${s.retirementAge}` : '—'),
      cell(s ? (s.fiAge === null ? '> 100 ani' : fmtAge(s.fiAge)) : '—'),
      cell(m ? fmtPct(m.successRate, 0) : s ? '…' : '—'),
      tdA);
    body.append(tr);
  }
  renderScChart();
}

function renderScChart() {
  const el = $('scChart');
  const show = scenarios.some(s => compare.has(s.id));
  el.hidden = !show;
  if (!show) return;
  if (!charts.sc) charts.sc = mountChart(el, scOption);
  else charts.sc.update();
}

function bindScenarios() {
  $<HTMLFormElement>('scForm').addEventListener('submit', e => {
    e.preventDefault();
    const nameEl = $<HTMLInputElement>('scName');
    const name = nameEl.value.trim();
    if (!name) return;
    if (scenarios.length >= 200) { toast('Maximum 200 de scenarii.', 'err'); return; }
    const sc: Scenario = { id: crypto.randomUUID(), name, settings: scenarioSettings(), createdAt: new Date().toISOString() };
    scenarios = [...scenarios, sc];
    compare.add(sc.id);
    nameEl.value = '';
    markDirty();
    renderScenarios();
    runScenarioMc();
    toast(`Scenariul „${name}” a fost adăugat. Apasă „Salvează” ca să-l păstrezi.`);
  });
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
  const btn = $<HTMLButtonElement>('saveBtn');
  btn.disabled = true;
  $('saveState').textContent = 'Se salvează…';
  try {
    loaded = await saveDoc('data', loaded, { ...loaded.doc, settings: structuredClone(settings), scenarios: structuredClone(scenarios) });
    showSaved();
    toast('Planul a fost salvat.');
  } catch (e) {
    markDirty();
    toast((e as Error).message, 'err');
  }
}

// ─── Wiring ───
let projectionKey = '';
function changed() {
  markDirty();
  renderAll();
}

function renderAll() {
  for (const id of Object.keys(FIELDS)) renderField(id);
  renderResults();
  renderClassTable();
  renderMcControls();
  renderHistory();
  charts.proj?.update();
  charts.tornado?.update();
  const key = JSON.stringify([inputs, settings.projection?.mcMode, settings.projection?.mcRuns, settings.projection?.mcSeed, settings.projection?.history?.length, weights]);
  if (key !== projectionKey) { projectionKey = key; scheduleMc(); }
  renderScenarios();
  runScenarioMc();
}

function bindView() {
  document.querySelectorAll<HTMLButtonElement>('.plan-seg__btn').forEach(b => {
    b.addEventListener('click', () => {
      view = b.dataset.view as 'real' | 'nominal';
      document.querySelectorAll<HTMLButtonElement>('.plan-seg__btn').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      charts.proj?.update();
    });
  });
}

async function init() {
  try {
    loaded = await loadDoc('data');
  } catch (e) {
    $('saveState').textContent = (e as Error).message;
    toast((e as Error).message, 'err');
    return;
  }
  settings = structuredClone(loaded.doc.settings);
  scenarios = structuredClone(loaded.doc.scenarios);
  targets = loaded.doc.targets;
  bindFields();
  bindClassTable();
  bindMcControls();
  bindHistory();
  bindScenarios();
  bindView();
  $('saveBtn').addEventListener('click', save);
  window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
  showSaved();
  renderAll();
  mountCharts();
}

init();
