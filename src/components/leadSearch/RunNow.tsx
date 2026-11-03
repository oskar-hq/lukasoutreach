import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { funnelOf, type PipelineLead, type RunSnapshot } from '../../../shared/leadSearch';
import { Spinner } from './Funnel';
import { fullName } from './status';

/** „Name · Firma“ des Leads, an dem gerade gearbeitet wird. */
function who(lead: PipelineLead): string {
  const company = lead.profile?.companyName;
  return company ? `${fullName(lead)} · ${company}` : fullName(lead);
}

export interface RunNowState {
  /** Was gerade passiert, in einem Satz. */
  text: string;
  /** Der Lead dazu (Name · Firma) – fehlt, solange es keinen gibt. */
  detail: string | null;
  /** Fortschritt beim Profilelesen (gelesen / geplant) – nur in dieser Phase, sonst null. */
  progress: { done: number; total: number } | null;
}

/**
 * Was die Suche gerade tut – nur aus dem, was der Server schon live schickt (Phase, Status der Leads). Labor Illusion
 * ehrlich (Wunsch des Nutzers 25.10.: „man soll sehen, dass gearbeitet wird“): nichts erfunden, nichts künstlich verzögert.
 */
export function runNow(run: RunSnapshot): RunNowState {
  const funnel = funnelOf(run.leads);
  const { keywords, positions } = run.profile;
  if (run.phase === 'search') {
    const about = [keywords[0], positions[0]].filter(Boolean).join(' · ');
    return {
      text: funnel.found ? `Sucht auf LinkedIn · ${funnel.found.toLocaleString('de-DE')} Treffer bisher` : 'Sucht auf LinkedIn …',
      detail: about ? `nach ${about}${keywords.length + positions.length > 2 ? ' und mehr' : ''}` : null,
      progress: null,
    };
  }
  if (run.phase === 'dedupe') {
    return { text: `Gleicht ${funnel.found.toLocaleString('de-DE')} Treffer mit deinen Leads ab …`, detail: 'Wer schon im Cockpit oder auf der Tracking-Liste ist, fliegt raus', progress: null };
  }
  if (run.phase === 'screen') {
    const current = run.leads.find((lead) => lead.status === 'unique' && !lead.prescreen);
    return {
      text: `KI prüft ${funnel.unique.toLocaleString('de-DE')} Headlines vor`,
      detail: current ? fullName(current) : null,
      progress: null,
    };
  }
  // Profile lesen und bewerten: geplant sind höchstens `maxResults` der vorgeprüften Treffer.
  const total = Math.max(1, Math.min(run.profile.maxResults, funnel.screened ?? funnel.unique));
  const done = Math.min(funnel.enriched, total);
  const enriching = run.leads.find((lead) => lead.status === 'enriching');
  if (enriching) return { text: `Liest Profil ${Math.min(done + 1, total)} von ${total}`, detail: who(enriching), progress: { done, total } };
  const qualifying = run.leads.find((lead) => lead.status === 'qualifying');
  if (qualifying) return { text: 'KI bewertet', detail: who(qualifying), progress: { done, total } };
  const ads = run.leads.find((lead) => lead.status === 'checking_ads');
  if (ads) return { text: 'Prüft die Meta-Werbebibliothek', detail: ads.profile?.companyName ?? fullName(ads), progress: { done, total } };
  return { text: 'Legt die passenden Leads in deinen Stapel …', detail: null, progress: { done, total } };
}

/** Restzeit aus dem bisherigen Tempo beim Profilelesen – erst ab 3 gelesenen Profilen, damit die Schätzung trägt. */
function useRemaining(progress: RunNowState['progress']): number | null {
  const start = useRef<{ at: number; done: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  if (!progress) return null;
  if (!start.current) start.current = { at: Date.now(), done: progress.done };
  const read = progress.done - start.current.done;
  if (read < 3 || progress.done >= progress.total) return null;
  const perProfile = (now - start.current.at) / read;
  return Math.max(0, perProfile * (progress.total - progress.done));
}

function remainingText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? 'noch unter 1 Min.' : `noch ca. ${minutes} Min.`;
}

/** Eine Zeile unter dem Titel: Schritt, gerade bearbeiteter Lead, beim Profilelesen ein Balken mit Restzeit. */
export function RunNow({ run }: { run: RunSnapshot }) {
  const state = runNow(run);
  const remaining = useRemaining(state.progress);
  return (
    <div className="mt-3 max-w-[640px]" data-testid="run-now">
      <p className="flex items-center gap-2 text-[15px] font-medium text-ink" aria-live="polite">
        <Spinner className="h-3.5 w-3.5 shrink-0" />
        <span data-testid="run-now-text">{state.text}</span>
      </p>
      {state.detail && (
        <p className="mt-1 truncate pl-[22px] text-[13.5px] text-ink-2" data-testid="run-now-detail">
          {state.detail}
        </p>
      )}
      {state.progress && (
        <div className="mt-3 flex items-center gap-3 pl-[22px]">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <motion.div
              className="h-full origin-left rounded-full bg-ink"
              initial={false}
              animate={{ scaleX: state.progress.done / state.progress.total }}
              transition={{ type: 'spring', bounce: 0, duration: 0.6 }}
            />
          </div>
          {remaining !== null && <span className="shrink-0 text-[12.5px] tabular-nums text-ink-3" data-testid="run-now-remaining">{remainingText(remaining)}</span>}
        </div>
      )}
    </div>
  );
}
