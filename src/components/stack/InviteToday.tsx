import type { LinkedInAccountStatus } from '../../../shared/linkedin';

const clock = (at: number) => new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const date = (at: number) => new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });

/**
 * Startseite (Teammeeting 05.11.): Wie viele Vernetzungsanfragen heute schon rausgingen – über das Cockpit **und** von
 * Hand auf LinkedIn (Sales Navigator) – und wie viele bis zur Tagesgrenze des Accounts noch offen sind. So weiß, wer
 * gerade auf LinkedIn ist, wie viele er noch schicken soll. Dazu „nur von Hand“ und eingeplante Anfragen.
 * Ältere Backends ohne `invitesSentToday` → nichts.
 */
export function InviteToday({ account }: { account: LinkedInAccountStatus | null }) {
  const sent = account?.invitesSentToday;
  if (!account || !sent) return null;
  const left = Math.max(0, sent.limit - sent.used);
  const manual = account.manualInvitesToday ?? 0;
  const queued = account.queuedInvites ?? 0;
  const manualOnly = account.inviteMode === 'manual';
  return (
    <div className="flex flex-col items-center gap-0.5 text-center" data-testid="invites-sent-today">
      <p className="text-[14px] text-ink-2">
        Heute{' '}
        <span className="tabular-nums font-medium text-ink" data-testid="invites-sent-count">
          {sent.used} von {sent.limit}
        </span>{' '}
        Vernetzungsanfragen
        {manual > 0 && <span className="text-ink-3"> · {manual} davon von Hand</span>}
      </p>
      <p className="text-[12.5px] text-ink-3" data-testid="invites-left">
        {left === 0
          ? 'Tagesziel erreicht – morgen geht es weiter.'
          : manualOnly
            ? `Noch ${left} von Hand auf LinkedIn schicken${account.manualUntil ? ` · nur von Hand bis ${date(account.manualUntil)}` : ''}.`
            : `Noch ${left} offen.`}
        {queued > 0 && account.nextQueuedAt ? ` ${queued} eingeplant, nächste um ${clock(account.nextQueuedAt)} Uhr.` : ''}
      </p>
    </div>
  );
}
