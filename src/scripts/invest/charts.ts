// ECharts, tree-shaken and self-hosted (no CDN, so the CSP stays 'self'). Colours come from CSS variables,
// so charts follow light/dark automatically. Register more chart types here as later phases need them.
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, CanvasRenderer]);

export interface ChartTheme {
  text: string; muted: string; border: string; bg: string; font: string;
  /** Categorical series colours (--inv-c1 … --inv-c6) */
  series: string[];
  ok: string; warn: string; err: string;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function readTheme(): ChartTheme {
  return {
    text: cssVar('--text'), muted: cssVar('--text-muted'), border: cssVar('--border-h'), bg: cssVar('--inv-panel'),
    font: cssVar('--font-sans') || 'system-ui, sans-serif',
    series: [1, 2, 3, 4, 5, 6].map(i => cssVar(`--inv-c${i}`)),
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
    legend: { top: 0, textStyle: { color: t.muted }, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: 'axis', backgroundColor: t.bg, borderColor: t.border,
      textStyle: { color: t.text, fontFamily: t.font },
    },
  };
}

export const axisStyle = (t: ChartTheme) => ({
  axisLine: { lineStyle: { color: t.border } },
  axisTick: { show: false },
  axisLabel: { color: t.muted },
  splitLine: { lineStyle: { color: t.border, opacity: 0.5 } },
});

/**
 * Mounts a chart. `build` returns the option for the current theme; it re-runs when the theme changes.
 * Call `update()` to re-render after the data changed.
 */
export function mountChart(el: HTMLElement, build: (t: ChartTheme) => EChartsCoreOption) {
  const chart = echarts.init(el, undefined, { renderer: 'canvas' });
  const render = () => {
    const t = readTheme();
    chart.setOption({ ...baseOption(t), ...build(t) }, { notMerge: true });
  };
  render();

  new ResizeObserver(() => chart.resize()).observe(el);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', render);

  return { chart, update: render };
}
