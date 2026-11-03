import { ArrowUpRight } from 'lucide-react';
import { LEAD_TYPE_LABELS, SCORE_TIER_LABELS, type AdStatus, type HardFilterCheck, type LeadScore, type ScoreTier } from '../../../shared/scoring';
import { cn } from '../../lib/cn';
import { metaLibraryIsPage } from '../../lib/leadView';
import { safeHref } from '../../lib/safeHref';
import { Dot, StatusLine, type Tone } from '../ui/Status';
import { Eyebrow } from './Eyebrow';

const TIER_TONE: Record<ScoreTier, Tone> = { high: 'good', medium: 'warn', low: 'neutral' };
const TIER_BAR: Record<ScoreTier, string> = { high: 'bg-good', medium: 'bg-warn', low: 'bg-ink-2' };

/** Kurz für die Analyse-Zeile „Meta-Ads“ – der ganze Satz steht darunter. */
const AD_SHORT: Record<AdStatus, string> = { active: 'Läuft', historical: 'Früher', none_found: 'Keine', unknown: 'Ungeprüft' };

const percent = (value: number) => `${Math.round(value * 100)}`;

/** Chip oben im Panel: „● Score 91 · Hoch“. */
export function ScoreChip({ score }: { score: LeadScore }) {
  return (
    <span data-testid="score-card" className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-surface-3 px-[11px] text-[13px] font-semibold text-ink">
      <Dot tone={TIER_TONE[score.tier]} className="h-[7px] w-[7px]" />
      <span>
        Score <span data-testid="score-total" className="tabular-nums">{percent(score.total)}</span> · {SCORE_TIER_LABELS[score.tier]}
      </span>
    </span>
  );
}

/** Verletzte Hard-Filter – unter der Statuskarte, damit sie niemand übersieht. */
export function FailedFilters({ score }: { score: LeadScore }) {
  const failed = score.hardFilters.filter((check) => check.passed === false);
  if (failed.length === 0) return null;
  return (
    <StatusLine tone="bad" className="mt-3 text-[13px]">
      Hard-Filter nicht erfüllt: {failed.map((check) => check.label).join(', ')}
    </StatusLine>
  );
}

/** Analyse-Reiter: Score groß, Opportunity, Lead-Typ, Meta-Ads, ICP-Teile und der Weg in die Werbebibliothek. */
export function ScoreAnalysis({ score, libraryUrl }: { score: LeadScore; libraryUrl: string | null }) {
  const adsKnown = score.ads.status !== 'unknown';
  return (
    <section data-testid="score-details" className="rounded-2xl bg-surface-3 p-4">
      <h3 className="sr-only">Score</h3>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[40px] font-bold leading-none tracking-[-0.025em] tabular-nums">{percent(score.total)}</span>
        <span className="text-[15px] text-ink-2">/ 100</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink">
          <Dot tone={TIER_TONE[score.tier]} className="h-[7px] w-[7px]" />
          {SCORE_TIER_LABELS[score.tier]}
        </span>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <div className={cn('h-full origin-left rounded-full', TIER_BAR[score.tier])} style={{ transform: `scaleX(${score.total})` }} />
      </div>

      <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2.5 text-[14px]">
        <dt className="text-ink-2">
          ICP <span className="text-ink-3">· 70 % des Scores</span>
        </dt>
        <dd className="text-right font-semibold tabular-nums">{percent(score.icp.score)}</dd>
        <dt className="text-ink-2">
          Opportunity <span className="text-ink-3">· 30 % des Scores</span>
        </dt>
        <dd className="text-right font-semibold tabular-nums">{percent(score.ads.opportunity)}</dd>
        <dt className="text-ink-2">Lead-Typ</dt>
        <dd className="text-right font-semibold">{LEAD_TYPE_LABELS[score.leadType]}</dd>
        <dt className="text-ink-2">
          Meta-Ads {adsKnown && <span className="text-ink-3">· {percent(score.ads.confidence)} % sicher</span>}
        </dt>
        <dd className="text-right font-semibold">{AD_SHORT[score.ads.status]}</dd>
      </dl>
      {adsKnown && score.ads.detail && <p className="mt-2.5 text-[12.5px] leading-[1.45] text-ink-2">{score.ads.detail}</p>}

      {libraryUrl && (
        <a
          href={safeHref(libraryUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex h-[42px] items-center justify-center gap-1 rounded-xl bg-surface-4 text-[14px] font-semibold text-ink transition-colors hover:bg-white/10"
        >
          {metaLibraryIsPage(libraryUrl) ? 'Seite in der Meta-Werbebibliothek' : 'In der Meta-Werbebibliothek suchen'}
          <ArrowUpRight className="h-4 w-4" />
        </a>
      )}

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <p className="mb-2.5 text-[12px] text-ink-3">ICP · Daten für {percent(score.completeness)} % der Gewichte</p>
        <ul className="space-y-2.5">
          {score.icp.components.map((component) => (
            <li key={component.key}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="text-ink">
                  {component.label} <span className="text-ink-3">· {percent(component.weight)} %</span>
                </span>
                <span className="tabular-nums text-ink-2">{component.value === null ? 'unbekannt' : percent(component.value)}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
                <div className="h-full origin-left rounded-full bg-ink/60" style={{ transform: `scaleX(${component.value ?? 0})` }} />
              </div>
              <p className="mt-1 text-[12px] leading-[1.45] text-ink-3">{component.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const CHECK_MARK = (check: HardFilterCheck) =>
  check.passed === true ? <span className="text-good">✓</span> : check.passed === false ? <span className="text-bad">✕</span> : <span className="text-warn">?</span>;

const checkState = (check: HardFilterCheck) => (check.passed === true ? 'erfüllt' : check.passed === false ? 'nicht erfüllt' : 'nicht geprüft');

/** Hard-Filter mit Begründung (Analyse-Reiter). */
export function HardFilterList({ checks }: { checks: HardFilterCheck[] }) {
  const passed = checks.filter((check) => check.passed === true).length;
  return (
    <section data-testid="hard-filters">
      <Eyebrow>
        Hard-Filter · {passed} von {checks.length} erfüllt
      </Eyebrow>
      <ul className="overflow-hidden rounded-2xl bg-surface-3">
        {checks.map((check) => (
          <li key={check.key} className="flex gap-2.5 border-b border-white/[0.05] px-3.5 py-3 last:border-b-0">
            <span aria-hidden className="w-3.5 shrink-0 text-[14px]">
              {CHECK_MARK(check)}
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-ink">
                {check.label}
                <span className="sr-only">: {checkState(check)}</span>
              </p>
              <p className="mt-0.5 text-[13px] leading-[1.4] text-ink-2 [overflow-wrap:anywhere]">{check.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Kurz-Chips mit Häkchen („✓ Branche passt“) in „Warum dieser Lead“. */
export function HardFilterChips({ checks }: { checks: HardFilterCheck[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Hard-Filter">
      {checks.map((check) => (
        <li key={check.key} className="inline-flex h-[26px] items-center gap-[5px] rounded-full bg-surface-4 px-[9px] text-[12px] text-ink/85">
          <span aria-hidden>{CHECK_MARK(check)}</span>
          {check.label}
          <span className="sr-only">: {checkState(check)}</span>
        </li>
      ))}
    </ul>
  );
}
