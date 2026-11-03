import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, Layers, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { handoffCount, type RunSnapshot } from '../../../shared/leadSearch';
import { ApiError } from '../../lib/leadSearchApi';
import { useHotkeys } from '../../lib/useHotkeys';
import { FOUNDERS } from '../../data/founders';
import { useCockpit } from '../../state/cockpit';
import { useDemo, type HandoffState } from '../../state/demo';
import type { FounderId } from '../../state/types';
import { Button } from '../ui/Button';
import { Funnel } from './Funnel';
import { useLeadSearch } from './LeadSearchProvider';
import { LiveList } from './LiveList';
import { ResultsTable } from './ResultsTable';
import { RunNow } from './RunNow';
import { RunScore } from './RunScore';
import { EASE_OUT } from '../../lib/motion';

function title(run: RunSnapshot, qualified: number): string {
  if (run.status === 'running') return 'Suche läuft …';
  if (run.status === 'done') {
    const unrated = run.leads.filter((lead) => lead.status === 'unrated').length;
    if (qualified === 0 && unrated > 0) return `${unrated} ${unrated === 1 ? 'Lead' : 'Leads'} gefunden – ohne KI-Bewertung`;
    if (qualified === 0) return 'Keine passenden Leads gefunden';
    return qualified === 1 ? '1 neuer Lead gefunden' : `${qualified} neue Leads gefunden`;
  }
  return 'Suche abgebrochen';
}

