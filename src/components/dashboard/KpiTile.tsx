import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { CHART } from './ChartParts';
import type { Direction } from './stats';

export interface KpiTileProps {
  label: string;
  value: string;
  delta: string;
  direction: Direction;
  trend: number[];
  showTrend: boolean;
  /** Statt Vergleich zur Vorwoche eine ruhige Zeile (z. B. „aus 120 Leads“) – für Kennzahlen ohne Wochenwert. */
  note?: string;
  testId?: string;
}

function Sparkline({ values }: { values: number[] }) {
  const width = 96;
  const height = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => [
    (index / Math.max(1, values.length - 1)) * (width - 6) + 3,
    height - 4 - ((value - min) / range) * (height - 8),
  ]);
  const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 block h-8 w-[96px]" aria-hidden>
      <path d={path} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={4} fill={CHART.accent} stroke={CHART.surface} strokeWidth={2} />
    </svg>
  );
}

/** Kennzahl als große Zahl ohne Kasten (DESIGN.md: Typografie statt Kästen). */
export function KpiTile({ label, value, delta, direction, trend, showTrend, note, testId }: KpiTileProps) {
  return (
    <div data-testid={testId ?? `kpi-${label}`}>
      <p className="text-[13px] font-medium text-ink-2">{label}</p>
      <p className="display mt-1 text-[30px] font-semibold tabular-nums sm:text-[34px]" data-testid="kpi-value">
        {value}
      </p>
      {note !== undefined ? (
        <p className="mt-1 whitespace-nowrap text-[12.5px] tabular-nums text-ink-3" data-testid="kpi-note">
          {note}
        </p>
      ) : (
      <p className="mt-1 flex items-center gap-1 whitespace-nowrap text-[12.5px] tabular-nums">
        {direction === 'up' && <ArrowUpRight aria-hidden className="h-3.5 w-3.5 text-good" strokeWidth={2.5} />}
        {direction === 'down' && <ArrowDownRight aria-hidden className="h-3.5 w-3.5 text-bad" strokeWidth={2.5} />}
        <span className={direction === 'flat' ? 'text-ink-3' : 'text-ink'}>{delta}</span>
        <span className="sr-only"> gegenüber der Woche davor</span>
      </p>
      )}
      {showTrend && trend.length > 0 && <Sparkline values={trend} />}
    </div>
  );
}
