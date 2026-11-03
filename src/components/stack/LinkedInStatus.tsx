import { RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AuthFounderId } from '../../../shared/auth';
import type { LinkedInLimit, LinkedInSyncResponse } from '../../../shared/linkedin';
import { cn } from '../../lib/cn';
import { ApiError, linkedinApi } from '../../lib/leadSearchApi';
import { formatRelative } from '../../lib/time';
import { FOUNDERS } from '../../data/founders';
import { useAccess } from '../../state/auth';
import { useDemo } from '../../state/demo';
import { linkedInBlock, useLinkedIn, type BlockKind } from '../../state/linkedin';
import type { CardType, FounderId } from '../../state/types';
import { useSendState } from './actionMode';
import { Disclosure } from '../ui/Disclosure';
import { StatusLine } from '../ui/Status';

const count = (limit: LinkedInLimit, one: string, many: string) => (
  <span className={cn('tabular-nums', limit.used >= limit.limit && 'text-ink')}>
    {limit.used} / {limit.limit} {limit.limit === 1 ? one : many}
  </span>
);

function syncSummary(result: LinkedInSyncResponse): string {
  const parts = [];
  if (result.accepted.length) parts.push(`${result.accepted.length} ${result.accepted.length === 1 ? 'Anfrage angenommen' : 'Anfragen angenommen'}`);
  if (result.replied.length) parts.push(`${result.replied.length} ${result.replied.length === 1 ? 'neue Antwort' : 'neue Antworten'}`);
  return parts.length ? parts.join(' · ') : 'Nichts Neues';
}

/**
 * Startseite: eine ruhige Zeile, wie gesendet wird. Ein Klick öffnet die selten gebrauchten Details (Tageszähler,
 * Abgleich, `details` – z. B. die automatische Suche). Probleme (Pause, Arbeitszeit, Limit, Abgleich-Fehler) stehen
 * immer sichtbar darüber.
 */
export function LinkedInStatus({ details }: { details?: ReactNode }) {
  // Oben, vor den Zweigen: Der Aufklapp-Zustand überlebt den Wechsel vom Protokoll- in den Sende-Zweig (Status lädt noch).
  const [open, setOpen] = useState(false);
  const { status, account, canSend, sync, runSync, reloadStatus } = useLinkedIn();
  const { state } = useDemo();
  const { role } = useAccess();
  const founderName = state.founder ? FOUNDERS[state.founder].name : 'dem Gründer';
  // Aus dem Tagesstapel: heutige Anfragen zählen gegen das Tageslimit neuer Leads.
  const founder = state.founder;
  // Seit 25.10. wie der Server: Anfragen über deinen Account gegen das Limit deines Accounts (nicht Anfragen für deine
  // Leads – die können über den anderen Account gegangen sein). Ältere Backends: wie bisher.
  const byAccount = state.stack.invitesByAccount;
  const invitesToday = founder
    ? byAccount
      ? (byAccount[founder] ?? 0)
      : state.stack.invitesToday
        ? (state.stack.invitesToday[founder] ?? 0)
        : null
    : null;
  // Sperre: das eingestellte Anfragen-Limit (LINKEDIN_INVITES_PER_DAY); ältere Backends ohne Angabe → Karten pro Tag.
  const viaByOwner = state.stack.inviteViaByOwner;
  const switching = (founder && viaByOwner ? founder in viaByOwner : false) || state.stack.inviteVia !== undefined;
  const nextVia = founder && viaByOwner && founder in viaByOwner ? viaByOwner[founder] : state.stack.inviteVia;
  const perAccount = (founder && state.stack.invitesPerDayByAccount?.[founder]) ?? state.stack.rules?.invitesPerDay;
  const newLeadsPerDay =
    byAccount && perAccount !== undefined
      ? perAccount
      : perAccount !== undefined
        ? perAccount * (state.stack.rules?.inviteAccounts ?? 1)
        : (state.stack.rules?.newLeadsPerDay ?? null);

  if (!canSend) {
    const hint =
      role === 'admin'
        ? `Als Admin trägst du nur ein – gesendet wird auf LinkedIn von ${founderName}.`
        : status && status.mode !== 'off' && account && !account.connected
          ? 'Für dich ist kein LinkedIn-Account verbunden – vernetzen und schreiben auf LinkedIn, dann hier eintragen.'
          : status?.watching
            ? 'Das Cockpit sendet noch nichts – vernetzen und schreiben auf LinkedIn, dann hier eintragen. Angenommene Anfragen erkennt es automatisch.'
            : 'Das Cockpit sendet noch nichts – vernetzen und schreiben auf LinkedIn, dann hier eintragen.';
    const known = invitesToday !== null && newLeadsPerDay !== null;
    return (
      <div className="flex max-w-[440px] flex-col items-center gap-1.5 text-[13px] leading-[1.55] text-ink-3">
        {known && (switching ? nextVia === null : invitesToday >= newLeadsPerDay) && (
          <StatusLine role="status" testId="invites-limit">
            {invitesToday >= newLeadsPerDay
              ? `Tageslimit für Vernetzungsanfragen erreicht (${newLeadsPerDay}) – morgen geht es weiter.`
              : 'Vernetzungsanfragen gerade gesperrt (Limit in 7 Tagen oder Account nicht verbunden).'}
          </StatusLine>
        )}
        {known ? (
          <Disclosure
            testId="home-details"
            open={open}
            onOpenChange={setOpen}
            summary={<span data-testid="protocol-hint">{hint}</span>}
            contentClassName="mt-1.5 flex flex-col items-center gap-1.5"
          >
            <p data-testid="invites-today">
              Heute <span className="tabular-nums">{invitesToday} / {newLeadsPerDay}</span> Anfragen {byAccount ? 'über deinen Account' : 'eingetragen'}
            </p>
            {details}
          </Disclosure>
        ) : (
          <p data-testid="protocol-hint">{hint}</p>
        )}
      </div>
    );
  }

  const blocks = [
    ...new Set((['invite', 'message'] as const).map((kind) => linkedInBlock(status, account, kind, Date.now(), nextVia)).filter(Boolean)),
  ] as string[];
  const running = sync.status === 'running';

  return (
    <div className="flex max-w-[480px] flex-col items-center gap-1.5 text-[13px] leading-[1.55] text-ink-3" data-testid="linkedin-status">
      {blocks.map((block) => (
        <StatusLine key={block} role="status">
          {block}
        </StatusLine>
      ))}
      {founder && account?.pausedUntil && account.pausedUntil > Date.now() && <ResumeButton founder={founder} onDone={reloadStatus} />}
      {sync.status === 'error' && (
        <StatusLine
          role="status"
          testId="linkedin-sync-error"
          className="flex-wrap justify-center"
          action={
            <button type="button" onClick={() => void runSync()} className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
              Erneut versuchen
            </button>
          }
        >
          {sync.message}
        </StatusLine>
      )}
      {sync.status === 'done' &&
        sync.result.problems.map((problem) => (
          <StatusLine key={problem} role="status">
            {problem}
          </StatusLine>
        ))}
      <Disclosure
        testId="home-details"
        open={open}
        onOpenChange={setOpen}
        summary={`Gesendet wird über ${role === 'assistant' ? `den LinkedIn-Account von ${founderName}` : 'deinen LinkedIn-Account'}`}
        contentClassName="mt-1.5 flex flex-col items-center gap-1.5"
      >
        <p>
          Heute {count(account!.invitesToday, 'Anfrage', 'Anfragen')} · {count(account!.messagesToday, 'Nachricht', 'Nachrichten')}
        </p>
        <p className="flex flex-wrap items-center justify-center gap-x-2">
          <span data-testid="linkedin-sync-state">
            {running
              ? 'Wird abgeglichen …'
              : sync.status === 'done'
                ? `Abgeglichen: ${syncSummary(sync.result)}`
                : status!.lastSyncAt
                  ? `Abgeglichen ${formatRelative(status!.lastSyncAt)}`
                  : 'Noch nicht abgeglichen'}
          </span>
          <button
            type="button"
            onClick={() => void runSync()}
            disabled={running}
            className="inline-flex items-center gap-1 font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline disabled:opacity-40"
            data-testid="linkedin-sync"
          >
            <RefreshCw className={cn('h-3 w-3', running && 'animate-spin')} aria-hidden />
            Jetzt abgleichen
          </button>
        </p>
        {details}
      </Disclosure>
    </div>
  );
}

