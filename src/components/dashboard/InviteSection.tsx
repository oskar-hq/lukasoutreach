import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthFounderId } from '../../../shared/auth';
import type {
  LinkedInAuditFounder,
  LinkedInAuditLead,
  LinkedInAuditStatus,
  LinkedInInviteStatsResponse,
  LinkedInInviteTotals,
  LinkedInManualInvite,
  LinkedInNewContact,
} from '../../../shared/linkedin';
import { FOUNDERS } from '../../data/founders';
import { formatInt } from '../../lib/format';
import { ApiError, leadsApi, linkedinApi } from '../../lib/leadSearchApi';
import { formatRelative } from '../../lib/time';
import { safeHref } from '../../lib/safeHref';
import { useCockpit } from '../../state/cockpit';
import { Button } from '../ui/Button';
import { SectionLabel } from '../ui/SectionLabel';
import { StatusLine } from '../ui/Status';
import { ChartCard } from './ChartParts';

const pct = (value: number | null) => (value === null ? '–' : `${Math.round(value * 100)} %`);
const name = (founder: AuthFounderId) => FOUNDERS[founder]?.name ?? founder;
const shortDay = (date: string) => {
  const [, m, d] = date.split('-');
  return `${d}.${m}.`;
};

/**
 * Dashboard → Vernetzen (Teammeeting 05.11., `shared/linkedin.ts` → Anfragen von Hand …): Anfragen je Tag (über das
 * Cockpit / von Hand auf LinkedIn) und Annahmequote je Gründer für den Vergleich nach der Testwoche, die Überprüfung
 * „wurde etwas übersehen?“ und neue Kontakte, die das Cockpit von selbst übernommen oder aussortiert hat.
 */
export function InviteSection() {
  // Nach jeder fertigen Überprüfung Statistik und neue Kontakte neu laden (sie kann beides ändern).
  const [version, setVersion] = useState(0);
  return (
    <div className="space-y-10" data-testid="invite-section">
      <InviteStats key={`stats-${version}`} />
      <AuditCard onFinished={() => setVersion((value) => value + 1)} />
      <NewContacts key={`contacts-${version}`} />
    </div>
  );
}

