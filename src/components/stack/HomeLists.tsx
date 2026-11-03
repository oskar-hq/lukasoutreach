import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CockpitLead, LeadAction } from '../../../shared/leads';
import type { AttentionItem } from '../../../shared/tasks';
import { ApiError, leadsApi } from '../../lib/leadSearchApi';
import { leadCompany, leadName, readableError } from '../../lib/leadView';
import { formatRelative } from '../../lib/time';
import { useCockpit } from '../../state/cockpit';
import { useDemo } from '../../state/demo';
import type { FounderId } from '../../state/types';
import { Button } from '../ui/Button';
import { DisclosureToggle } from '../ui/Disclosure';

/** So viele offene Anfragen zeigt die Startseite auf einmal (älteste zuerst). */
const INVITES_LIMIT = 50;

type Section = 'attention' | 'invites';

interface RowAction {
  label: string;
  /** Aktion am Lead – fehlt: öffnet das Lead-Panel (z. B. „Übergeben“). */
  action?: LeadAction;
  /** Wiedervorlage in so vielen Tagen (22.10.): pausiert, dann wieder in den Aufgaben. */
  resumeDays?: number;
  testId: string;
}

const lostAction: RowAction = { label: 'Verloren', action: 'lost', testId: 'row-lost' };
/** „In 2 Wochen noch einmal“ – auch nach allen Follow-ups (Wunsch des Nutzers 22.10.). */
const resumeAction: RowAction = { label: 'In 2 Wochen wieder', resumeDays: 14, testId: 'row-resume' };

/** Tag in `days` Tagen, 8 Uhr Ortszeit – wie die Schnellwahl im Lead-Panel. */
function resumeAt(days: number): number {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(8, 0, 0, 0);
  return date.getTime();
}

function attentionActions(item: AttentionItem): RowAction[] {
  switch (item.reason) {
    case 'invite_stale':
      return [lostAction];
    case 'meeting_open':
      return [{ label: 'Übergeben', testId: 'row-handover' }];
    case 'followups_done':
    case 'conversation_quiet':
      return [resumeAction, lostAction];
    default:
      return [lostAction];
  }
}

/**
 * Unter dem Hero der Startseite, je einen Klick entfernt: „Braucht Aufmerksamkeit“ (vom Backend, `shared/tasks.ts`)
 * und „Offene Anfragen“. Wer angenommen hat, trägt der LinkedIn-Abgleich ein – von Hand geht das nicht mehr (20.10.).
 */