/**
 * Pause aufheben (statt `linkedinCli fortsetzen`). Zwei Klicks: Die Pause hat einen Grund (Limit oder Zugangsfehler
 * bei LinkedIn) – aufheben nur, wenn er behoben ist.
 */
function ResumeButton({ founder, onDone }: { founder: AuthFounderId; onDone: () => void }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);

  const resume = async () => {
    setStep('busy');
    setError(null);
    try {
      await linkedinApi.resume({ founder });
      onDone();
      setStep('idle');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Die Pause ließ sich nicht aufheben.');
      setStep('idle');
    }
  };

  return (
    <p className="flex flex-wrap items-center justify-center gap-x-2" data-testid="linkedin-resume">
      {step === 'confirm' ? (
        <>
          <span className="text-ink-2">Nur aufheben, wenn der Grund behoben ist.</span>
          <button type="button" onClick={() => void resume()} className="font-medium text-ink underline-offset-4 hover:underline" data-testid="linkedin-resume-confirm">
            Ja, jetzt aufheben
          </button>
          <button type="button" onClick={() => setStep('idle')} className="text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">
            Abbrechen
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setStep('confirm')}
          disabled={step === 'busy'}
          className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline disabled:opacity-40"
          data-testid="linkedin-resume-start"
        >
          {step === 'busy' ? 'Wird aufgehoben …' : 'Pause aufheben'}
        </button>
      )}
      {error && (
        <span role="alert" className="w-full text-center text-ink">
          {error}
        </span>
      )}
    </p>
  );
}

const BLOCK_KIND: Partial<Record<CardType, BlockKind>> = { lead: 'invite', first: 'message', followup: 'message' };

/** Fokus-Modus: Warum diese Karte gerade nicht über LinkedIn rausgeht (Pause, Arbeitszeit, Limit). */
export function LinkedInBlockLine({ type, owner }: { type: CardType; owner?: FounderId }) {
  const { status } = useLinkedIn();
  const { state } = useDemo();
  // Gesendet wird über den Account des Besitzers (18.10.) – also gelten dessen Pausen und Limits.
  const send = useSendState(owner);
  const account = status?.accounts.find((entry) => entry.founder === send.owner) ?? null;
  const kind = BLOCK_KIND[type];
  const byOwner = state.stack.inviteViaByOwner;
  const via = send.owner && byOwner && send.owner in byOwner ? byOwner[send.owner] : state.stack.inviteVia;
  const block = send.mode === 'send' && kind ? linkedInBlock(status, account, kind, Date.now(), via) : null;
  if (!block) return null;
  return (
    <StatusLine testId="linkedin-block" className="mx-auto mt-4 max-w-[600px] px-5 text-[13.5px]">
      {block}
    </StatusLine>
  );
}
