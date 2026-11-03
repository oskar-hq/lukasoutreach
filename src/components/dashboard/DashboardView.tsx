import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardResponse } from '../../../shared/dashboard';
import { LEAD_STAGES, LEAD_STAGE_LABELS } from '../../../shared/leads';
import { FOUNDERS } from '../../data/founders';
import { formatInt, isoWeek } from '../../lib/format';
import { dashboardApi } from '../../lib/leadSearchApi';
import { formatTime } from '../../lib/time';
import { useAccess, useAuth } from '../../state/auth';
import { useDemo } from '../../state/demo';
import { useTemplates } from '../../state/templates';
import { openSettingsTab } from '../settings/SettingsPage';
import type { FounderId } from '../../state/types';
import { DelayedStatus } from '../stack/FocusView';
import { Button } from '../ui/Button';
import { DisclosureToggle } from '../ui/Disclosure';
import { PageHeader } from '../ui/PageHeader';
import { SectionLabel } from '../ui/SectionLabel';
import { Segmented } from '../ui/Segmented';
import { CHART, ChartCard, Legend, LegendKey } from './ChartParts';
import { ActivityChart, RateBarChart, WeeklyCompareChart, type WeekCompare } from './Charts';
import { AiCostSection } from './AiCostSection';
import { LearningSection } from './LearningSection';
import { KpiTile, type KpiTileProps } from './KpiTile';
import {
  VISIBLE_DAYS,
  countDelta,
  daysFor,
  followUpStats,
  pct,
  rate,
  rateDelta,
  sumDays,
  templateStats,
  weeks,
  type RateStat,
  type Scope,
} from './stats';
import { EASE_OUT } from '../../lib/motion';
import { cn } from '../../lib/cn';

/** Quote als Text – ohne Nenner „–“. */
const rateText = (value: number | null) => (value === null ? '–' : pct(value));

/** `stale`: Nachladen ist fehlgeschlagen, es steht noch der alte Stand. */
type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: DashboardResponse; stale?: boolean };

/** `GET /api/dashboard` – neu laden, sobald sich der Tagesstapel ändert (also nach jeder gespeicherten Entscheidung). */
const DASHBOARD_REFRESH_MS = 60_000;

function useDashboard() {
  const { state } = useDemo();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const requestId = useRef(0);
  const fetchData = useCallback(() => {
    const id = ++requestId.current;
    dashboardApi
      .get()
      .then((data) => id === requestId.current && setLoad({ status: 'ready', data }))
      // Beim Nachladen den alten Stand stehen lassen (als veraltet markiert) – nur ohne Daten den Fehler zeigen.
      .catch(
        () =>
          id === requestId.current &&
          setLoad((current) => (current.status === 'ready' ? { ...current, stale: true } : { status: 'error' })),
      );
  }, []);
  useEffect(() => fetchData(), [fetchData, state.stack.fetchedAt]);
  // Live (Wunsch des Nutzers 11.10.: Kosten je Lead „immer live“): jede Minute neu laden, solange der Tab sichtbar ist.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') fetchData();
    }, DASHBOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [fetchData]);
  const retry = () => {
    setLoad({ status: 'loading' });
    fetchData();
  };
  return { load, retry };
}

type Section = 'overview' | 'templates' | 'team';

export function DashboardView() {
  const { load, retry } = useDashboard();
  const { dispatch } = useDemo();

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-16 pt-8 sm:px-6 sm:pt-10" data-testid="dashboard">
      <PageHeader
        className="mb-6"
        title="Dashboard"
        action={
          // Die KI hat seit 25.10. keinen eigenen Tab mehr (höchstens fünf, Wunsch des Nutzers „weniger Auswahl“) – sie
          // wertet den Outreach aus und steht deshalb hier.
          <Button
            variant="secondary"
            size="sm"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'assistant' })}
            data-testid="dashboard-ask"
          >
            KI fragen
          </Button>
        }
      >
        {load.status === 'ready' && load.stale && (
          <p role="status" className="text-[13px] text-ink-3" data-testid="dashboard-stale">
            Stand {formatTime(load.data.generatedAt)} Uhr – neuere Zahlen konnten nicht geladen werden.
          </p>
        )}
      </PageHeader>

      {load.status === 'loading' ? (
        <div className="flex justify-center py-24">
          <DelayedStatus>Zahlen werden geladen …</DelayedStatus>
        </div>
      ) : load.status === 'error' ? (
        <div role="alert" className="py-24 text-center">
          <p className="text-[15px] text-ink">Die Zahlen konnten nicht geladen werden.</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={retry}>
            Erneut versuchen
          </Button>
        </div>
      ) : (
        <DashboardContent data={load.data} />
      )}
    </div>
  );
}

