import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const CHART = {
  primary: '#e8e8ed',
  accent: '#2997ff',
  grid: 'rgba(255,255,255,0.07)',
  axis: '#6e6e73',
  surface: '#0c0c0d',
};

interface ChartCardProps {
  title: string;
  legend?: ReactNode;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}

export function ChartCard({ title, legend, children, className, aside }: ChartCardProps) {
  return (
    <section className={cn('flex flex-col rounded-[20px] bg-surface-1 p-5 sm:p-6', className)}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        {legend}
        {aside}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

export function LegendKey({ color, label, shape = 'line' }: { color: string; label: string; shape?: 'line' | 'square' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
      <span
        className={shape === 'line' ? 'h-[2px] w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-[3px]'}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

export function Legend({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{children}</div>;
}

interface TooltipRow {
  color: string;
  label: string;
  value: string;
  shape?: 'line' | 'square';
}

/** Gemeinsame Tooltip-Optik: Wert zuerst und kräftig, Serienname dahinter. */
export function TooltipBox({ title, rows, footnote }: { title: string; rows: TooltipRow[]; footnote?: string }) {
  return (
    <div className="min-w-[160px] rounded-xl border border-line-strong bg-surface-3/95 px-3 py-2.5 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.9)] backdrop-blur-md reduced-transparency:bg-surface-3 reduced-transparency:backdrop-blur-none">
      <p className="mb-1.5 text-[11.5px] text-ink-3">{title}</p>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2 text-[12.5px]">
            <span
              className={row.shape === 'square' ? 'h-2.5 w-2.5 rounded-[3px]' : 'h-[2px] w-3 rounded-full'}
              style={{ background: row.color }}
            />
            <span className="font-semibold tabular-nums text-ink">{row.value}</span>
            <span className="text-ink-2">{row.label}</span>
          </div>
        ))}
      </div>
      {footnote && <p className="mt-1.5 text-[11.5px] text-ink-3">{footnote}</p>}
    </div>
  );
}
