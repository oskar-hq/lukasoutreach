import { ArrowUpRight, UserPlus } from 'lucide-react';
import { useIsPresent } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { INVITE_NOTE_MAX_LENGTH } from '../../../shared/linkedin';
import { cn } from '../../lib/cn';
import { confidencePercent, leadFit, linkedinProfileUrl } from '../../lib/leadView';
import { variablesForCockpitLead } from '../../lib/template';
import { useHotkeys } from '../../lib/useHotkeys';
import { FOUNDERS } from '../../data/founders';
import { useDemo } from '../../state/demo';
import { Button } from '../ui/Button';
import { ACTION_TEXTS, useSendState } from './actionMode';
import { AccountHint, FocusPage, PersonHeader, Placeholder, StatusSentence, StepRail } from './FocusParts';
import type { CardProps } from './cardTypes';
import { MessageEditor, focusAtEnd } from './MessageEditor';
import { useSwipeActions } from './swipe';
import { useTaskCard } from './useTaskCard';

/**
 * Satz zur Sperre – nach dem, was der Server wirklich zählt (je Account, 25.10.): alle Accounts voll, der eigene voll,
 * oder der eigene hat Platz, darf aber gerade nicht (nicht verbunden, pausiert, 7-Tage-Limit).
 */
function inviteLimitText(
  byAccount: Partial<Record<string, number>> | undefined,
  perDay: Partial<Record<string, number>> | undefined,
  own: number,
  limit: number | null,
  via: string | null | undefined,
): string {
  const accounts = perDay ? Object.keys(perDay) : [];
  const allFull = accounts.length > 1 && accounts.every((id) => (byAccount?.[id] ?? 0) >= (perDay?.[id] ?? Infinity));
  if (allFull || (via === null && !perDay && (limit === null || own < limit))) {
    return 'Tageslimit erreicht: beide LinkedIn-Accounts haben heute alle Vernetzungsanfragen verbraucht – weitere sind bis morgen gesperrt, damit die Accounts sicher bleiben.';
  }
  if (limit !== null && own >= limit) {
    return `Tageslimit erreicht: heute schon ${own} von ${limit} Vernetzungsanfragen über diesen LinkedIn-Account – weitere sind bis morgen gesperrt, damit der Account sicher bleibt.`;
  }
  return 'Gerade gesperrt: Über keinen verbundenen LinkedIn-Account darf heute noch eine Vernetzungsanfrage raus (Limit in 7 Tagen oder Account nicht verbunden) – das schützt die Accounts.';
}

const QUIET_LINK = 'text-[14px] text-ink-3 underline-offset-4 transition-colors hover:text-ink hover:underline';

/**
 * Vernetzen: eine Entscheidung in einer Sekunde (Wunsch des Nutzers 07.10.: minimalistisch). Name, Firma und ein
 * Satz, warum der Lead passt – Notiz, Profil und Begründung sind leise Links darunter.
 */
