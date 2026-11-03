import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { LEAD_FEEDBACK_REASON_LABELS, type LearningSummary } from '../../../shared/learning';
import { formatInt, formatShortDate } from '../../lib/format';
import { learningApi } from '../../lib/leadSearchApi';
import { SectionLabel } from '../ui/SectionLabel';
import { CHART, ChartCard } from './ChartParts';

const pct = (value: number) => `${Math.round(value * 100)} %`;

/**
 * Was der Scraper gelernt hat (Wunsch des Nutzers 13.10., `shared/learning.ts`): Rückmeldungen (👍/👎 von Hand,
 * Antworten/Termine automatisch), wie viele davon die KI als Beispiele bekommt, Trefferquote je Woche, welche
 * Suchanfragen gute Leads bringen – und Hinweise, die die Software nicht selbst umsetzt. Für beide Gründer zusammen.
 * Lädt mit dem Dashboard neu (`refreshKey`). Ältere Backends ohne `/api/learning`: Abschnitt bleibt weg.
 */
export function LearningSection({ refreshKey }: { refreshKey: unknown }) {
  const [data, setData] = useState<LearningSummary | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    learningApi
      .get({ signal: controller.signal })
      .then(setData)
      // Fehler oder älteres Backend: alter Stand bleibt bzw. der Abschnitt fehlt.
      .catch(() => undefined);
    return () => controller.abort();
  }, [refreshKey]);

  if (!data) return null;
  const rated = data.feedback.good + data.feedback.bad;
  const lastWeek = data.weeks.at(-1) ?? null;

  return (
    <section aria-labelledby="learning-title" className="mt-10" data-testid="learning-section">
      <SectionLabel id="learning-title" className="mb-3">
        Lernen · Lead-Qualität
      </SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Was der Scraper gelernt hat" className="lg:col-span-2">
          {rated === 0 ? (
            <p className="py-6 text-[13.5px] leading-[1.5] text-ink-3" data-testid="learning-empty">
              Noch keine Rückmeldungen. Bewerte Leads im Lead-Panel mit „Passt“ oder „Passt nicht“ – Antworten, Termine und
              Übergaben zählen automatisch. Ab dann bekommt die KI sie bei jeder Suche als Beispiele mit.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
                <Figure label="Beispiele für die KI" value={formatInt(data.examplesInUse)} testId="learning-examples" big />
                <Figure
                  label="Passt"
                  value={formatInt(data.feedback.good)}
                  note={`${formatInt(data.feedback.outcome)} automatisch`}
                  testId="learning-good"
                />
                <Figure label="Passt nicht" value={formatInt(data.feedback.bad)} testId="learning-bad" />
                <Figure
                  label="Trefferquote diese Woche"
                  value={lastWeek && lastWeek.rated > 0 ? pct(lastWeek.good / lastWeek.rated) : '–'}
                  note={lastWeek ? `${formatInt(lastWeek.rated)} bewertet` : undefined}
                  testId="learning-rate"
                />
              </dl>
              {data.weeks.length > 1 && <Weeks weeks={data.weeks} />}
              {data.badReasons.length > 0 && (
                <p className="mt-5 text-[12.5px] leading-[1.5] text-ink-3" data-testid="learning-reasons">
                  Häufigste Gründe für „passt nicht“:{' '}
                  {data.badReasons
                    .slice(0, 3)
                    .map((entry) => `${LEAD_FEEDBACK_REASON_LABELS[entry.reason]} (${formatInt(entry.count)})`)
                    .join(' · ')}
                </p>
              )}
            </>
          )}
          {data.hints.length > 0 && (
            <ul className="mt-5 space-y-2" aria-label="Hinweise" data-testid="learning-hints">
              {data.hints.map((hint) => (
                <li key={hint} className="text-[13px] leading-[1.5] text-warn">
                  {hint}
                </li>
              ))}
            </ul>
          )}
        </ChartCard>

        <ChartCard title="Suchanfragen mit Ertrag">
          {data.topQueries.length === 0 ? (
            <p className="text-[13px] leading-[1.5] text-ink-3" data-testid="learning-queries-empty">
              Sobald Leads aus der Lead-Suche antworten oder bewertet werden, steht hier, welche Suchanfragen sie gefunden
              haben. Ergiebige Anfragen kommen öfter dran.
            </p>
          ) : (
            <ol className="space-y-3" data-testid="learning-queries">
              {data.topQueries.map((query) => (
                <li key={query.label} className="min-w-0">
                  <p className="truncate text-[12.5px] font-medium text-ink-2" title={query.label}>
                    {query.label}
                  </p>
                  <p className="text-[12px] tabular-nums text-ink-3">
                    {formatInt(query.good)} passt · {formatInt(query.qualified)} qualifiziert
                    {query.bad ? ` · ${formatInt(query.bad)} passt nicht` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {data.weakQueries.length > 0 && (
            <p className="mt-4 text-[12px] leading-[1.5] text-ink-3" data-testid="learning-weak">
              Seltener: {data.weakQueries.map((query) => query.label).join(' · ')}
            </p>
          )}
        </ChartCard>
      </div>
    </section>
  );
}

/** Trefferquote je Woche als schmale Balken (Anteil „passt“), älteste links. */
function Weeks({ weeks }: { weeks: LearningSummary['weeks'] }) {
  return (
    <div className="mt-6" data-testid="learning-weeks">
      <p className="mb-2 text-[12.5px] text-ink-3">Trefferquote je Woche</p>
      <ol className="flex h-16 items-end gap-1.5" aria-label="Trefferquote je Woche">
        {weeks.map((week) => {
          const rate = week.rated > 0 ? week.good / week.rated : 0;
          return (
            <li key={week.week} className="flex h-full flex-1 flex-col justify-end" title={`Woche ab ${formatShortDate(Date.parse(week.week))}: ${pct(rate)} von ${week.rated}`}>
              <motion.div
                className="w-full origin-bottom rounded-t-[4px]"
                style={{ background: CHART.primary, height: `${Math.max(4, rate * 100)}%` }}
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
              />
              <span className="sr-only">
                Woche ab {formatShortDate(Date.parse(week.week))}: {pct(rate)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
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