function InviteStats() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<LinkedInInviteStatsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    linkedinApi
      .inviteStats(days)
      .then((next) => alive && (setData(next), setFailed(false)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [days]);

  return (
    <section aria-labelledby="invite-stats-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionLabel id="invite-stats-title">Vernetzungsanfragen · letzte {days} Tage</SectionLabel>
        <div className="flex gap-1">
          {[7, 14, 30].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setDays(value)}
              aria-pressed={days === value}
              className={`rounded-full px-2.5 py-1 text-[12.5px] ${days === value ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
            >
              {value} Tage
            </button>
          ))}
        </div>
      </div>
      {failed && !data && <p className="text-[13.5px] text-ink-3">Die Statistik ließ sich gerade nicht laden.</p>}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.founders.map((founder) => (
            <ChartCard key={founder.founder} title={name(founder.founder)}>
              <p className="mb-4 text-[12.5px] text-ink-3">
                Quote = Anteil der gesendeten Anfragen, die bis heute angenommen wurden.
              </p>
              <div className="mb-5">
                <Totals title={`Letzte ${days} Tage`} totals={founder} testId={`invite-stats-${founder.founder}`} rateTestId={`invite-rate-${founder.founder}`} />
              </div>
              <ManualInvites founder={founder.founder} days={days} count={founder.sentManual} />
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[280px] text-[12.5px] tabular-nums">
                  <thead>
                    <tr className="text-left text-ink-3">
                      <th className="px-1 pb-1.5 font-normal">Tag</th>
                      <th className="px-1 pb-1.5 text-right font-normal">Cockpit</th>
                      <th className="px-1 pb-1.5 text-right font-normal">Von Hand</th>
                      <th className="px-1 pb-1.5 text-right font-normal" title="Von den an diesem Tag gesendeten Anfragen bis heute angenommen">
                        Angenommen
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...founder.days].reverse().map((day) => (
                      <tr key={day.date} className="border-t border-white/5 text-ink-2">
                        <td className="px-1 py-1">{shortDay(day.date)}</td>
                        <td className="px-1 py-1 text-right">{day.sentCockpit || '·'}</td>
                        <td className="px-1 py-1 text-right">{day.sentManual || '·'}</td>
                        <td className="px-1 py-1 text-right" data-testid="invite-day-accepted-of-day">{(day.acceptedOfDay ?? 0) || '·'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[12px] text-ink-3" data-testid="invite-stats-note">
                „Angenommen“ zählt je Tag, wie viele der an dem Tag gesendeten Anfragen bis heute angenommen wurden – frische
                Anfragen brauchen oft ein paar Tage.
              </p>
              {founder.lifetime && (
                <div className="mt-5 border-t border-white/5 pt-4">
                  <Totals title="Seit Beginn (alle Anfragen über den Account)" totals={founder.lifetime} testId={`invite-lifetime-${founder.founder}`} />
                </div>
              )}
            </ChartCard>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Knopf „Von Hand angefragt“ (06.11.): klappt die Liste der von Hand auf LinkedIn angefragten Personen auf – wer hat
 * angenommen (mit Datum), wer ist noch offen. Lädt erst beim Aufklappen.
 */
function ManualInvites({ founder, days, count }: { founder: AuthFounderId; days: number; count: number }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<LinkedInManualInvite[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFailed(false);
    linkedinApi
      .manualInvites(days)
      .then((response) => alive && setList(response.invites.filter((invite) => invite.founder === founder)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, days, founder]);
  if (!count) return null;
  const accepted = list?.filter((invite) => invite.acceptedAt !== null) ?? [];
  const waiting = list?.filter((invite) => invite.acceptedAt === null) ?? [];
  const day = (at: number) => new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return (
    <div className="mb-5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[13px] text-ink-2 transition-colors hover:border-white/25 hover:text-ink"
        data-testid={`manual-invites-toggle-${founder}`}
      >
        {open ? 'Von Hand angefragt ausblenden' : `Von Hand angefragt (${formatInt(count)}) – wer hat angenommen?`}
      </button>
      {open && (
        <div className="mt-3 text-[13px]" data-testid={`manual-invites-${founder}`}>
          {failed && <p className="text-ink-3">Die Liste ließ sich gerade nicht laden.</p>}
          {!list && !failed && <p className="text-ink-3">Lädt …</p>}
          {list && (
            <>
              <p className="mb-1 text-[12.5px] text-ink-3">
                Angenommen ({accepted.length}) · offen ({waiting.length})
              </p>
              <ul className="divide-y divide-white/5">
                {[...accepted, ...waiting].map((invite, index) => (
                  <li key={`${invite.sentAt}-${index}`} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5" data-testid="manual-invite">
                    <span className="min-w-0 text-ink-2">
                      {invite.profileUrl && safeHref(invite.profileUrl) ? (
                        <a href={safeHref(invite.profileUrl)!} target="_blank" rel="noreferrer" className="underline-offset-4 hover:text-ink hover:underline">
                          {invite.name}
                        </a>
                      ) : (
                        invite.name
                      )}
                      {invite.leadId && <span className="text-ink-3"> · im Cockpit</span>}
                    </span>
                    <span className={invite.acceptedAt ? 'text-ink' : 'text-ink-3'}>
                      {invite.acceptedAt ? `angenommen ${day(invite.acceptedAt)}` : `offen seit ${day(invite.sentAt)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Vier Zahlen mit Klartext (Nutzer 07.11.: „man weiß nicht, was welcher Wert sagt“): gesendet, Quote gesamt, Quote von
 * Hand, Quote Cockpit – jeweils mit „x von y“, damit man nachrechnen kann.
 */
function Totals({ title, totals, testId, rateTestId }: { title: string; totals: LinkedInInviteTotals; testId: string; rateTestId?: string }) {
  const sentCockpit = totals.sent - totals.sentManual;
  const acceptedManual = Math.round((totals.rateManual ?? 0) * totals.sentManual);
  const acceptedCockpit = totals.acceptedOfSent - acceptedManual;
  const of = (part: number, whole: number) => `${formatInt(part)} von ${formatInt(whole)} angenommen`;
  return (
    <div data-testid={testId}>
      <p className="mb-2 text-[12.5px] font-medium text-ink-2">{title}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Figure label="Gesendet" value={formatInt(totals.sent)} note={`${formatInt(totals.sentManual)} von Hand · ${formatInt(sentCockpit)} Cockpit`} />
        <Figure label="Quote gesamt" value={pct(totals.rate)} note={of(totals.acceptedOfSent, totals.sent)} testId={rateTestId} />
        <Figure label="Quote von Hand" value={pct(totals.rateManual)} note={totals.sentManual ? of(acceptedManual, totals.sentManual) : 'keine'} />
        <Figure label="Quote Cockpit" value={pct(totals.rateCockpit)} note={sentCockpit ? of(acceptedCockpit, sentCockpit) : 'keine'} />
      </dl>
    </div>
  );
}

function Figure({ label, value, note, testId }: { label: string; value: string; note?: string; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em] tabular-nums" data-testid={testId}>
        {value}
      </dd>
      {note && <dd className="text-[12px] text-ink-3">{note}</dd>}
    </div>
  );
}

function AuditCard({ onFinished }: { onFinished: () => void }) {
  const [state, setState] = useState<LinkedInAuditStatus | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const watching = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const poll = useCallback(() => {
    linkedinApi
      .auditStatus()
      .then((next) => {
        setState(next);
        if (next.running) {
          watching.current = true;
          timer.current = window.setTimeout(poll, 1500);
        } else if (watching.current) {
          watching.current = false;
          finishedRef.current();
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    poll();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [poll]);

  const start = async () => {
    setError(null);
    try {
      setState(await linkedinApi.audit({}));
      watching.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(poll, 800);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Die Überprüfung ließ sich nicht starten.');
    }
  };

  const running = state?.running ?? false;
  const finished = state && !state.running && state.finishedAt;
  return (
    <section aria-labelledby="audit-title">
      <SectionLabel id="audit-title" className="mb-3">
        Überprüfung
      </SectionLabel>
      <ChartCard title="Wurde etwas übersehen?">
        <p className="mb-4 max-w-[640px] text-[13.5px] leading-[1.55] text-ink-2">
          Vergleicht alle neuen Kontakte der letzten 14 Tage auf LinkedIn mit dem Cockpit: angenommene Anfragen, die noch
          auf „Anfrage gesendet“ stehen, Vernetzte ohne Nachricht (der LinkedIn-Chat wird geprüft) und Kontakte, die das
          Cockpit gar nicht kennt. Liest nur – sendet nichts.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="sm" onClick={() => void start()} disabled={running} data-testid="audit-start">
            {running ? 'Läuft …' : finished ? 'Noch einmal prüfen' : 'Überprüfung starten'}
          </Button>
          {running && state && (
            <span className="text-[13px] text-ink-3" role="status">
              Prüft {state.done < state.total ? name(['nick', 'johannes'][state.done] as AuthFounderId) : 'neue Kontakte'} …
            </span>
          )}
          {finished && <span className="text-[13px] text-ink-3">Zuletzt {formatRelative(state.finishedAt!)}</span>}
        </div>
        {error && (
          <StatusLine role="alert" className="mt-3">
            {error}
          </StatusLine>
        )}
        {finished && state.founders.length > 0 && (
          <div className="mt-6 grid gap-6 lg:grid-cols-2" data-testid="audit-result">
            {state.founders.map((founder) => (
              <AuditFounder key={founder.founder} founder={founder} />
            ))}
          </div>
        )}
      </ChartCard>
    </section>
  );
}

function AuditFounder({ founder }: { founder: LinkedInAuditFounder }) {
  const rate = (accepted: number) => (founder.invitesSent ? pct(accepted / founder.invitesSent) : '–');
  return (
    <div className="min-w-0" data-testid={`audit-${founder.founder}`}>
      <h3 className="text-[14px] font-semibold">{name(founder.founder)}</h3>
      {founder.problem ? (
        <p className="mt-1 text-[13px] text-ink-2">{founder.problem}</p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-ink-2">
            {formatInt(founder.connections)} neue Kontakte · {formatInt(founder.ok)} waren richtig im Cockpit
          </p>
          <p className="mt-0.5 text-[13px] text-ink-2" data-testid={`audit-rate-${founder.founder}`}>
            Annahmequote {rate(founder.acceptedBefore)}
            {founder.acceptedAfter !== founder.acceptedBefore && <> → jetzt {rate(founder.acceptedAfter)}</>}
            <span className="text-ink-3"> ({formatInt(founder.invitesSent)} Anfragen)</span>
          </p>
          <AuditList title="Angenommen, stand noch auf „Anfrage gesendet“ – korrigiert" leads={founder.fixedAccepted} testId="audit-fixed" />
          <AuditList title="Nachricht stand nur auf LinkedIn – übernommen" leads={founder.chatImported} testId="audit-chat" />
          <StackableList leads={founder.notMessaged} />
          {founder.unknown.length > 0 && <UnknownContacts contacts={founder.unknown} />}
          {!founder.fixedAccepted.length && !founder.chatImported.length && !founder.notMessaged.length && !founder.unknown.length && (
            <p className="mt-3 text-[13px] text-ink-3">Nichts übersehen.</p>
          )}
        </>
      )}
    </div>
  );
}

type StackState = 'busy' | 'done' | 'failed';

/**
 * Wieder in den Tagesstapel (Wunsch des Nutzers 07.11.): „Für heute überspringen“ und eine geplante Wiedervorlage
 * aufheben, dann steht der vernetzte Lead als Karte „Erstnachricht“ im Stapel. Über die vorhandenen Routen, kein
 * neuer Vertrag.
 */
async function backToStack(leadId: string): Promise<void> {
  await leadsApi.unsnooze(leadId);
  await leadsApi.update(leadId, { followUpPlan: null });
}

function StackButton({ state, onClick, label = 'In den Tagesstapel', testId }: { state: StackState | undefined; onClick: () => void; label?: string; testId: string }) {
  if (state === 'done') return <span className="shrink-0 text-ink">im Tagesstapel</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'busy'}
      className="shrink-0 font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline disabled:opacity-40"
      data-testid={testId}
    >
      {state === 'busy' ? 'Wird eingereiht …' : state === 'failed' ? 'Nochmal versuchen' : label}
    </button>
  );
}

/** „Vernetzt, aber noch keine Nachricht“ – je Lead und für alle auf einmal zurück in den Tagesstapel. */
function StackableList({ leads }: { leads: LinkedInAuditLead[] }) {
  const { refresh } = useCockpit();
  const [states, setStates] = useState<Record<string, StackState>>({});
  const [showAll, setShowAll] = useState(false);
  if (!leads.length) return null;
  const set = (id: string, state: StackState) => setStates((current) => ({ ...current, [id]: state }));
  const one = async (id: string) => {
    set(id, 'busy');
    try {
      await backToStack(id);
      set(id, 'done');
    } catch {
      set(id, 'failed');
    }
  };
  const all = async () => {
    // Nacheinander – wenige Leads, und so bleibt jede Zeile einzeln nachvollziehbar.
    for (const lead of leads) if (states[lead.leadId] !== 'done') await one(lead.leadId);
    refresh();
  };
  const open = leads.filter((lead) => states[lead.leadId] !== 'done').length;
  const visible = showAll ? leads : leads.slice(0, 12);
  return (
    <div className="mt-3" data-testid="audit-not-messaged">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[12.5px] text-ink">Vernetzt, aber noch keine Nachricht – jetzt anschreiben ({leads.length})</p>
        {open > 0 && leads.length > 1 && (
          <button
            type="button"
            onClick={() => void all()}
            disabled={Object.values(states).includes('busy')}
            className="text-[13px] font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline disabled:opacity-40"
            data-testid="audit-stack-all"
          >
            Alle in den Tagesstapel
          </button>
        )}
      </div>
      <ul className="mt-1 space-y-0.5 text-[13px] text-ink-2">
        {visible.map((lead) => (
          <li key={lead.leadId} className="flex items-baseline justify-between gap-3" data-testid="audit-not-messaged-lead">
            <span className="min-w-0 truncate">{lead.name}</span>
            <StackButton
              state={states[lead.leadId]}
              onClick={() => void one(lead.leadId).then(refresh)}
              testId="audit-stack"
            />
          </li>
        ))}
        {leads.length > visible.length && (
          <li>
            <button type="button" onClick={() => setShowAll(true)} className="text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">
              … und {leads.length - visible.length} weitere
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Kontakte ohne Lead: aussortierte bzw. nicht übernommene lassen sich übernehmen – dann stehen sie im Tagesstapel. */
function UnknownContacts({ contacts }: { contacts: LinkedInNewContact[] }) {
  const { refresh } = useCockpit();
  const [states, setStates] = useState<Record<string, StackState>>({});
  const take = async (contact: LinkedInNewContact) => {
    setStates((current) => ({ ...current, [contact.id]: 'busy' }));
    try {
      const result = await linkedinApi.importContact(contact.id);
      setStates((current) => ({ ...current, [contact.id]: result.status === 'imported' ? 'done' : 'failed' }));
      refresh();
    } catch {
      setStates((current) => ({ ...current, [contact.id]: 'failed' }));
    }
  };
  return (
    <div className="mt-3">
      <p className="text-[12.5px] text-ink-3">Kontakte ohne Lead im Cockpit</p>
      <ul className="mt-1 space-y-0.5 text-[13px]">
        {contacts.map((contact) => (
          <li key={contact.id} className="flex items-baseline justify-between gap-3 text-ink-2" data-testid="audit-unknown">
            <span className="min-w-0 truncate">
              {contact.name} · <ContactState contact={contact} />
            </span>
            {(contact.status === 'rejected' || contact.status === 'failed') && (
              <StackButton state={states[contact.id]} onClick={() => void take(contact)} testId="audit-unknown-import" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AuditList({ title, leads, testId, strong }: { title: string; leads: LinkedInAuditLead[]; testId: string; strong?: boolean }) {
  if (!leads.length) return null;
  return (
    <div className="mt-3" data-testid={testId}>
      <p className={`text-[12.5px] ${strong ? 'text-ink' : 'text-ink-3'}`}>
        {title} ({leads.length})
      </p>
      <ul className="mt-1 space-y-0.5 text-[13px] text-ink-2">
        {leads.slice(0, 12).map((lead) => (
          <li key={lead.leadId}>{lead.name}</li>
        ))}
        {leads.length > 12 && <li className="text-ink-3">… und {leads.length - 12} weitere</li>}
      </ul>
    </div>
  );
}

const STATUS_TEXT: Record<LinkedInNewContact['status'], string> = {
  pending: 'wird geprüft',
  imported: 'übernommen',
  rejected: 'aussortiert',
  failed: 'nicht übernommen',
};

function ContactState({ contact }: { contact: LinkedInNewContact }) {
  return <span className={contact.status === 'imported' ? 'text-ink' : 'text-ink-3'}>{STATUS_TEXT[contact.status]}</span>;
}

function NewContacts() {
  const [contacts, setContacts] = useState<LinkedInNewContact[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    linkedinApi
      .newContacts()
      .then((response) => setContacts(response.contacts))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const take = async (contact: LinkedInNewContact) => {
    setBusy(contact.id);
    setError(null);
    try {
      await linkedinApi.importContact(contact.id);
      load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Übernehmen hat nicht geklappt.');
    } finally {
      setBusy(null);
    }
  };

  if (!contacts) return null;
  return (
    <section aria-labelledby="new-contacts-title" data-testid="new-contacts">
      <SectionLabel id="new-contacts-title" className="mb-3">
        Neue Kontakte aus LinkedIn
      </SectionLabel>
      {contacts.length === 0 ? (
        <p className="text-[13.5px] leading-[1.55] text-ink-3">
          Noch keine. Wer eine Anfrage annimmt, die ihr von Hand auf LinkedIn geschickt habt, landet hier – und automatisch als
          Lead im Cockpit, mit Firma und KI-Zusammenfassung.
        </p>
      ) : (
        <ul className="divide-y divide-white/5">
          {contacts.slice(0, 50).map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5" data-testid="new-contact">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-ink">
                  {contact.name}
                  <span className="text-ink-3"> · {name(contact.founder)} · {contact.manualInvite ? 'von Hand angefragt' : 'neuer Kontakt'}</span>
                </p>
                {contact.note && <p className="text-[12.5px] text-ink-3">{contact.note}</p>}
              </div>
              <div className="flex items-center gap-3 text-[13px]">
                <ContactState contact={contact} />
                {(contact.status === 'rejected' || contact.status === 'failed') && (
                  <button
                    type="button"
                    onClick={() => void take(contact)}
                    disabled={busy === contact.id}
                    className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline disabled:opacity-40"
                    data-testid="new-contact-import"
                  >
                    {busy === contact.id ? 'Wird übernommen …' : 'Doch übernehmen'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <StatusLine role="alert" className="mt-3">
          {error}
        </StatusLine>
      )}
    </section>
  );
}
