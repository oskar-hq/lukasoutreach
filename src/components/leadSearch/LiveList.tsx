import { useEffect, useRef } from 'react';
import type { PipelineLead, RunSnapshot } from '../../../shared/leadSearch';
import { cn } from '../../lib/cn';
import { fullName, statusDetail, statusView, type StatusTone } from './status';

const DOT: Record<StatusTone, string> = {
  neutral: 'bg-ink-3',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  active: 'bg-ink',
};

/** Der Lead, an dem die Pipeline gerade arbeitet – die Liste folgt ihm. */
function activeLeadId(run: RunSnapshot): string | null {
  const leads = run.leads;
  if (run.phase === 'search') return leads.at(-1)?.id ?? null;
  if (run.phase === 'dedupe') return leads.find((lead) => lead.status === 'found')?.id ?? null;
  if (run.phase === 'screen') return leads.find((lead) => lead.status === 'unique' && !lead.prescreen)?.id ?? null;
  return (
    leads.find((lead) => lead.status === 'enriching')?.id ??
    leads.find((lead) => lead.status === 'qualifying' || lead.status === 'checking_ads')?.id ??
    null
  );
}

/** Live-Ansicht: jeder Treffer mit seinem aktuellen Schritt. */
export function LiveList({ run }: { run: RunSnapshot }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  const activeId = activeLeadId(run);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !activeId || Date.now() - userScrolledAt.current < 4000) return;
    // Nur im eigenen Scrollbereich scrollen (ab md) – die Seite selbst bleibt ruhig.
    if (container.scrollHeight <= container.clientHeight) return;
    const row = container.querySelector<HTMLElement>(`[data-lead-id="${CSS.escape(activeId)}"]`);
    if (!row) return;
    const top = row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2;
    container.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [activeId]);

  if (run.leads.length === 0) {
    return <p className="py-10 text-center text-[14px] text-ink-3">Warte auf die ersten Treffer …</p>;
  }

  return (
    <div
      ref={containerRef}
      onWheel={() => (userScrolledAt.current = Date.now())}
      onTouchMove={() => (userScrolledAt.current = Date.now())}
      className="scroll-thin relative md:max-h-[max(320px,calc(100dvh-300px))] md:overflow-y-auto"
      data-testid="live-list"
    >
      <ul className="space-y-0.5">
        {run.leads.map((lead) => (
          <LiveRow key={lead.id} lead={lead} highlighted={lead.id === activeId} />
        ))}
      </ul>
    </div>
  );
}

function LiveRow({ lead, highlighted }: { lead: PipelineLead; highlighted: boolean }) {
  const view = statusView(lead);
  const detail = view.final ? statusDetail(lead) : null;
  const company = lead.profile?.companyName ?? lead.hit.location ?? '';
  return (
    <li
      data-lead-id={lead.id}
      data-status={lead.status}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-2 py-2.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)]',
        // Neue Treffer gleiten sanft herein, statt die Liste springen zu lassen (nur beim Erscheinen, @starting-style).
        'transition-[opacity,translate,background-color] duration-200 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0',
        highlighted && 'rounded-xl bg-white/[0.04]',
        view.final && !highlighted && lead.status !== 'qualified' && 'opacity-60',
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-[14px] font-medium text-ink">{fullName(lead)}</p>
        <p className="truncate text-[12.5px] text-ink-3">{lead.hit.headline}</p>
      </div>
      <p className="hidden truncate text-[13px] text-ink-2 sm:block">{company}</p>
      <div className="flex min-w-0 max-w-[44vw] items-center justify-end sm:max-w-none sm:justify-start">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-2">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[view.tone], view.active && 'animate-pulse motion-reduce:animate-none')} />
          <span className="truncate">
            {view.label}
            {detail && <span className="hidden text-ink-3 sm:inline"> · {detail}</span>}
          </span>
        </span>
      </div>
    </li>
  );
}
