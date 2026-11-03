import { useEffect, useRef, useState } from 'react';
import type { MetaRecheckStatus } from '../../../shared/metaRecheck';
import { ApiError, settingsApi } from '../../lib/leadSearchApi';
import { readableError } from '../../lib/leadView';
import { formatDateTime } from '../../lib/time';
import { useCockpit } from '../../state/cockpit';
import { Button } from '../ui/Button';
import { StatusLine } from '../ui/Status';

/** So oft fragt die Seite nach, solange die Nachprüfung läuft. */
const POLL_MS = 3_000;

/**
 * Meta-Ads aller Leads nachprüfen (Wunsch des Nutzers 15.10.): Leads, die vor dem Meta-Token gesucht wurden, bekommen
 * ihren Stand – über den Firmennamen und den privaten Namen der Person. Startet auch von selbst, sobald ein neuer
 * Token gespeichert wird.
 */
export function MetaRecheck({ tokenSet }: { tokenSet: boolean }) {
  const { refresh } = useCockpit();
  const [status, setStatus] = useState<MetaRecheckStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wasRunning = useRef(false);
  // In einer Ref: `refresh` darf das Nachfragen nicht neu starten, wenn sich seine Identität ändert.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const active = status?.state === 'running' || status?.state === 'waiting';

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await settingsApi.metaRecheck();
        if (stopped) return;
        setStatus(next);
        const running = next.state === 'running' || next.state === 'waiting';
        // Gerade fertig geworden: Tagesstapel und Leads mit den neuen Meta-Ständen laden.
        if (wasRunning.current && !running) refreshRef.current();
        wasRunning.current = running;
        if (running) timer = window.setTimeout(() => void load(), POLL_MS);
      } catch (caught) {
        if (!stopped) setError(caught instanceof ApiError ? readableError(caught, 'Stand ließ sich nicht laden.') : 'Backend nicht erreichbar.');
      }
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // Neu abfragen, wenn eine Nachprüfung gestartet wurde (auch durch das Speichern eines Tokens).
  }, [active, tokenSet]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await settingsApi.startMetaRecheck());
    } catch (caught) {
      setError(caught instanceof ApiError ? readableError(caught, 'Start hat nicht geklappt.') : 'Backend nicht erreichbar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="meta-recheck-title" className="w-full" data-testid="meta-recheck">
      {/* Eine Zeile mit Knopf wie die Schalter (Wunsch des Nutzers 23.10.) – die Erklärung braucht niemand. */}
      <div className="flex min-h-[44px] items-center justify-between gap-6">
        <h3 id="meta-recheck-title" className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
          Alle Leads nachprüfen
        </h3>
        <Button size="sm" variant="secondary" disabled={busy || active} onClick={() => void start()} data-testid="meta-recheck-start">
          {active ? 'Läuft …' : status?.state === 'done' ? 'Noch einmal prüfen' : 'Jetzt alle prüfen'}
        </Button>
      </div>
      {status && status.state !== 'idle' && <p className="mt-3 text-[13.5px] text-ink" data-testid="meta-recheck-status">{statusText(status)}</p>}
      {status?.message && status.state !== 'done' && (
        <StatusLine tone={status.state === 'failed' ? 'bad' : 'warn'} className="mt-2 text-[13px]" testId="meta-recheck-message">
          {status.message}
        </StatusLine>
      )}
      {error && (
        <StatusLine tone="bad" role="alert" className="mt-2 text-[13px]">
          {error}
        </StatusLine>
      )}
    </section>
  );
}

function statusText(status: MetaRecheckStatus): string {
  const results = [
    `${status.active} schalten gerade`,
    `${status.stopped} früher geschaltet`,
    `${status.none} ohne Anzeigen`,
    status.unchecked ? `${status.unchecked} nicht prüfbar` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const person = status.byPerson ? ` · ${status.byPerson} davon über den privaten Namen` : '';
  if (status.state === 'running') return `${status.checked} von ${status.total} geprüft – ${results}${person}`;
  if (status.state === 'waiting') return `${status.checked} von ${status.total} geprüft – wartet bis ${status.resumeAt ? formatDateTime(status.resumeAt) : 'gleich'}`;
  const when = status.finishedAt ? `${formatDateTime(status.finishedAt)}: ` : '';
  if (status.state === 'failed') return `${when}abgebrochen nach ${status.checked} von ${status.total} Leads – ${results}${person}`;
  return `${when}${status.checked} Leads geprüft – ${results}${person}`;
}
