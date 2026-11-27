// One chart per element that can be redrawn with new data: the first call mounts it, later calls swap the
// option builder and re-render (no second ECharts instance, no duplicate observers).
import type { EChartsCoreOption } from 'echarts/core';
import { mountChart, type ChartTheme } from './charts';

type Build = (t: ChartTheme) => EChartsCoreOption;
const slots = new WeakMap<HTMLElement, { build: Build; update: () => void }>();

export function chartIn(el: HTMLElement, build: Build) {
  const slot = slots.get(el);
  if (slot) { slot.build = build; slot.update(); return; }
  const entry = { build, update: () => {} };
  slots.set(el, entry);
  entry.update = mountChart(el, t => entry.build(t)).update;
}
