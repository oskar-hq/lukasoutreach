import { motion } from 'motion/react';
import { AI_PURPOSES, AI_PURPOSE_LABELS, type DashboardResponse } from '../../../shared/dashboard';
import { LEAD_STAGES } from '../../../shared/leads';
import { formatInt, formatShortDate } from '../../lib/format';
import { SectionLabel } from '../ui/SectionLabel';
import { CHART, ChartCard } from './ChartParts';

const euroCents = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euroWhole = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const OPEN_STAGES = LEAD_STAGES.filter((stage) => stage !== 'lost');

/**
 * KI-Kosten gegen den offenen Deal Value (Wunsch des Nutzers 11.10.): was die Claude-API gekostet hat (Listenpreise,
 * vom Backend je Aufruf gezählt), im Durchschnitt je qualifiziertem und je abgeschlossenem (übergebenen) Lead, je Zweck –
 * und wie oft der offene Deal Value das deckt. Für beide Gründer
 * zusammen (ein API-Schlüssel), unabhängig von der Auswahl Nick/Johannes.
 */
export function AiCostSection({ data }: { data: DashboardResponse }) {
  const cost = data.aiCost!;
  const dealValue = data.dealValue
    ? Object.values(data.dealValue).reduce((sum, stages) => sum + OPEN_STAGES.reduce((inner, stage) => inner + (stages[stage] ?? 0), 0), 0)
    : 0;
  // Durchschnitte vom Backend (live bei jedem Abruf); ältere Backends ohne Felder: selbst rechnen bzw. „–“.
  const perQualified = cost.perQualifiedEur !== undefined ? cost.perQualifiedEur : cost.leads > 0 ? cost.totalEur / cost.leads : null;
  const perClosed = cost.perClosedEur ?? null;
  const closed = cost.closedLeads ?? 0;
  const ratio = cost.totalEur > 0 ? dealValue / cost.totalEur : null;
  const max = Math.max(0.01, ...AI_PURPOSES.map((purpose) => cost.byPurpose[purpose]));

  return (
    <section aria-labelledby="ai-cost-title" data-testid="ai-cost-section">
      <SectionLabel id="ai-cost-title" className="mb-3">
        KI-Kosten · Claude-API{cost.since ? ` seit ${formatShortDate(cost.since)}` : ''}
      </SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Ausgaben gegen offenen Deal Value" className="lg:col-span-2">
          {cost.calls === 0 ? (
            <p className="py-6 text-[13.5px] text-ink-3" data-testid="ai-cost-empty">
              Noch keine KI-Aufrufe gezählt – die Kosten erscheinen nach der ersten Lead-Suche.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
                <Figure
                  label="Ø je qualifiziertem Lead"
                  value={perQualified === null ? '–' : euroCents.format(perQualified)}
                  note={`${formatInt(cost.leads)} ${cost.leads === 1 ? 'Lead' : 'Leads'}`}
                  testId="ai-cost-per-lead"
                  big
                />
                <Figure
                  label="Ø je abgeschlossenem Lead"
                  value={perClosed === null ? '–' : euroCents.format(perClosed)}
                  note={closed === 0 ? 'noch keiner übergeben' : `${formatInt(closed)} übergeben`}
                  testId="ai-cost-per-closed"
                  big
                />
                <Figure label="Diesen Monat" value={euroCents.format(cost.monthEur)} testId="ai-cost-month" />
                <Figure label="Gesamt" value={euroCents.format(cost.totalEur)} testId="ai-cost-total" />
                <Figure label="Offener Deal Value" value={euroWhole.format(dealValue)} testId="ai-cost-deal-value" />
              </dl>
              <p className="mt-6 text-[13.5px] leading-[1.5] text-ink-2" data-testid="ai-cost-ratio">
                {ratio === null
                  ? 'Noch keine Kosten.'
                  : dealValue === 0
                    ? 'Noch kein Deal Value eingetragen – dann steht hier, wie oft er die KI-Kosten deckt.'
                    : ratio >= 1
                      ? `Der offene Deal Value deckt die KI-Kosten ${formatInt(Math.floor(ratio))}-fach.`
                      : 'Die KI-Kosten liegen noch über dem offenen Deal Value.'}
                <span className="block text-[12px] text-ink-3">
                  {formatInt(cost.calls)} Aufrufe · Listenpreise, 1 $ = {cost.usdToEur.toLocaleString('de-DE')} € – maßgeblich ist die Rechnung in der
                  Anthropic-Konsole.
                </span>
              </p>
            </>
          )}
        </ChartCard>

        <ChartCard title="Wofür">
          <ol className="space-y-3" aria-label="KI-Kosten je Zweck">
            {AI_PURPOSES.map((purpose) => (
              <li key={purpose} data-testid={`ai-cost-${purpose}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[12.5px] font-medium text-ink-2">{AI_PURPOSE_LABELS[purpose]}</span>
                  <span className="text-[12.5px] font-semibold tabular-nums text-ink">{euroCents.format(cost.byPurpose[purpose])}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                  <motion.div
                    className="h-full w-full rounded-full"
                    style={{ background: CHART.primary }}
                    initial={{ x: '-100%' }}
                    animate={{ x: `${(cost.byPurpose[purpose] > 0 ? Math.max(1.5, (cost.byPurpose[purpose] / max) * 100) : 0) - 100}%` }}
                    transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
                  />
                </div>
              </li>
            ))}
          </ol>
        </ChartCard>
      </div>
    </section>
  );
}

function Figure({ label, value, testId, big, note }: { label: string; value: string; testId: string; big?: boolean; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-ink-3">{label}</dt>
      <dd
        className={big ? 'display mt-1 text-[28px] font-semibold leading-none tabular-nums text-ink' : 'mt-1.5 text-[17px] font-semibold tabular-nums text-ink'}
        data-testid={testId}
      >
        {value}
      </dd>
      {note && <dd className="mt-1 text-[12px] text-ink-3">{note}</dd>}
    </div>
  );
}
