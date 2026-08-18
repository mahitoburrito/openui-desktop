import { useEffect, useMemo, useRef } from "react";
import { BarChart, LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { init, use, type EChartsCoreOption, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

use([
  BarChart,
  LineChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface ProbeMetricPoint {
  id: string;
  key: string;
  kind?: string;
  value: number;
  step_index?: number | null;
  wall_clock?: string | null;
  dimensions?: Record<string, unknown>;
  labels?: Record<string, unknown>;
}

interface TrainingChartProps {
  points: ProbeMetricPoint[];
  selectedKeys: string[];
  loading?: boolean;
}

const COLORS = [
  "oklch(72% 0.13 252)",
  "oklch(70% 0.15 48)",
  "oklch(73% 0.11 155)",
  "oklch(72% 0.10 310)",
];

function shortKey(key: string): string {
  const parts = key.split(/[./]/).filter(Boolean);
  return parts[parts.length - 1] || key;
}

export function TrainingChart({ points, selectedKeys, loading = false }: TrainingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  const option = useMemo<EChartsCoreOption>(() => {
    const groups = selectedKeys.map((key) => ({
      key,
      points: points
        .filter((point) => point.key === key && Number.isFinite(point.value))
        .sort((a, b) => {
          if (a.step_index != null && b.step_index != null) return a.step_index - b.step_index;
          return Date.parse(a.wall_clock || "") - Date.parse(b.wall_clock || "");
        }),
    }));

    const totalPoints = groups.reduce((sum, group) => sum + group.points.length, 0);
    const hasStepAxis = groups.some((group) => group.points.some((point) => point.step_index != null));
    const singleValue = totalPoints > 0 && groups.every((group) => group.points.length <= 1);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const base = {
      animation: !reducedMotion,
      animationDuration: 420,
      animationEasing: "cubicOut",
      backgroundColor: "transparent",
      color: COLORS,
      textStyle: {
        color: "oklch(76% 0.008 255)",
        fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      },
      tooltip: {
        trigger: singleValue ? "item" : "axis",
        renderMode: "richText",
        confine: true,
        axisPointer: { type: "line", lineStyle: { color: "oklch(72% 0.03 255 / .28)" } },
        backgroundColor: "oklch(14% 0.008 255 / .96)",
        borderColor: "oklch(92% 0.006 255 / .12)",
        borderWidth: 1,
        padding: [9, 11],
        textStyle: { color: "oklch(92% 0.005 255)", fontSize: 11 },
        formatter: (raw: unknown) => {
          const items = Array.isArray(raw) ? raw : [raw];
          return items.map((item: any) => {
            const value = Array.isArray(item.value) ? item.value[1] : item.value;
            const label = shortKey(String(item.seriesName || "Metric"));
            return `${label}  ${Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
          }).join("\n");
        },
      },
    } as const;

    if (singleValue) {
      return {
        ...base,
        grid: { left: 8, right: 16, top: 12, bottom: 24, containLabel: true },
        xAxis: {
          type: "category",
          data: groups.map((group) => shortKey(group.key)),
          axisLine: { lineStyle: { color: "oklch(92% 0.006 255 / .10)" } },
          axisTick: { show: false },
          axisLabel: { color: "oklch(60% 0.009 255)", fontSize: 10 },
        },
        yAxis: {
          type: "value",
          splitLine: { lineStyle: { color: "oklch(92% 0.006 255 / .055)" } },
          axisLabel: { color: "oklch(55% 0.009 255)", fontSize: 10 },
        },
        series: [{
          type: "bar",
          barMaxWidth: 38,
          data: groups.map((group, index) => ({
            value: group.points[0]?.value ?? 0,
            itemStyle: { color: COLORS[index % COLORS.length], borderRadius: [4, 4, 0, 0] },
          })),
        }],
      };
    }

    return {
      ...base,
      grid: { left: 14, right: 20, top: 18, bottom: 32, containLabel: true },
      xAxis: {
        type: hasStepAxis ? "value" : "time",
        name: hasStepAxis ? "step" : "time",
        nameTextStyle: { color: "oklch(48% 0.008 255)", fontSize: 10 },
        axisLine: { lineStyle: { color: "oklch(92% 0.006 255 / .10)" } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: "oklch(55% 0.009 255)", fontSize: 10 },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: "oklch(92% 0.006 255 / .055)" } },
        axisLabel: { color: "oklch(55% 0.009 255)", fontSize: 10 },
      },
      dataZoom: [{ type: "inside", filterMode: "none" }],
      series: groups.map((group, index) => ({
        name: group.key,
        type: "line",
        showSymbol: group.points.length < 12,
        symbolSize: group.points.length < 12 ? 5 : 4,
        sampling: group.points.length > 800 ? "lttb" : undefined,
        connectNulls: true,
        smooth: false,
        lineStyle: { width: 2, color: COLORS[index % COLORS.length] },
        itemStyle: { color: COLORS[index % COLORS.length] },
        areaStyle: {
          opacity: 1,
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(96, 165, 250, 0.16)" },
              { offset: 1, color: "rgba(96, 165, 250, 0.01)" },
            ],
          },
        },
        emphasis: { focus: "series" },
        data: group.points.map((point, pointIndex) => [
          hasStepAxis ? (point.step_index ?? pointIndex) : Date.parse(point.wall_clock || ""),
          point.value,
        ]),
      })),
    };
  }, [points, selectedKeys]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(option, true);

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  const empty = points.length === 0 || selectedKeys.length === 0;
  return (
    <div className="relative h-full min-h-[280px] w-full">
      <div
        ref={containerRef}
        className={`h-full min-h-[280px] w-full transition-opacity ${loading || empty ? "opacity-0" : "opacity-100"}`}
        aria-label="Training metric chart"
      />
      {loading && (
        <div className="absolute inset-0 animate-pulse rounded-lg bg-white/[0.025]" aria-label="Loading metric chart" />
      )}
      {!loading && empty && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-zinc-600">
          Pick a metric with logged points.
        </div>
      )}
    </div>
  );
}
