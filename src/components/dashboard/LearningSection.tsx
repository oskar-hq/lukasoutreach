import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import {
  LEAD_FEEDBACK_REASON_LABELS,
  LEARNING_QUERY_STALE_DAYS,
  LEARNING_WEEK_MIN_RATED,
  type LearningEfficiency,
  type LearningSummary,
} from '../../../shared/learning';
import { formatInt, formatShortDate } from '../../lib/format';
import { ApiError, learningApi, saveBlob } from '../../lib/leadSearchApi';
import { Button } from '../ui/Button';
import { SectionLabel } from '../ui/SectionLabel';
import { CHART, ChartCard } from './ChartParts';

const pct = (value: number) => `${Math.round(value * 100)} %`;

/**
 * Was der Scraper gelernt hat (Wunsch des Nutzers 13.10., `shared/learning.ts`): Rückmeldungen (👍/👎 von Hand,
 * Antworten/Termine automatisch), wie viele davon die KI als Beispiele bekommt, Trefferquote je Woche, welche
 * Suchanfragen gute Leads bringen – und Hinweise, die die Software nicht selbst umsetzt. Für beide Gründer zusammen.
 * Lädt mit dem Dashboard neu (`refreshKey`). Ältere Backends ohne `/api/learning`: Abschnitt bleibt weg.
 *
 * 09.11. (Nutzer: „blicke da nicht durch“): Erklärsatz oben, Wochenbalken mit Prozent und Datum, unter
 * `LEARNING_WEEK_MIN_RATED` Bewertungen „zu wenig Daten“ statt einer Quote, Profilabrufe je qualifiziertem Lead,
 * alte Suchanfragen markiert – und der Optimierungs-Bericht als Markdown-Datei für Claude.
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
  const enoughThisWeek = lastWeek !== null && lastWeek.rated >= LEARNING_WEEK_MIN_RATED;

  return (
    <section aria-labelledby="learning-title" className="mt-10" data-testid="learning-section">
      <SectionLabel id="learning-title" className="mb-3">
        Lernen · Lead-Qualität
      </SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Was der Scraper gelernt hat" className="lg:col-span-2">
          <p className="-mt-1 mb-5 text-[13px] leading-[1.5] text-ink-3" data-testid="learning-explainer">
            Jeder Lead, der antwortet oder einen Termin bekommt, zählt automatisch als „passt“; wer ohne Kontakt auf „Verloren“
            gesetzt wird, als „passt nicht“. Dazu kommen deine Klicks im Lead-Panel. Die KI bekommt die jüngsten davon bei jeder
            Suche als Beispiele mit und sortiert danach.
          </p>
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
                  value={lastWeek && enoughThisWeek ? pct(lastWeek.good / lastWeek.rated) : '–'}
                  note={
                    !lastWeek
                      ? 'noch nichts bewertet'
                      : enoughThisWeek
                        ? `${formatInt(lastWeek.rated)} bewertet`
                        : `erst ${formatInt(lastWeek.rated)} bewertet – zu wenig`
                  }
                  testId="learning-rate"
                />
              </dl>
              {data.weeks.length > 1 && <Weeks weeks={data.weeks} />}
              {data.feedback.bad * 4 < data.feedback.good && (
                <p className="mt-5 text-[12.5px] leading-[1.5] text-ink-3" data-testid="learning-few-bad">
                  Fast nur „passt“-Beispiele: Damit die KI auch lernt, was sie aussortieren soll, markier unpassende Leads im
                  Lead-Panel mit „Passt nicht“ oder setz sie ohne Kontakt auf „Verloren“.
                </p>
              )}
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
          {data.efficiency && <Efficiency efficiency={data.efficiency} />}
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
                <li key={query.label} className="min-w-0" data-stale={query.stale ? 'true' : undefined}>
                  <p className={`truncate text-[12.5px] font-medium ${query.stale ? 'text-ink-3' : 'text-ink-2'}`} title={query.label}>
                    {query.label}
                  </p>
                  <p className="text-[12px] tabular-nums text-ink-3">
                    {formatInt(query.good)} passt · {formatInt(query.qualified)} qualifiziert
                    {query.bad ? ` · ${formatInt(query.bad)} passt nicht` : ''}
                    {query.stale && query.lastSearchedAt ? ` · zuletzt gesucht ${formatShortDate(query.lastSearchedAt)}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {data.topQueries.some((query) => query.stale) && (
            <p className="mt-4 text-[12px] leading-[1.5] text-ink-3" data-testid="learning-stale">
              Grau: seit über {LEARNING_QUERY_STALE_DAYS} Tagen nicht mehr gesucht, z. B. nach dem Wechsel der Zielgruppe – der
              Ertrag ist alt.
            </p>
          )}
          {data.weakQueries.length > 0 && (
            <p className="mt-4 text-[12px] leading-[1.5] text-ink-3" data-testid="learning-weak">
              Seltener: {data.weakQueries.map((query) => query.label).join(' · ')}
            </p>
          )}
        </ChartCard>
      </div>
      <ReportDownload />
    </section>
  );
}

/**
 * Optimierungs-Bericht (09.11.): alle Rohzahlen als Markdown-Datei – der Nutzer gibt sie Claude, um Suche, Modelle und
 * Einstufung zu verbessern. Ohne Namen und Profil-Links.
 */
