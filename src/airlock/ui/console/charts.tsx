import { useEffect, useRef, useState } from "react";
import { clock, type Series } from "../pages/model.js";

interface Pt {
  x: number;
  y: number;
}

/** Smooth monotone cubic path (Fritsch-Carlson), so the curve never overshoots the data. */
export function monotonePath(pts: readonly Pt[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    m.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x || 1));
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    d += ` C${pts[i].x + h / 3},${pts[i].y + (t[i] * h) / 3} ${pts[i + 1].x - h / 3},${pts[i + 1].y - (t[i + 1] * h) / 3} ${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(240, Math.round(el.clientWidth)));
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const H = 240;
const PAD = { l: 32, r: 12, t: 12, b: 28 };

/** Protected vs blocked over time. Hand-rolled SVG; a dark tooltip follows the pointer or the arrow keys. */
export function LineChart({ series }: { series: Series }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = series.protected.length;
  const peak = Math.max(1, ...series.protected, ...series.blocked);
  const top = peak <= 3 ? peak : Math.ceil(peak / 3) * 3;
  const iw = width - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number): number => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number): number => PAD.t + ih - (v / top) * ih;
  const pts = (vals: readonly number[]): Pt[] => vals.map((v, i) => ({ x: x(i), y: y(v) }));
  const pPts = pts(series.protected);
  const bPts = pts(series.blocked);
  const pLine = monotonePath(pPts);
  const area = `${pLine} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const ticks = top <= 3 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, top / 3, (2 * top) / 3, top];
  const labelAt = [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const range = (i: number): string => `${clock(series.start + i * series.bucketMs)} to ${clock(series.start + (i + 1) * series.bucketMs)}`;
  const empty = series.protected.every((v) => v === 0) && series.blocked.every((v) => v === 0);

  const onMove = (clientX: number, rect: DOMRect): void => {
    const px = ((clientX - rect.left) / rect.width) * width;
    setActive(Math.min(n - 1, Math.max(0, Math.round(((px - PAD.l) / iw) * (n - 1)))));
  };

  return (
    <div className="ac-chart" ref={ref} data-testid="requests-chart">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Requests over time. ${series.protected.reduce((a, b) => a + b, 0)} protected, ${series.blocked.reduce((a, b) => a + b, 0)} blocked.`}
        tabIndex={0}
        onPointerMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? n) - 1));
          if (e.key === "ArrowRight") setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
          if (e.key === "Escape") setActive(null);
        }}
      >
        <defs>
          <linearGradient id="ac-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-protected)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--series-protected)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="ac-axis">
              {Number.isInteger(t) ? t : t.toFixed(1)}
            </text>
          </g>
        ))}
        {labelAt.map((i, k) => (
          <text key={`${i}-${k}`} x={x(i)} y={H - 6} textAnchor={k === 0 ? "start" : k === labelAt.length - 1 ? "end" : "middle"} className="ac-axis">
            {clock(series.start + i * series.bucketMs)}
          </text>
        ))}
        <path d={area} fill="url(#ac-area)" />
        <path d={bPts.length ? monotonePath(bPts) : ""} fill="none" stroke="var(--blocked)" strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round" />
        <path d={pLine} fill="none" stroke="var(--series-protected)" strokeWidth="2.5" strokeLinecap="round" />
        {active !== null && (
          <g>
            <line x1={x(active)} x2={x(active)} y1={PAD.t} y2={y(0)} stroke="var(--series-protected)" strokeOpacity="0.4" strokeDasharray="4 4" />
            <circle cx={x(active)} cy={y(series.protected[active])} r="5" fill="var(--series-protected)" stroke="#fff" strokeWidth="2" />
            <circle cx={x(active)} cy={y(series.blocked[active])} r="5" fill="var(--blocked)" stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>
      {empty && <p className="ac-chart-empty">No requests yet. The lines appear as requests are protected or blocked.</p>}
      {active !== null && (
        <div className="ac-tooltip" style={{ left: Math.min(Math.max(x(active), 90), width - 90), top: 8 }} role="status">
          <div className="ac-tooltip-time">{range(active)}</div>
          <div className="ac-tooltip-row"><i style={{ background: "#60a5fa" }} />Protected<b>{series.protected[active]}</b></div>
          <div className="ac-tooltip-row"><i style={{ background: "#f87171" }} />Blocked<b>{series.blocked[active]}</b></div>
        </div>
      )}
    </div>
  );
}

/** A tiny trend line for a KPI card. No axes. */
export function Sparkline({ values, color = "var(--series-protected)" }: { values: readonly number[]; color?: string }) {
  const w = 96;
  const h = 32;
  const peak = Math.max(1, ...values);
  const pts = values.map((v, i) => ({ x: (i / Math.max(1, values.length - 1)) * w, y: h - 3 - (v / peak) * (h - 6) }));
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="ac-spark">
      <path d={monotonePath(pts)} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" opacity={values.some((v) => v > 0) ? 1 : 0.35} />
    </svg>
  );
}