export function LeadCard({ card, onDecide, onOpenLead, hotkeysEnabled }: CardProps) {
  const { task, lead, signal, signalReady, draft } = useTaskCard(card);
  const { state } = useDemo();
  // Notiz ausschaltbar (Einstellungen → Tagesstapel → „Notiz zur Vernetzungsanfrage“, 11.10.).
  const noteAllowed = state.stack.rules?.inviteNote !== false;
  // Sperre (11.10.): Tageslimit für Vernetzungsanfragen erreicht – der Server lehnt weitere ohnehin ab (429).
  // Gezählt wird je LinkedIn-Account, nicht je Lead-Besitzer (25.10., „27 von 20“): Anfragen für Leads eines Gründers,
  // die über den Account des anderen gingen, belasten dessen Limit. `inviteViaByOwner` gilt auch unter „Alle“.
  const byOwner = state.stack.inviteViaByOwner;
  const via = byOwner && lead.owner in byOwner ? byOwner[lead.owner] : state.stack.inviteVia;
  const inviteLimit = state.stack.invitesPerDayByAccount?.[lead.owner] ?? state.stack.rules?.invitesPerDay ?? null;
  const invitesToday = state.stack.invitesByAccount ? (state.stack.invitesByAccount[lead.owner] ?? 0) : (state.stack.invitesToday?.[lead.owner] ?? 0);
  const limitReached = via !== undefined ? via === null : inviteLimit !== null && invitesToday >= inviteLimit;
  const limitText = inviteLimitText(state.stack.invitesByAccount, state.stack.invitesPerDayByAccount, invitesToday, inviteLimit, via);
  const present = useIsPresent();
  const send = useSendState(lead.owner);
  const mode = send.mode;
  const texts = ACTION_TEXTS.connect[mode];
  const fit = leadFit(lead);
  const confidence = lead.origin.kind === 'search' ? confidencePercent(lead) : null;
  const profile = linkedinProfileUrl(lead);
  const reason = lead.assessment?.reason || lead.assessment?.summary || null;
  const [reasonOpen, setReasonOpen] = useState(false);
  // Optionale Notiz zur Vernetzungsanfrage (Wunsch des Nutzers 07.10.): Nachrichten gehen erst nach dem Annehmen,
  // eine kurze Notiz (max. 300 Zeichen) kann aber schon mit der Anfrage mit.
  const [note, setNote] = useState(draft?.text ?? '');
  const [noteOpenState, setNoteOpen] = useState(!!draft?.text);
  const noteOpen = noteAllowed && noteOpenState;
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const variables = useMemo(() => variablesForCockpitLead(lead), [lead]);
  const noteText = note.trim();
  const noteTooLong = noteText.length > INVITE_NOTE_MAX_LENGTH;
  const noteHasPlaceholder = /\{\{\w+\}\}/.test(noteText);
  const noteBlocked = noteOpen && (noteTooLong || noteHasPlaceholder);

  const connect = () => {
    if (limitReached) return;
    if (noteBlocked) {
      focusAtEnd(noteRef.current);
      return;
    }
    onDecide({
      decision: 'connect',
      positive: true,
      action: noteOpen && noteText ? { action: 'invite_sent', text: noteText } : { action: 'invite_sent' },
      toast: { pending: texts.pending, done: texts.done, short: texts.toastShort },
    });
  };

  const openNote = () => {
    setNoteOpen(true);
    window.requestAnimationFrame(() => focusAtEnd(noteRef.current));
  };

  const reject = () =>
    onDecide({
      decision: 'reject',
      positive: false,
      action: {
        action: 'lost',
        text: fit?.good ? 'Nicht geeignet – entgegen der KI-Einschätzung aussortiert.' : 'Nicht geeignet – KI-Einschätzung bestätigt.',
      },
      toast: { pending: 'Wird aussortiert', done: 'Aussortiert' },
    });

  useHotkeys({ enter: connect, arrowright: connect, arrowleft: reject }, hotkeysEnabled && present);
  useSwipeActions({ right: { label: texts.swipe, run: connect }, left: { label: 'Nicht geeignet', run: reject } });

  // Ein Satz statt KI-Blöcken: Einschätzung (mit Sicherheit) und Signal.
  const sentence = [fit && `${fit.label}${confidence ? ` · ${confidence}` : ''}`, signal?.label].filter(Boolean).join(' · ');

  return (
    <FocusPage
      actions={
        <>
          <Button variant="outline" size="xl" shortcut="←" shortcutPosition="start" onClick={reject} className="w-full">
            Nicht geeignet
          </Button>
          <Button variant="primary" size="xl" shortcut="↵" onClick={connect} disabled={noteBlocked || limitReached} icon={<UserPlus className="h-4 w-4" />} className="w-full">
            <span className="sm:hidden">{texts.short}</span>
            <span className="hidden sm:inline">{texts.button}</span>
          </Button>
        </>
      }
    >
      <StepRail step="lead" extra={lead.origin.kind === 'search' ? 'Neuer Lead · aus der Lead-Suche' : 'Neuer Lead'} />
      <div className="mt-6 sm:mt-10">
        <PersonHeader lead={lead} onOpen={() => onOpenLead(lead.id)} />
      </div>

      {!signalReady && !fit ? (
        <Placeholder className="mx-auto mt-5 h-5 w-64" />
      ) : sentence ? (
        <StatusSentence tone={fit ? (fit.good ? 'good' : 'warn') : 'neutral'} testId="lead-sentence">
          {sentence}
        </StatusSentence>
      ) : null}

      {reasonOpen && reason && (
        <p className="mx-auto mt-3 max-w-[480px] text-center text-[14px] leading-[1.6] text-ink-2" data-testid="ai-assessment">
          {reason}
        </p>
      )}

      {limitReached && (
        <p role="status" className="mx-auto mt-4 max-w-[480px] text-center text-[13.5px] font-medium leading-[1.55] text-warn" data-testid="invite-limit-reached">
          {limitText}
        </p>
      )}
      {!limitReached && <AccountHint kind="invite" account={via} owner={lead.owner} />}
      {task.adoptedFrom && (
        // Account des Besitzers nicht verbunden (17.10.): Lead übernommen, mit der Anfrage gehört er dir.
        <p className="mx-auto mt-4 max-w-[480px] text-center text-[13px] leading-[1.55] text-ink-3" data-testid="adopted-from">
          Übernommen von {FOUNDERS[task.adoptedFrom].name} – dessen LinkedIn-Account ist gerade nicht verbunden. Mit der Anfrage gehört der Lead dir.
        </p>
      )}

      {mode === 'protocol' && (
        // Ohne „Echt über LinkedIn senden“ geht nichts raus – sonst wundert man sich, dass auf LinkedIn nichts ankommt.
        <p className="mx-auto mt-4 max-w-[480px] text-center text-[13px] leading-[1.55] text-ink-3" data-testid="protocol-note">
          {send.reason === 'account' && send.owner
            ? `Der LinkedIn-Account von ${FOUNDERS[send.owner].name} ist nicht mit dem Cockpit verbunden: Schick die Anfrage auf LinkedIn und trag sie hier ein.`
            : send.reason === 'off'
              ? 'Das Cockpit sendet nicht selbst: Schick die Anfrage auf LinkedIn und trag sie hier ein. Echt senden lässt sich unter Einstellungen → Senden über LinkedIn einschalten.'
              : 'Das Cockpit sendet nicht selbst: Schick die Anfrage auf LinkedIn und trag sie hier ein.'}
        </p>
      )}

      {noteOpen ? (
        <div className="mx-auto mt-8 w-full max-w-[560px]" data-testid="invite-note">
          <MessageEditor
            ref={noteRef}
            value={note}
            onChange={setNote}
            variables={variables}
            label="Notiz zur Anfrage"
            placeholder={`Kurze Notiz an ${lead.person.firstName} (optional) …`}
            onSubmit={connect}
            submitVerb={mode === 'send' ? 'vernetzen' : 'eintragen'}
            copyable={mode === 'protocol'}
            copyDisabled={!noteText || noteHasPlaceholder}
            describedBy="invite-note-hint"
          />
          <div className="mt-2 flex items-baseline justify-between gap-3 px-1 text-[12.5px]">
            <p id="invite-note-hint" className="text-ink-3">
              {noteHasPlaceholder
                ? 'Platzhalter wie {{…}} noch ersetzen.'
                : mode === 'send'
                  ? 'Geht mit der Vernetzungsanfrage raus.'
                  : 'Auf LinkedIn mit der Anfrage einfügen.'}
            </p>
            <span className={cn('shrink-0 tabular-nums', noteTooLong ? 'text-bad' : 'text-ink-3')} data-testid="invite-note-count">
              {noteText.length} / {INVITE_NOTE_MAX_LENGTH}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setNote('');
              setNoteOpen(false);
            }}
            className="mt-1 px-1 text-[12.5px] text-ink-3 hover:text-ink"
          >
            Ohne Notiz
          </button>
        </div>
      ) : null}

      <div className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2">
        {noteAllowed && !noteOpen && (
          <button type="button" onClick={openNote} className={QUIET_LINK} data-testid="invite-note-open">
            Notiz hinzufügen
          </button>
        )}
        {profile && (
          <a href={profile} target="_blank" rel="noopener noreferrer" className={cn(QUIET_LINK, 'inline-flex items-center gap-0.5')}>
            Profil öffnen
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        )}
        {reason && (
          <button type="button" onClick={() => setReasonOpen((open) => !open)} aria-expanded={reasonOpen} className={QUIET_LINK} data-testid="reason-toggle">
            {reasonOpen ? 'Begründung ausblenden' : fit?.good === false ? 'Warum nicht?' : 'Warum passt das?'}
          </button>
        )}
      </div>
    </FocusPage>
  );
}