/** Der Zeitraum steht einmal, direkt am Block, den er beschreibt. */
function PeriodLabel({ weeks }: { weeks: number }) {
  return (
    <SectionLabel className="mb-3" data-testid="dashboard-meta">
      {`Letzte ${weeks} Wochen`}
    </SectionLabel>
  );
}

type Totals = ReturnType<typeof sumDays>;
const acceptRate = (totals: Totals) => rate(totals.accepted, totals.requests);
const replyRate = (totals: Totals) => rate(totals.replies, totals.messaged);

function DashboardContent({ data }: { data: DashboardResponse }) {
  // Trichterbalken laufen nur beim ersten Erscheinen pro Besuch – nicht bei jedem Reiter- oder Personenwechsel.
  const funnelSeen = useRef(false);
  const { dispatch } = useDemo();
  const templates = useTemplates();
  const { auth } = useAuth();
  const access = useAccess();
  // Bearbeiten liegt in den Einstellungen – die gibt es nur mit echter Anmeldung.
  const canEdit = auth.status === 'authenticated' && access.canEditSettings;
  const [scope, setScope] = useState<Scope>('all');
  const [section, setSection] = useState<Section>('overview');
  const [showTrend, setShowTrend] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const days = useMemo(() => daysFor(data, scope), [data, scope]);
  const visible = days.slice(-VISIBLE_DAYS);
  const thisWeek = sumDays(days.slice(-7));
  const lastWeek = sumDays(days.slice(-14, -7));
  const eightWeeks = weeks(days, 8).map(sumDays);
  const total = sumDays(visible);
  // Übergaben an Close gibt es nicht mehr (abgeschaltet) – der Platz zeigt jetzt die KI-Kosten je Lead (Wunsch des
  // Nutzers 31.10.), dieselbe Zahl wie unten „Ø je qualifiziertem Lead“. Gilt für beide Gründer (ein API-Schlüssel).
  const aiCost = data.aiCost;
  const costPerLead = aiCost
    ? aiCost.perQualifiedEur !== undefined
      ? aiCost.perQualifiedEur
      : aiCost.leads > 0
        ? aiCost.totalEur / aiCost.leads
        : null
    : null;

  const kpis: Omit<KpiTileProps, 'showTrend'>[] = [
    {
      label: 'Anfragen',
      value: formatInt(thisWeek.requests),
      ...countDelta(thisWeek.requests, lastWeek.requests),
      trend: eightWeeks.map((week) => week.requests),
    },
    {
      label: 'Annahmequote',
      value: rateText(acceptRate(thisWeek)),
      ...rateDelta(acceptRate(thisWeek), acceptRate(lastWeek)),
      trend: eightWeeks.map((week) => acceptRate(week) ?? 0),
    },
    {
      label: 'Antwortquote',
      value: rateText(replyRate(thisWeek)),
      ...rateDelta(replyRate(thisWeek), replyRate(lastWeek)),
      trend: eightWeeks.map((week) => replyRate(week) ?? 0),
    },
    {
      label: 'Termine',
      value: formatInt(thisWeek.meetings),
      ...countDelta(thisWeek.meetings, lastWeek.meetings),
      trend: eightWeeks.map((week) => week.meetings),
    },
    {
      label: 'Ø Kosten je qualifiziertem Lead',
      testId: 'kpi-cost-per-lead',
      value: costPerLead === null ? '–' : euroCents.format(costPerLead),
      delta: '',
      direction: 'flat',
      note: !aiCost
        ? 'noch keine Daten'
        : `${formatInt(aiCost.leads)} ${aiCost.leads === 1 ? 'qualifizierter Lead' : 'qualifizierte Leads'}${scope === 'all' ? '' : ' · beide'}`,
      trend: [],
    },
  ];

  const funnel: FunnelStage[] = [
    { label: 'Angefragt', value: total.requests },
    { label: 'Vernetzt', value: total.accepted },
    { label: 'Angeschrieben', value: total.messaged },
    { label: 'Geantwortet', hint: 'Auch Antworten nach Follow-ups', value: total.replies },
    { label: 'Termin', value: total.meetings },
  ];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          ariaLabel="Ansicht wählen"
          value={section}
          onChange={setSection}
          options={[
            { value: 'overview', label: 'Überblick' },
            { value: 'templates', label: 'Vorlagen' },
            { value: 'team', label: `${FOUNDERS.nick.name} vs. ${FOUNDERS.johannes.name}` },
          ]}
        />
        {section !== 'team' && (
          <Segmented
            ariaLabel="Gründer filtern"
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'Gesamt' },
              { value: 'nick', label: FOUNDERS.nick.name },
              { value: 'johannes', label: FOUNDERS.johannes.name },
            ]}
          />
        )}
      </div>

      <motion.div
        key={`${section}-${scope}`}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE_OUT }}
        className="space-y-8"
      >
        {section === 'overview' && (
          <>
            <section aria-labelledby="kpi-period">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <SectionLabel id="kpi-period">Letzte 7 Tage · vs. Woche davor</SectionLabel>
                <DisclosureToggle
                  look="chip"
                  testId="kpi-trend-toggle"
                  open={showTrend}
                  onToggle={() => setShowTrend((v) => !v)}
                  controls="kpi-grid"
                >
                  Verlauf
                </DisclosureToggle>
              </div>
              <div id="kpi-grid" className="grid grid-cols-2 gap-x-6 gap-y-7 sm:grid-cols-3 xl:grid-cols-5">
                {kpis.map((kpi) => (
                  <KpiTile key={kpi.label} {...kpi} showTrend={showTrend} />
                ))}
              </div>
            </section>

            {/* Alles auf einen Blick ohne Scrollen (Wunsch des Nutzers 11.10.): Deal Value steht neben dem Trichter. */}
            <section>
              <PeriodLabel weeks={VISIBLE_DAYS / 7} />
              <div className={cn('grid gap-4 lg:grid-cols-3', data.dealValue && 'xl:grid-cols-4')}>
                <ChartCard
                  className="lg:col-span-2"
                  title="Anfragen und Antworten pro Tag"
                  legend={
                    <Legend>
                      <LegendKey color={CHART.primary} label="Anfragen" />
                      <LegendKey color={CHART.accent} label="Antworten" />
                    </Legend>
                  }
                >
                  <ActivityChart days={visible} />
                </ChartCard>

                <ChartCard title="Von der Anfrage zum Termin">
                  <Funnel stages={funnel} seenRef={funnelSeen} />
                </ChartCard>

                {data.dealValue && <DealValueCard data={data} scope={scope} />}
              </div>
            </section>

            {/* Einzelheiten der KI-Kosten und was die KI gelernt hat: einen Klick entfernt, damit der Überblick auf einen
                Bildschirm passt (Wunsch des Nutzers 25.10. „weniger auf einmal“). Die Kurzfassung der Kosten steht in der
                Deal-Value-Karte. */}
            <section className="space-y-8">
              <DisclosureToggle
                look="chip"
                testId="dashboard-more"
                open={showMore}
                onToggle={() => setShowMore((v) => !v)}
                controls={showMore ? 'dashboard-more-content' : undefined}
                className="-ml-2"
              >
                {data.aiCost ? 'KI-Kosten und was die KI gelernt hat' : 'Was die KI gelernt hat'}
              </DisclosureToggle>
              {showMore && (
                <div id="dashboard-more-content" className="space-y-8">
                  {data.aiCost && <AiCostSection data={data} />}
                  <LearningSection refreshKey={data} />
                </div>
              )}
            </section>
          </>
        )}

        {section === 'templates' && (
          // Vorlagen zählt das Backend über den ganzen gelieferten Zeitraum (112 Tage), nicht nur über 8 Wochen.
          <section>
            <PeriodLabel weeks={Math.round(days.length / 7)} />
            <div className="grid gap-4 md:grid-cols-2">
              <ChartCard
                title="Antwortquote je Vorlage"
                aside={
                  canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      // Ohne eigene Höhe im Kartenkopf (sonst stehen die Diagramme beider Karten versetzt); Text bündig
                      // mit dem Kartenrand, auch wenn der Knopf mobil unter den Titel rutscht.
                      className="-mx-3 -my-1.5"
                      data-testid="edit-templates"
                      onClick={() => {
                        openSettingsTab('templates');
                        dispatch({ type: 'SET_VIEW', view: 'settings' });
                      }}
                    >
                      Vorlagen bearbeiten
                    </Button>
                  ) : undefined
                }
              >
                <Rates
                  data={templateStats(data, scope, (id) => templates.byId(id)?.name ?? null, templates.state.status === 'ready')}
                  empty="Noch keine Erstnachrichten im Zeitraum."
                  ariaLabel="Säulendiagramm: Antwortquote je Vorlage"
                />
              </ChartCard>
              <ChartCard title="Antwortquote je Follow-up-Stufe">
                <Rates data={followUpStats(data, scope)} empty="Noch keine Nachrichten im Zeitraum." ariaLabel="Säulendiagramm: Antwortquote je Follow-up-Stufe" />
              </ChartCard>
            </div>
          </section>
        )}

        {section === 'team' && <FounderComparison data={data} />}
      </motion.div>
    </>
  );
}