function ReportDownload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const day = new Date().toLocaleDateString('sv-SE');
      saveBlob(await learningApi.report(), `optimierungs-bericht-${day}.md`);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Der Bericht ließ sich nicht laden.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="learning-report">
      <p className="text-[12.5px] leading-[1.5] text-ink-3">
        Alle Zahlen der letzten 30 Tage – KI-Kosten je Modell, Modellvergleich, Suchanfragen, LinkedIn-Abrufe, Entscheidungen je
        Treffer – als Datei für Claude. Ohne Namen und Profil-Links.
        {error && (
          <span className="block text-warn" role="alert" data-testid="learning-report-error">
            {error}
          </span>
        )}
      </p>
      <Button
        size="sm"
        variant="secondary"
        icon={<Download className="h-3.5 w-3.5" aria-hidden />}
        onClick={download}
        disabled={busy}
        className="shrink-0 self-start sm:self-auto"
        data-testid="learning-report-download"
      >
        {busy ? 'Wird erstellt …' : 'Bericht für Claude (.md)'}
      </Button>
    </div>
  );
}

/** Profilabrufe je qualifiziertem Lead – die Zahl, die die LinkedIn-Accounts schont, wenn sie sinkt. */
function Efficiency({ efficiency }: { efficiency: LearningEfficiency }) {
  return (
    <div className="mt-6 border-t border-white/[0.06] pt-5" data-testid="learning-efficiency">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
        <Figure
          label="Profilabrufe je qualifiziertem Lead"
          value={efficiency.perQualified === null ? '–' : efficiency.perQualified.toLocaleString('de-DE')}
          note={`letzte ${efficiency.days} Tage`}
          testId="learning-per-lead"
        />
        <Figure label="Profilabrufe" value={formatInt(efficiency.profileFetches)} note="alle Accounts" testId="learning-fetches" />
        <Figure label="Qualifiziert" value={formatInt(efficiency.qualified)} note="aus der Lead-Suche" testId="learning-qualified" />
      </dl>
      <p className="mt-3 text-[12px] leading-[1.5] text-ink-3">
        Weniger ist besser: Jeder Abruf zählt gegen das Tageslimit der LinkedIn-Accounts.
      </p>
    </div>
  );
}

/**
 * Trefferquote je Woche als schmale Balken (Anteil „passt“), älteste links, mit Prozent und Datum. Wochen mit weniger
 * als `LEARNING_WEEK_MIN_RATED` Bewertungen: flacher grauer Balken, „zu wenig“.
 */
function Weeks({ weeks }: { weeks: LearningSummary['weeks'] }) {
  return (
    <div className="mt-6" data-testid="learning-weeks">
      <p className="mb-2 text-[12.5px] text-ink-3">Anteil „passt“ je Woche</p>
      <ol className="flex items-end gap-1.5" aria-label="Anteil „passt“ je Woche">
        {weeks.map((week) => {
          const enough = week.rated >= LEARNING_WEEK_MIN_RATED;
          const rate = week.rated > 0 ? week.good / week.rated : 0;
          const label = `Woche ab ${formatShortDate(Date.parse(week.week))}`;
          return (
            <li key={week.week} className="flex min-w-0 flex-1 flex-col items-stretch" title={`${label}: ${week.good} von ${week.rated} passt`}>
              <span className="mb-1 text-center text-[11.5px] font-semibold tabular-nums text-ink-2">{enough ? pct(rate) : 'zu wenig'}</span>
              <div className="flex h-12 flex-col justify-end">
                <motion.div
                  className="w-full origin-bottom rounded-t-[4px]"
                  style={{ background: enough ? CHART.primary : 'rgba(255,255,255,0.12)', height: enough ? `${Math.max(4, rate * 100)}%` : '8%' }}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
                />
              </div>
              <span className="mt-1 truncate text-center text-[11px] tabular-nums text-ink-3">
                {formatShortDate(Date.parse(week.week))} · {formatInt(week.rated)}
              </span>
              <span className="sr-only">
                {label}: {enough ? pct(rate) : 'zu wenig Bewertungen'} ({week.good} von {week.rated})
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11.5px] text-ink-3">Unter dem Balken: Woche ab · Anzahl bewerteter Leads.</p>
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