export function HomeLists({ founder }: { founder: FounderId }) {
  const { state, dispatch } = useDemo();
  const { mutateLead } = useCockpit();
  const attention = state.stack.attention;
  const fetchedAt = state.stack.fetchedAt;
  const [invites, setInvites] = useState<{ leads: CockpitLead[]; total: number } | null>(null);
  const [open, setOpen] = useState<Section | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const listId = useId();

  const loadInvites = useCallback(async () => {
    const id = ++requestId.current;
    try {
      // sort=activity: am längsten ohne Aktivität zuerst – bei Anfragen ist das die älteste.
      const response = await leadsApi.list({ owner: founder, stage: ['invited'], sort: 'activity', limit: INVITES_LIMIT });
      if (id === requestId.current) setInvites(response);
    } catch {
      // Nur eine Abkürzung – ohne Verbindung bleibt der alte Stand stehen.
    }
  }, [founder]);

  // Neu laden, wenn der Tagesstapel neu kam (nach jeder Änderung am Lead und alle 60 s).
  useEffect(() => {
    void loadInvites();
  }, [loadInvites, fetchedAt]);

  const openPanel = (leadId: string) => dispatch({ type: 'OPEN_PANEL', leadId });

  const run = async (lead: CockpitLead, entry: RowAction) => {
    if (!entry.action && !entry.resumeDays) return openPanel(lead.id);
    if (busy) return;
    if (entry.action === 'lost' && !window.confirm(`${leadName(lead)} als verloren markieren? Im Lead-Panel kannst du ihn wieder öffnen.`)) return;
    setBusy(lead.id);
    setError(null);
    try {
      await mutateLead(
        () => (entry.resumeDays ? leadsApi.update(lead.id, { followUpPlan: { at: resumeAt(entry.resumeDays) } }) : leadsApi.act(lead.id, { action: entry.action! })),
        lead.id,
      );
      // Sofort aus der Liste – der Tagesstapel lädt ohnehin nach (z. B. mit der neuen Erstnachricht).
      setInvites((current) => current && { leads: current.leads.filter((other) => other.id !== lead.id), total: current.total - 1 });
    } catch (failure) {
      setError(failure instanceof ApiError ? readableError(failure, 'Das hat nicht geklappt.') : 'Keine Verbindung – nichts gespeichert.');
    } finally {
      setBusy(null);
    }
  };

  const inviteCount = invites?.total ?? 0;
  if (attention.length === 0 && inviteCount === 0) return null;
  const shown: Section | null = open === 'attention' && attention.length ? 'attention' : open === 'invites' && inviteCount ? 'invites' : null;
  const toggle = (section: Section) => setOpen((current) => (current === section ? null : section));

  const row = (lead: CockpitLead, detail: string, actions: RowAction[], testId: string) => (
    <li key={lead.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5" data-testid={testId}>
      {/* Schmal (Handy): Knöpfe rutschen unter den Namen, statt ihn auf wenige Buchstaben zu kürzen. */}
      <button type="button" onClick={() => openPanel(lead.id)} className="min-w-[12rem] flex-1 text-left">
        <span className="block truncate text-[14.5px] text-ink hover:underline">{leadName(lead)}</span>
        <span className="block truncate text-[13px] text-ink-3">{detail}</span>
      </button>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {actions.map((entry) => (
          <Button
            key={entry.label}
            size="sm"
            variant={entry.action === 'lost' ? 'ghost' : 'secondary'}
            disabled={busy !== null}
            aria-busy={busy === lead.id}
            onClick={() => void run(lead, entry)}
            data-testid={entry.testId}
          >
            {entry.label}
          </Button>
        ))}
      </span>
    </li>
  );

  return (
    // Breite fest an den Bildschirm gebunden – die Startseite zentriert ohne eigene Breite.
    <div className="mt-8 w-[min(560px,calc(100vw-2.5rem))] [@media(max-height:920px)]:mt-5" data-testid="home-lists">
      <div className="flex flex-wrap justify-center gap-1">
        {attention.length > 0 && (
          <DisclosureToggle open={shown === 'attention'} onToggle={() => toggle('attention')} controls={shown === 'attention' ? listId : undefined} testId="attention-toggle">
            Braucht Aufmerksamkeit · <span className="tabular-nums">{attention.length}</span>
          </DisclosureToggle>
        )}
        {inviteCount > 0 && (
          <DisclosureToggle open={shown === 'invites'} onToggle={() => toggle('invites')} controls={shown === 'invites' ? listId : undefined} testId="invites-toggle">
            Offene Anfragen · <span className="tabular-nums">{inviteCount}</span>
          </DisclosureToggle>
        )}
      </div>

      {shown === 'attention' && (
        <ul id={listId} className="mt-3 text-left" aria-label="Braucht Aufmerksamkeit" data-testid="attention-list">
          {attention.map((item) => row(item.lead, item.detail, attentionActions(item), `attention-${item.reason}`))}
        </ul>
      )}

      {shown === 'invites' && invites && (
        <>
          <ul id={listId} className="mt-3 text-left" aria-label="Offene Anfragen" data-testid="invites-list">
            {invites.leads.map((lead) =>
              row(lead, `${leadCompany(lead)} · Anfrage ${formatRelative(lead.lastContactAt ?? lead.lastActivityAt)}`, [lostAction], 'invite-row'),
            )}
          </ul>
          {invites.total > invites.leads.length && (
            <p className="mt-2 text-[12.5px] text-ink-3">Die ältesten {invites.leads.length} von {invites.total} – die übrigen im Board unter „Anfrage gesendet“.</p>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="mt-3 flex items-baseline justify-center gap-2 text-[12.5px] text-ink">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}
