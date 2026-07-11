"use client";

// Hand-rolled SVG charts following the mark specs: 2px lines, hairline grid,
// muted axis text, tabular numerals, hover crosshair + tooltip.

import { useId, useRef, useState } from "react";
import { DailyPoint } from "@/lib/types";
import { formatInt } from "@/lib/format";

export function Sparkline({
  values,
  width = 120,
  height = 32,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(
          height - 2 - ((v - min) / range) * (height - 4)
        ).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg width={width} height={height} role="img" aria-label={label}>
      <title>{label}</title>
      <polyline
        points={pts}
        fill="none"
        stroke="var(--series-1)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TrendChart({
  series,
  compare,
  metric = "clicks",
}: {
  series: DailyPoint[];
  compare?: DailyPoint[] | null;
  metric?: "clicks" | "impressions";
}) {
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const W = 720;
  const H = 220;
  const PAD = { top: 12, right: 12, bottom: 24, left: 48 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;

  const values = series.map((p) => p[metric]);
  const compareValues = compare?.map((p) => p[metric]) ?? [];
  const max = Math.max(...values, ...compareValues, 1);

  const x = (i: number) => PAD.left + (i / Math.max(series.length - 1, 1)) * iw;
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const hoverPoint = hover !== null ? series[hover] : null;
  const hoverCompare = hover !== null && compare ? compare[hover] : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / iw) * (series.length - 1));
    setHover(Math.max(0, Math.min(series.length - 1, i)));
  }

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Daily ${metric} trend`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--grid)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted)"
              className="tnum"
            >
              {formatInt(t)}
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + ih}
          y2={PAD.top + ih}
          stroke="var(--baseline)"
          strokeWidth="1"
        />
        {[0, Math.floor(series.length / 2), series.length - 1].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 6}
            textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
            fontSize="10"
            fill="var(--muted)"
            className="tnum"
          >
            {series[i]?.date}
          </text>
        ))}
        {compare && (
          <path
            d={path(compareValues)}
            fill="none"
            stroke="var(--series-2)"
            strokeWidth="2"
            strokeDasharray="4 3"
            strokeLinejoin="round"
          />
        )}
        <path
          d={path(values)}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + ih}
              stroke="var(--baseline)"
              strokeWidth="1"
            />
            <circle
              cx={x(hover)}
              cy={y(values[hover])}
              r="4"
              fill="var(--series-1)"
              stroke="var(--surface)"
              strokeWidth="2"
            />
            {hoverCompare && (
              <circle
                cx={x(hover)}
                cy={y(compareValues[hover])}
                r="4"
                fill="var(--series-2)"
                stroke="var(--surface)"
                strokeWidth="2"
              />
            )}
          </g>
        )}
      </svg>
      {hoverPoint && (
        <div
          className="pointer-events-none absolute top-2 rounded-md border border-edge bg-surface px-3 py-2 text-xs shadow-sm"
          style={{
            left: `${Math.min(85, Math.max(2, (hover! / series.length) * 100))}%`,
          }}
        >
          <div className="font-medium text-ink tnum">{hoverPoint.date}</div>
          <div className="mt-1 flex items-center gap-1.5 text-ink-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--series-1)" }} />
            Current: <span className="tnum font-medium text-ink">{formatInt(hoverPoint[metric])}</span>
          </div>
          {hoverCompare && (
            <div className="flex items-center gap-1.5 text-ink-2">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--series-2)" }} />
              Previous: <span className="tnum font-medium text-ink">{formatInt(hoverCompare[metric])}</span>
            </div>
          )}
        </div>
      )}
      {compare && (
        <div className="mt-2 flex gap-4 text-xs text-ink-2" aria-hidden={false} id={id}>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: "var(--series-1)" }} />
            Current period
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4"
              style={{ background: "var(--series-2)", borderBottom: "1px dashed var(--series-2)" }}
            />
            Previous period
          </span>
        </div>
      )}
    </div>
  );
}
