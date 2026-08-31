import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

/**
 * ONE ECharts wrapper for the whole admin (owner's 2026-08-31 batch: "a
 * better, more interactive library"). Apache ECharts because the interactions
 * a salesperson reaches for — drag-to-zoom a date range, crosshair tooltips,
 * clicking legend entries to isolate a series, save-as-image — are built in,
 * not hand-rolled; canvas-rendered so a year of daily bars stays smooth.
 *
 * TREE-SHAKEN BY CONSTRUCTION: `echarts/core` plus exactly the charts and
 * components the admin uses, registered once at module scope. Importing the
 * `echarts` root would ship every chart type ECharts knows to a dashboard
 * that draws three.
 *
 * THE INSTANCE FOLLOWS THE ELEMENT. Init on mount, dispose on unmount, resize
 * with the container (ResizeObserver — jsdom's shim in the test harness keeps
 * suites quiet), and `setOption` on every option change with
 * `notMerge: false` so range switches animate rather than rebuild.
 */
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

export function EChart({
  option,
  height = '20rem',
  ariaLabel,
  onEvents,
}: {
  option: EChartsCoreOption;
  height?: string;
  /** Charts are canvas — this is the whole of what a screen reader gets. */
  ariaLabel: string;
  /** e.g. { click: (params) => … } for drill-down interactions. */
  onEvents?: Record<string, (params: unknown) => void>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current);
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option);
  }, [option]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance || !onEvents) return;
    for (const [event, handler] of Object.entries(onEvents)) {
      instance.on(event, handler);
    }
    return () => {
      for (const [event, handler] of Object.entries(onEvents)) {
        instance.off(event, handler);
      }
    };
  }, [onEvents]);

  return <div ref={el} role="img" aria-label={ariaLabel} style={{ width: '100%', height }} />;
}