function Rates({ data, empty, ariaLabel }: { data: RateStat[]; empty: string; ariaLabel: string }) {
  if (!data.some((entry) => entry.sent > 0)) return <p className="py-16 text-center text-[13.5px] text-ink-3">{empty}</p>;
  return <RateBarChart data={data} ariaLabel={ariaLabel} />;
}

interface FunnelStage {
  label: string;
  /** Erklärung als Tooltip am Namen. */
  hint?: string;
  value: number;
}

function Funnel({ stages, seenRef }: { stages: FunnelStage[]; seenRef: { current: boolean } }) {
  const max = stages[0].value || 1;
  const [animateIn] = useState(() => !seenRef.current);
  useEffect(() => {
    seenRef.current = true;
  }, [seenRef]);
  return (
    <ol className="space-y-3.5" aria-label="Trichter von der Anfrage zum Termin">
      {stages.map((stage, index) => {
        const previous = stages[index - 1];
        const last = index === stages.length - 1;
        const share = previous ? rate(stage.value, previous.value) : null;
        return (
          <li key={stage.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] font-medium text-ink" title={stage.hint}>
                {stage.label}
              </span>
              <span className="flex items-baseline gap-2 tabular-nums">
                {share !== null && (
                  <span className="text-[12px] text-ink-3" title="Anteil der vorherigen Stufe">
                    {pct(share)}
                    <span className="sr-only"> der vorherigen Stufe</span>
                  </span>
                )}
                <span className="text-[13.5px] font-semibold text-ink">{formatInt(stage.value)}</span>
              </span>
            </div>
            <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
              {/* Volle Breite, per transform hereingeschoben – kein Layout pro Bild, die runde Kappe bleibt rund. */}
              <motion.div
                className="h-full w-full rounded-full"
                style={{ background: last ? CHART.accent : CHART.primary }}
                initial={animateIn ? { x: '-100%' } : false}
                animate={{ x: `${Math.max(1.5, (stage.value / max) * 100) - 100}%` }}
                transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
/** Offene Stufen in Pipeline-Reihenfolge – „Verloren“ zählt nicht zum offenen Deal Value. */
const OPEN_STAGES = LEAD_STAGES.filter((stage) => stage !== 'lost');

/**
 * Offener Deal Value (Wunsch des Nutzers 11.10.): Summe der im Lead-Panel eingetragenen Deal Values aller nicht
 * verlorenen Leads, darunter je Stufe als Balken. Aktueller Stand, unabhängig vom Zeitraum – steht als eigene Karte
 * neben dem Trichter, damit das Dashboard ohne Scrollen auf einen Bildschirm passt.
 */
function DealValueCard({ data, scope }: { data: DashboardResponse; scope: Scope }) {
  const founders: FounderId[] = scope === 'all' ? FOUNDER_IDS : [scope];
  const byStage = OPEN_STAGES.map((stage) => ({
    stage,
    value: founders.reduce((sum, founder) => sum + (data.dealValue?.[founder]?.[stage] ?? 0), 0),
  }));
  const total = byStage.reduce((sum, entry) => sum + entry.value, 0);
  const max = Math.max(1, ...byStage.map((entry) => entry.value));
  return (
    <ChartCard
      className="lg:col-span-3 xl:col-span-1"
      title="Offener Deal Value"
      aside={<span className="text-[12.5px] text-ink-3">aktueller Stand</span>}
    >
      <div data-testid="deal-value-section">
        <p
          className="display text-[28px] font-semibold leading-none tabular-nums text-ink"
          title="Summe der eingetragenen Deal Values aller offenen Leads (ohne „Verloren“)"
          data-testid="deal-value-total"
        >
          {euro.format(total)}
        </p>
        <p className="sr-only">Summe der eingetragenen Deal Values aller offenen Leads (ohne „Verloren“).</p>
        {total === 0 ? (
          <p className="mt-4 text-[13px] text-ink-3">Noch kein Deal Value eingetragen – im Lead-Panel unter „Deal Value“.</p>
        ) : (
          <ol className="mt-4 space-y-2" aria-label="Offener Deal Value je Stufe">
            {byStage.map((entry) => (
              <li key={entry.stage} data-testid={`deal-value-${entry.stage}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[12.5px] font-medium text-ink-2">{LEAD_STAGE_LABELS[entry.stage]}</span>
                  <span className="text-[12.5px] font-semibold tabular-nums text-ink">{euro.format(entry.value)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                  <motion.div
                    className="h-full w-full rounded-full"
                    style={{ background: entry.stage === 'meeting' || entry.stage === 'handed_over' ? CHART.accent : CHART.primary }}
                    initial={{ x: '-100%' }}
                    animate={{ x: `${(entry.value > 0 ? Math.max(1.5, (entry.value / max) * 100) : 0) - 100}%` }}
                    transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
        {data.aiCost && data.aiCost.calls > 0 && (
          // Kurzfassung der KI-Kosten (beide Gründer zusammen) – Einzelheiten weiter unten.
          <p className="mt-4 text-[12.5px] leading-snug text-ink-3" data-testid="deal-value-ai-cost">
            KI-Kosten bisher <span className="font-semibold tabular-nums text-ink">{euroCents.format(data.aiCost.totalEur)}</span>
            {data.aiCost.perClosedEur != null && (
              <>
                {' '}· Ø je Abschluss <span className="font-semibold tabular-nums text-ink">{euroCents.format(data.aiCost.perClosedEur)}</span>
              </>
            )}
          </p>
        )}
      </div>
    </ChartCard>
  );
}

const euroCents = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const FOUNDER_IDS: FounderId[] = ['nick', 'johannes'];
const countText = (value: number | null) => (value === null ? '' : formatInt(value));

function FounderComparison({ data }: { data: DashboardResponse }) {
  const daily = { nick: daysFor(data, 'nick'), johannes: daysFor(data, 'johannes') };
  const totals = {
    nick: sumDays(daily.nick.slice(-VISIBLE_DAYS)),
    johannes: sumDays(daily.johannes.slice(-VISIBLE_DAYS)),
  };
  const metrics: { label: string; nick: number | null; johannes: number | null; format: (value: number | null) => string }[] = [
    { label: 'Anfragen', nick: totals.nick.requests, johannes: totals.johannes.requests, format: countText },
    { label: 'Annahmequote', nick: acceptRate(totals.nick), johannes: acceptRate(totals.johannes), format: rateText },
    { label: 'Antwortquote', nick: replyRate(totals.nick), johannes: replyRate(totals.johannes), format: rateText },
    { label: 'Termine', nick: totals.nick.meetings, johannes: totals.johannes.meetings, format: countText },
  ];

  const johannesWeeks = weeks(daily.johannes, 8);
  const weekly: WeekCompare[] = weeks(daily.nick, 8).map((week, index) => ({
    week: `KW ${isoWeek(week[week.length - 1].date)}`,
    Nick: sumDays(week).meetings,
    Johannes: johannesWeeks[index] ? sumDays(johannesWeeks[index]).meetings : 0,
  }));

  return (
    <section>
      <PeriodLabel weeks={VISIBLE_DAYS / 7} />
      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-2" title="Kennzahlen">
          <table className="w-full text-[14px] tabular-nums">
            <caption className="sr-only">Kennzahlen der letzten 8 Wochen je Gründer</caption>
            <thead>
              <tr>
                <th scope="col" className="pb-2 text-left font-normal">
                  <span className="sr-only">Kennzahl</span>
                </th>
                {FOUNDER_IDS.map((founder) => (
                  <th key={founder} scope="col" className="pb-2 text-right font-normal">
                    <LegendKey color={founder === 'nick' ? CHART.primary : CHART.accent} label={FOUNDERS[founder].name} shape="square" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => {
                const { nick, johannes } = metric;
                // Den höheren Wert hervorheben – nur wenn beide Zahlen da sind und sich unterscheiden.
                const tone = (founder: FounderId) => {
                  if (nick === null || johannes === null || nick === johannes) return 'text-ink';
                  const higher = nick > johannes ? 'nick' : 'johannes';
                  return founder === higher ? 'font-semibold text-ink' : 'text-ink-2';
                };
                return (
                  <tr key={metric.label}>
                    <th scope="row" className="py-2.5 text-left font-normal text-ink-2">
                      {metric.label}
                    </th>
                    {FOUNDER_IDS.map((founder) => (
                      <td key={founder} className={`py-2.5 text-right ${tone(founder)}`}>
                        {metric.format(metric[founder])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ChartCard>
        <ChartCard
          className="lg:col-span-3"
          title="Termine pro Woche"
          legend={
            <Legend>
              <LegendKey color={CHART.primary} label={FOUNDERS.nick.name} shape="square" />
              <LegendKey color={CHART.accent} label={FOUNDERS.johannes.name} shape="square" />
            </Legend>
          }
        >
          <WeeklyCompareChart data={weekly} />
        </ChartCard>
      </div>
    </section>
  );
}
