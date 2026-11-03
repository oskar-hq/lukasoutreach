import { useEffect, useState } from 'react';
import type { CockpitLead } from '../../../shared/leads';
import { FOUNDERS } from '../../data/founders';
import { ApiError, leadsApi } from '../../lib/leadSearchApi';
import { readableError } from '../../lib/leadView';
import { formatRelative } from '../../lib/time';
import { useCockpit } from '../../state/cockpit';
import { Button } from '../ui/Button';
import { StatusLine } from '../ui/Status';
import { HEADING } from './look';

/**
 * Nur eingetragene Anfragen nachsenden (Wunsch des Nutzers 11.10.): Mit „von Hand“ wurde „Anfrage eintragen“ geklickt,
 * auf LinkedIn ging aber nichts raus. Diese Leads zurück auf „Neu“ – sie kommen wieder als „Neuer Lead“ in den
 * Tagesstapel und gehen (mit „Echt über LinkedIn senden“) wirklich raus, im Rahmen des Tageslimits.
 */
export function UnsentInvites({ sendingOn }: { sendingOn: boolean }) {
  const { refresh } = useCockpit();
  const [leads, setLeads] = useState<CockpitLead[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const load = async () => {
    try {
      const response = await leadsApi.unsentInvites();
      setLeads(response.leads);
      setSelected(new Set(response.leads.map((lead) => lead.id)));
    } catch (error) {
      setMessage({ tone: 'bad', text: error instanceof ApiError ? readableError(error, 'Liste ließ sich nicht laden.') : 'Liste ließ sich nicht laden.' });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const requeue = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await leadsApi.requeueInvites([...selected]);
      const count = result.requeued.length;
      setMessage({
        tone: 'good',
        text: `${count} ${count === 1 ? 'Lead ist' : 'Leads sind'} wieder „Neu“ und ${count === 1 ? 'kommt' : 'kommen'} als „Neuer Lead“ in den Tagesstapel.${result.skipped.length ? ` ${result.skipped.length} übersprungen.` : ''}`,
      });
      refresh();
      await load();
    } catch (error) {
      setMessage({ tone: 'bad', text: error instanceof ApiError ? readableError(error, 'Zurücksetzen hat nicht geklappt.') : 'Zurücksetzen hat nicht geklappt.' });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-labelledby="unsent-invites-title" data-testid="unsent-invites">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="unsent-invites-title" className={HEADING}>
          Nur eingetragene Anfragen nachsenden
        </h3>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load()} data-testid="unsent-invites-reload">
          Neu laden
        </Button>
      </div>
      <p className="mt-1 text-[13px] leading-[1.55] text-ink-3">
        Leads in „Anfrage gesendet“, deren Anfrage nicht über das Cockpit rausging – etwa weil „von Hand“ eingestellt war und
        sie auf LinkedIn nie gesendet wurde. Zurückgesetzt kommen sie wieder als „Neuer Lead“ in den Tagesstapel.
      </p>
      {!sendingOn && (
        <StatusLine tone="warn" className="mt-3 text-[13px]" testId="unsent-invites-off">
          Erst oben „Echt über LinkedIn senden“ einschalten – sonst wird beim nächsten Mal wieder nur eingetragen.
        </StatusLine>
      )}
      {message && (
        <StatusLine tone={message.tone} role={message.tone === 'bad' ? 'alert' : 'status'} className="mt-3 text-[13px]" testId="unsent-invites-message">
          {message.text}
        </StatusLine>
      )}
      {leads === null ? null : leads.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-ink-2" data-testid="unsent-invites-empty">
          Keine – alle offenen Anfragen sind über das Cockpit gesendet.
        </p>
      ) : (
        <>
          <ul className="mt-4 max-h-[320px] space-y-0.5 overflow-y-auto" data-testid="unsent-invites-list">
            {leads.map((lead) => (
              <li key={lead.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-3">
                  <input
                    type="checkbox"
                    checked={selected.has(lead.id)}
                    onChange={() => toggle(lead.id)}
                    className="h-4 w-4 accent-[var(--color-accent,#2997ff)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">
                      {lead.person.firstName} {lead.person.lastName}
                    </span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {lead.company.name} · {FOUNDERS[lead.owner].name} · eingetragen {formatRelative(lead.lastContactAt ?? lead.lastActivityAt)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" size="sm" disabled={busy || selected.size === 0} onClick={() => void requeue()} data-testid="unsent-invites-requeue">
              {busy ? 'Wird zurückgesetzt …' : `${selected.size} zurück in den Tagesstapel`}
            </Button>
            <span className="text-[12.5px] text-ink-3">Das Tageslimit für Anfragen gilt weiter.</span>
          </div>
        </>
      )}
    </section>
  );
}