/** Ein Lauf: Trichter oben, darunter Live-Liste bzw. Ergebnis, unten genau eine Haupt-Aktion. */
export function RunView({ run }: { run: RunSnapshot }) {
  const { state, dispatch } = useDemo();
  const { cancel, handoff, qualify } = useLeadSearch();
  const { commitHandoff, undoHandoff } = useCockpit();
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const running = run.status === 'running';
  // Übergeben werden auch Firmen mit aktiven Meta-Ads (markiert, Entscheidung 07.10.).
  const qualified = handoffCount(run.leads);
  const lastHandoff = state.leadSearch.lastHandoff;
  const handedOff = run.handedOff && lastHandoff?.runId === run.id ? lastHandoff : null;
  // Wie viele der übergebenen Leads heute wirklich im Stapel liegen (Tageslimit für neue Leads).
  // Erst nach einem Laden, das neuer ist als das Speichern – vorher stünde hier kurz eine falsche 0.
  const inStack =
    handedOff?.created && state.stack.fetchedAt !== handedOff.savedAgainst
    ? handedOff.created.filter((leadId) => state.stack.order.some((id) => state.stack.tasks[id]?.lead.id === leadId)).length
    : null;

  // Wer die Seite verlässt, arbeitet weiter – dann wird die Übergabe gespeichert (Rückgängig geht dann nicht mehr).
  const runIdRef = useRef(run.id);
  runIdRef.current = run.id;
  useEffect(() => () => void commitHandoff(runIdRef.current), [commitHandoff]);

  // Neue Suche: Übergabe erst speichern – sonst wären ihre Leads im nächsten Lauf keine Dubletten.
  const newSearch = async () => {
    await commitHandoff(run.id);
    dispatch({ type: 'LS_CLEAR' });
  };
  const startWork = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await commitHandoff(run.id);
    } finally {
      setStarting(false);
    }
    dispatch({ type: 'START_FOCUS', filter: 'lead' });
  };
  const undo = () => {
    if (undoHandoff() === 'too_late') setActionError('Schon gespeichert – Rückgängig geht nicht mehr.');
  };

  const doCancel = async () => {
    setActionError(null);
    try {
      await cancel();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : 'Abbrechen hat nicht geklappt.');
    }
  };

  const doHandoff = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await handoff();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : 'Übergabe hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  };

  // Von Hand qualifiziert: nach der Übergabe liegt der Lead sofort im Tagesstapel – kurz bestätigen.
  const [placed, setPlaced] = useState(0);
  const qualifyLead = async (leadId: string) => {
    const result = await qualify(leadId);
    if (result.placed) setPlaced((count) => count + 1);
    return result;
  };

  const handoffFailed = handedOff?.status === 'failed';
  const primary = running
    ? null
    : handoffFailed
      ? () => void doHandoff()
      : handedOff
        ? () => void startWork()
        : qualified > 0
          ? doHandoff
          : () => void newSearch();
  useHotkeys({ enter: () => primary?.() }, !!primary && !state.panelLeadId);

  const profile = run.profile;
  const fullSummary = [profile.keywords.join(', '), profile.positions.join(', '), profile.region, '2./3. Grad'].join(' · ');
  // Eine Zeile: Region und Stichwörter – der Rest steht im Tooltip.
  const meta = [profile.region, profile.keywords.join(', ')].filter(Boolean).join(' · ');

  return (
    <div className="mx-auto flex min-h-[var(--app-h)] max-w-[1240px] flex-col px-4 pt-8 sm:px-6 sm:pt-10">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="display text-[30px] font-semibold sm:text-[40px]" data-testid="run-title">
            {title(run, qualified)}
          </h1>
          <p className="mt-2 line-clamp-1 max-w-[760px] text-[13.5px] text-ink-3" title={fullSummary} data-testid="run-meta">
            {meta}
          </p>
          {running && <RunNow run={run} />}
        </div>
        {running ? (
          <Button variant="ghost" size="sm" icon={<X className="h-4 w-4" />} onClick={doCancel} data-testid="cancel-search">
            Abbrechen
          </Button>
        ) : handedOff || qualified > 0 ? (
          // Ohne Treffer ist „Neue Suche“ schon die Haupt-Aktion unten – dann nicht doppelt.
          <Button variant="ghost" size="sm" icon={<Search className="h-3.5 w-3.5" />} onClick={() => void newSearch()} data-testid="new-search">
            Neue Suche
          </Button>
        ) : null}
      </header>

      <div className="mt-6">
        <Funnel run={run} />
        {run.searchPlan && run.searchPlan.backlog > 0 && (
          <p className="mt-2 text-[13px] text-ink-3" data-testid="run-search-plan">
            {run.searchPlan.backlog.toLocaleString('de-DE')} Treffer aus der Warteliste
            {run.searchPlan.newHits > 0 ? ` · bis zu ${run.searchPlan.newHits.toLocaleString('de-DE')} neu gesucht` : ' · keine neue Suche nötig'}
          </p>
        )}
        {run.status === 'done' && <RunScore run={run} />}
      </div>

      {run.error && (
        <div className="mt-8 flex gap-3 rounded-[24px] bg-surface-2 p-5" role="alert" data-testid="run-error">
          <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-bad" />
          <div>
            <p className="text-[15px] font-semibold">{run.error.title}</p>
            <p className="mt-1 max-w-[720px] text-[14px] leading-[1.55] text-ink-2">{run.error.message}</p>
          </div>
        </div>
      )}

      <div className="mt-8 flex-1 pb-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={running ? 'live' : 'results'}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            {running ? <LiveList run={run} /> : <ResultsTable leads={run.leads} onQualify={qualifyLead} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {!running && (
        <div className="sticky bottom-[var(--nav-bottom)] z-10 -mx-4 bg-gradient-to-t from-canvas from-70% to-transparent px-5 pb-5 pt-8 sm:-mx-6">
          <div className="mx-auto w-full max-w-[600px]">
            {actionError && (
              <p role="alert" className="mb-3 flex items-baseline justify-center gap-2 text-center text-[13px] text-ink">
                <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
                {actionError}
              </p>
            )}
            {placed > 0 && (
              <p role="status" className="mb-2 text-center text-[13px] text-ink-2" data-testid="manual-placed">
                {placed === 1 ? '1 Lead von Hand qualifiziert – liegt im Cockpit' : `${placed} Leads von Hand qualifiziert – liegen im Cockpit`}
              </p>
            )}
            {handedOff ? (
              <>
                <HandoffStatus handoff={handedOff} inStack={inStack} onUndo={undo} onRetry={() => void doHandoff()} />
                <Button
                  variant="primary"
                  size="xl"
                  shortcut={starting || busy ? undefined : '↵'}
                  onClick={() => void primary?.()}
                  disabled={starting || busy}
                  aria-busy={starting || busy}
                  className="w-full"
                  data-testid="start-new-leads"
                >
                  {!handoffFailed && <Layers className="h-4 w-4" />}
                  {handoffFailed ? (busy ? 'Wird erneut versucht …' : 'Erneut versuchen') : starting ? 'Wird übernommen …' : 'Jetzt abarbeiten'}
                </Button>
              </>
            ) : qualified > 0 ? (
              <Button
                variant="primary"
                size="xl"
                shortcut="↵"
                onClick={doHandoff}
                disabled={busy}
                className="w-full"
                data-testid="handoff"
              >
                {busy ? (
                  'Wird in den Tagesstapel gelegt …'
                ) : (
                  <>
                    {qualified === 1 ? '1 Lead' : `${qualified} Leads`} in den Tagesstapel
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            ) : (
              <Button variant="primary" size="xl" shortcut="↵" onClick={() => void newSearch()} className="w-full" data-testid="new-search">
                Neue Suche
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Stand der Übergabe: noch rückgängig machbar → wird gespeichert → gespeichert (mit Dubletten und Tageslimit). */
function HandoffStatus({
  handoff,
  inStack,
  onUndo,
  onRetry,
}: {
  handoff: HandoffState;
  inStack: number | null;
  onUndo: () => void;
  onRetry: () => void;
}) {
  const count = handoff.count;
  const leads = count === 1 ? '1 Lead' : `${count} Leads`;
  if (handoff.status === 'failed') {
    return (
      <p role="alert" className="mb-3 flex flex-wrap items-baseline justify-center gap-2 text-center text-[13.5px] text-ink" data-testid="handoff-done">
        <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
        Übernahme hat nicht geklappt: {handoff.error}
        <button type="button" onClick={onRetry} className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
          Erneut versuchen
        </button>
      </p>
    );
  }
  if (handoff.status === 'waiting') {
    return (
      <p role="status" className="mb-3 flex items-baseline justify-center gap-2 text-center text-[13.5px] text-ink" data-testid="handoff-done">
        <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
        {leads} {count === 1 ? 'wartet' : 'warten'} aufs Speichern (offline) – es wird weiter versucht.
      </p>
    );
  }
  const created = handoff.created?.length ?? count;
  const skipped = handoff.skipped ?? [];
  const skippedOwners = [...new Set(skipped.map((entry) => FOUNDERS[entry.owner].name))].join(', ');
  const others = handoff.createdOthers ?? [];
  return (
    <p className="mb-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[13.5px] text-ink-2" data-testid="handoff-done">
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-good text-black">
        <Check className="h-3 w-3" strokeWidth={3.2} />
      </span>
      {handoff.status === 'saved'
        ? others.length > 0
          ? splitSummary(created, others, inStack)
          : created === 0
          ? 'Keine neuen Leads'
          : `${created === 1 ? '1 Lead liegt' : `${created} Leads liegen`} in deinem Tagesstapel${
              inStack !== null && inStack < created ? ` – ${inStack} davon heute (Tageslimit)` : ''
            }`
        : `${count === 1 ? '1 Lead liegt' : `${count} Leads liegen`} in deinem Tagesstapel`}
      {handoff.status === 'saved' && skipped.length > 0 && (
        <span className="text-ink-3">
          · {skipped.length} {skipped.length === 1 ? 'war' : 'waren'} schon im Cockpit ({skippedOwners})
        </span>
      )}
      {handoff.status === 'pending' && (
        <button
          type="button"
          onClick={onUndo}
          className="font-medium text-ink-3 underline-offset-4 transition-colors hover:text-ink hover:underline"
        >
          Rückgängig
        </button>
      )}
    </p>
  );
}

/**
 * Leads auf beide Gründer verteilt (`LEAD_DISTRIBUTION=balanced`, Wunsch des Nutzers 09.10.):
 * „4 Leads bei dir, 3 bei Johannes“ – ohne eigene „3 Leads bei Johannes“.
 */
function splitSummary(mine: number, others: { owner: FounderId }[], inStack: number | null): string {
  const counts = new Map<FounderId, number>();
  for (const entry of others) counts.set(entry.owner, (counts.get(entry.owner) ?? 0) + 1);
  const parts = [...counts].map(([owner, n]) => ({ n, where: `bei ${FOUNDERS[owner].name}` }));
  const limited = inStack !== null && inStack < mine ? ` (${inStack} davon heute im Tagesstapel, Tageslimit)` : '';
  if (mine > 0) parts.unshift({ n: mine, where: `bei dir${limited}` });
  // Nur der erste Teil nennt „Lead(s)“: „4 Leads bei dir, 3 bei Johannes“.
  return parts.map(({ n, where }, index) => (index === 0 ? `${n} ${n === 1 ? 'Lead' : 'Leads'} ${where}` : `${n} ${where}`)).join(', ');
}
