// ECharts, tree-shaken and self-hosted (no CDN, so the CSP stays 'self'). Colours come from CSS variables,
// so charts follow light/dark automatically. Register more chart types here as later phases need them.
//
// Shared look (dataviz rules, applied to every chart through mountChart):
//   - categorical colours --inv-c1…c8 in fixed order (validated palette, see invest.css)
//   - thin marks: 2px lines, ≥ 8px markers, 4px rounded bar ends, a surface-coloured gap between stacked segments
//   - recessive axes and grid; text in text colours, never in series colours
//   - crosshair tooltip on line/area/bar charts, confined to the chart (phones)
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart, HeatmapChart } from 'echarts/charts';
import {
  GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, VisualMapComponent, TitleComponent, GraphicComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  LineChart, BarChart, PieChart, HeatmapChart,
  GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, VisualMapComponent, TitleComponent, GraphicComponent,
  CanvasRenderer,
]);

export interface ChartTheme {
  text: string; muted: string; border: string; bg: string; font: string;
  /** Surface behind the chart (used for gaps between stacked marks) */
  surface: string;
  /** Categorical series colours (--inv-c1 … --inv-c8), fixed order */
  series: string[];
  /** Diverging poles and neutral midpoint (negative ↔ positive) */
  neg: string; mid: string; pos: string;
  ok: string; warn: string; err: string;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function readTheme(): ChartTheme {
  return {
    text: cssVar('--text'), muted: cssVar('--text-muted'), border: cssVar('--border-h'), bg: cssVar('--inv-panel'),
    surface: cssVar('--inv-surface') || cssVar('--inv-panel'),
    font: cssVar('--font-sans') || 'system-ui, sans-serif',
    series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => cssVar(`--inv-c${i}`)),
    neg: cssVar('--inv-neg'), mid: cssVar('--inv-mid'), pos: cssVar('--inv-pos'),
    ok: cssVar('--ok-text'), warn: cssVar('--warn-text'), err: cssVar('--err-text'),
  };
}

/** Defaults every chart shares (text colours, font, grid, legend, tooltip). */
export function baseOption(t: ChartTheme): EChartsCoreOption {
  return {
    color: t.series,
    backgroundColor: 'transparent',
    textStyle: { color: t.text, fontFamily: t.font },
    grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
    legend: {
      top: 0, type: 'scroll', textStyle: { color: t.muted }, icon: 'roundRect', itemWidth: 12, itemHeight: 8,
      pageIconColor: t.muted, pageTextStyle: { color: t.muted },
    },
    tooltip: {
      trigger: 'axis', confine: true, backgroundColor: t.bg, borderColor: t.border,
      textStyle: { color: t.text, fontFamily: t.font },
      axisPointer: { type: 'line', lineStyle: { color: t.muted, width: 1, type: 'dashed' }, shadowStyle: { color: t.border, opacity: 0.25 } },
    },
  };
}

export const axisStyle = (t: ChartTheme) => ({
  axisLine: { lineStyle: { color: t.border } },
  axisTick: { show: false },
  axisLabel: { color: t.muted },
  splitLine: { lineStyle: { color: t.border, opacity: 0.5 } },
});

type AnySeries = Record<string, unknown> & { type?: string; stack?: string; itemStyle?: Record<string, unknown>; lineStyle?: Record<string, unknown> };

/** Applies the shared mark specs to series that don't set their own. */
export function markDefaults(series: unknown, t: ChartTheme): unknown {
  if (!Array.isArray(series)) return series;
  return series.map((raw: AnySeries) => {
    const s: AnySeries = { ...raw };
    if (s.type === 'line') {
      s.lineStyle = { width: 2, ...(s.lineStyle ?? {}) };
      if (s.symbolSize === undefined) s.symbolSize = 8;
      if (s.emphasis === undefined) s.emphasis = { focus: 'series' };
    } else if (s.type === 'bar') {
      const item = { ...(s.itemStyle ?? {}) };
      if (s.stack) {
        if (item.borderColor === undefined) { item.borderColor = t.surface; item.borderWidth = 1; }
      } else if (item.borderRadius === undefined) item.borderRadius = [4, 4, 0, 0];
      s.itemStyle = item;
      if (s.barMaxWidth === undefined) s.barMaxWidth = 48;
    }
    return s;
  });
}

const mounted: (() => void)[] = [];

/** Re-renders every chart on the page (e.g. after forcing the light theme for printing). */
export const rerenderAll = () => mounted.forEach(f => f());

/**
 * Printing (button or Ctrl+P) always uses the light theme: charts are canvas bitmaps, so they are redrawn in
 * light colours before printing and restored afterwards.
 */
export function installPrintTheme() {
  const root = document.documentElement;
  let prev: string | null | undefined;
  window.addEventListener('beforeprint', () => {
    prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
    rerenderAll();
  });
  window.addEventListener('afterprint', () => {
    if (prev === undefined) return;
    if (prev === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prev);
    prev = undefined;
    rerenderAll();
  });
}

/**
 * Mounts a chart. `build` returns the option for the current theme; it re-runs when the theme changes.
 * Call `update()` to re-render after the data changed.
 */
export function mountChart(el: HTMLElement, build: (t: ChartTheme) => EChartsCoreOption) {
  const chart = echarts.init(el, undefined, { renderer: 'canvas' });
  const render = () => {
    const t = readTheme();
    const base = baseOption(t) as Record<string, unknown>;
    const own = build(t) as Record<string, unknown>;
    const opt = { ...base, ...own } as EChartsCoreOption & { series?: unknown };
    // A chart's own legend/tooltip extend the shared ones (scrolling legend, confined tooltip) instead of replacing them
    for (const k of ['legend', 'tooltip'] as const) {
      const b = base[k], o = own[k];
      if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object') (opt as Record<string, unknown>)[k] = { ...b, ...o };
    }
    opt.series = markDefaults(opt.series, t);
    chart.setOption(opt, { notMerge: true });
  };
  render();
  mounted.push(() => { render(); chart.resize(); });

  new ResizeObserver(() => chart.resize()).observe(el);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', render);

  return { chart, update: render };
}

/** Empty-state option ("no data yet") in muted text. */
export const emptyChart = (t: ChartTheme, text: string): EChartsCoreOption => ({
  title: { text, left: 'center', top: 'middle', textStyle: { color: t.muted, fontSize: 14, fontWeight: 'normal' } },
  xAxis: { show: false }, yAxis: { show: false }, series: [],
});
