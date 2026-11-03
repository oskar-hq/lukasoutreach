import { ArrowUpRight, CalendarCheck, ChevronUp, Send } from 'lucide-react';
import { useIsPresent } from 'motion/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CockpitLead } from '../../../shared/leads';
import { replyAssessmentParts } from '../../lib/leadView';
import { variablesForCockpitLead } from '../../lib/template';
import { formatRelative } from '../../lib/time';
import { useHotkeys } from '../../lib/useHotkeys';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { useCrm } from '../../state/crm';
import { replyDrafts } from '../../state/replyDrafts';
import { actionAllowed } from '../lead/LeadActions';
import { ACTION_TEXTS, SKIP_TOAST, exportModeOf, messageAccount, useActionMode } from './actionMode';
import { blockReason } from './FirstMessageCard';
import { MessageEditor, focusAtEnd } from './MessageEditor';
import { ChatThread } from './ChatThread';
import { CloseExportModal } from './CloseExportModal';
import { AccountHint, DetailError, FocusPage, PersonHeader, Placeholder, StatusSentence, StepRail, WriteLabel } from './FocusParts';
import type { CardProps } from './cardTypes';
import { SuggestButton, SuggestionNote, useSuggestion } from './Suggestion';
import { useSwipeActions } from './swipe';
import { useTaskCard } from './useTaskCard';

/** Standardmäßig sichtbar: nur die neue Antwort – der übrige Verlauf ist einen Klick entfernt. */
const VISIBLE_BY_DEFAULT = 1;

export function ReplyCard({ card, onDecide, onOpenLead, hotkeysEnabled }: CardProps) {
  const { lead, task, detail, signal, draft } = useTaskCard(card);
  const present = useIsPresent();
  // Übergabe an Close ausgeschaltet (Einstellung, 22.10.): keine Übergabe – Haupt-Aktion ist dann der Termin bzw. die Antwort.
  const { mode: crmMode, handover } = useCrm();
  const mode = exportModeOf(crmMode);
  const texts = ACTION_TEXTS.export[mode ?? 'protocol'];
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const messages = detail.messages;
  // Entscheiden erst, wenn die Antwort zu sehen ist.
  const loaded = detail.status === 'ready';
  const latestReply = [...messages].reverse().find((message) => message.from === 'lead');
  const fresh = latestReply ? Date.now() - latestReply.at < 10 * 60_000 : false;
  const hiddenCount = Math.max(0, messages.length - VISIBLE_BY_DEFAULT);
  const visibleMessages = historyOpen ? messages : messages.slice(-VISIBLE_BY_DEFAULT);

  // Direkt antworten (Wunsch des Nutzers 07.10.): selbst schreiben oder den KI-Vorschlag übernehmen und anpassen.
  // Gesendet wird über LinkedIn, wenn das Cockpit sendet – sonst kopieren und als gesendet eintragen.
  const sendMode = useActionMode(messageAccount(lead));
  const sendTexts = ACTION_TEXTS.send[sendMode];
  const variables = useMemo(() => variablesForCockpitLead(lead), [lead]);
  // Angefangene Antwort je Lead: schreibt der Lead inzwischen ein zweites Mal (neue Aufgabe), steht der Text wieder da.
  const [answer, setAnswerState] = useState(() => replyDrafts.get(lead.id) ?? draft?.text ?? '');
  const setAnswer = useCallback(
    (text: string) => {
      setAnswerState(text);
      replyDrafts.set(lead.id, text);
    },
    [lead.id],
  );
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const suggestion = useSuggestion(lead.id, 'reply', (text) => {
    setAnswer(text);
    requestAnimationFrame(() => focusAtEnd(editorRef.current));
  });
  const answerBlocked = blockReason(answer);
  const sendAnswer = () => {
    if (!loaded || answerBlocked) {
      focusAtEnd(editorRef.current);
      return;
    }
    onDecide({
      decision: 'send',
      positive: true,
      action: { action: 'message_sent', text: answer.trim() },
      toast: { pending: `Antwort ${sendTexts.pending}`, done: sendTexts.done, short: sendTexts.toastShort },
    });
  };

  // Selbst schreiben: Feld leeren, Cursor hinein.
  const writeOwn = () => {
    setAnswer('');
    requestAnimationFrame(() => focusAtEnd(editorRef.current));
  };

  const openExport = () => loaded && setExportOpen(true);

  const handOver = useCallback(
    (note: string) => {
      if (!mode) return;
      setExportOpen(false);
      // Close bekommt Verlauf und Einschätzung ohnehin – als Text nur die eigene Notiz. Ohne Close wie bisher der
      // nächste Schritt.
      const text = mode === 'close' ? note : note || lead.nextStep;
      onDecide({
        decision: 'export',
        positive: true,
        action: { action: 'handed_over', ...(text ? { text } : {}) },
        toast: { pending: texts.pending, done: texts.done, short: texts.toastShort },
        viaCrm: mode === 'close',
      });
    },
    [mode, lead.nextStep, onDecide, texts],
  );

  const noInterest = () => {
    if (!loaded) return;
    onDecide({
      decision: 'discard',
      positive: false,
      action: { action: 'lost', text: 'Antwort: kein Interesse' },
      toast: { pending: 'Wird als verloren markiert', done: 'Als verloren markiert', short: { pending: 'Wird markiert', done: 'Verloren' } },
    });
  };

  const skip = () => onDecide({ decision: 'skip', positive: false, action: null, toast: SKIP_TOAST });

  // Termin auf LinkedIn ausgemacht: eintragen, ohne erst das Lead-Panel zu öffnen. (In „Termin“ steht er schon.)
  const canBookMeeting = actionAllowed(lead, 'meeting_booked');
  const bookMeeting = () => {
    if (!loaded || !canBookMeeting) return;
    onDecide({
      decision: 'meeting',
      positive: true,
      action: { action: 'meeting_booked' },
      toast: { pending: 'Termin wird eingetragen', done: 'Termin eingetragen', short: { pending: 'Wird eingetragen', done: 'Termin' } },
    });
  };

  // Ohne Übergabe: Termin eintragen, wenn das geht – sonst die Antwort senden.
  const meetingFirst = !handover && canBookMeeting;
  const primary = handover ? openExport : meetingFirst ? bookMeeting : sendAnswer;

  useHotkeys(
    {
      enter: primary,
      arrowright: primary,
      arrowleft: noInterest,
      s: skip,
      k: () => void suggestion.run(),
      e: () => focusAtEnd(editorRef.current),
      v: () => setHistoryOpen((open) => !open),
      t: bookMeeting,
    },
    hotkeysEnabled && present && !exportOpen,
  );
  useSwipeActions({
    // Übergabe öffnet erst die Vorschau – die Seite bleibt dafür stehen.
    right: handover
      ? {
          label: texts.swipe,
          enabled: loaded,
          run: () => {
            openExport();
            return false;
          },
        }
      : meetingFirst
        ? { label: 'Termin vereinbart', enabled: loaded, run: bookMeeting }
        : { label: sendTexts.swipe, enabled: loaded && !answerBlocked, run: sendAnswer },
    left: { label: 'Kein Interesse', enabled: loaded, run: noInterest },
  });

  return (
    <>
      <FocusPage
        actions={
          <>
            <Button variant="outline" size="xl" shortcut="←" shortcutPosition="start" onClick={noInterest} disabled={!loaded} className="w-full">
              Kein Interesse
            </Button>
            <Button
              variant="primary"
              size="xl"
              shortcut="↵"
              onClick={primary}
              disabled={!loaded || (!handover && !meetingFirst && !!answerBlocked)}
              icon={handover ? <ArrowUpRight className="h-4 w-4" /> : meetingFirst ? <CalendarCheck className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              className="w-full"
              data-testid="reply-primary"
            >
              {handover ? (
                <>
                  <span className="sm:hidden">{texts.short}</span>
                  <span className="hidden sm:inline">{texts.button}</span>
                </>
              ) : meetingFirst ? (
                'Termin vereinbart'
              ) : (
                <>
                  <span className="sm:hidden">{sendTexts.short}</span>
                  <span className="hidden sm:inline">{sendMode === 'send' ? 'Antwort senden' : 'Antwort als gesendet eintragen'}</span>
                </>
              )}
            </Button>
          </>
        }
      >
        <StepRail
          step="reply"
          extra={
            <>
              {fresh && <span className="mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full bg-accent" aria-label="Neu" />}
              Antwort erhalten{latestReply ? ` · ${formatRelative(latestReply.at)}` : ''}
            </>
          }
        />
        <div className="mt-6">
          <PersonHeader lead={lead} compact onOpen={() => onOpenLead(lead.id)} subtitle={lead.nextStep ? `Nächster Schritt: ${lead.nextStep}` : task.reason} />
          <AccountHint kind="message" account={lead.linkedin?.sentBy} owner={lead.owner} />
        </div>

        <div className="mt-8" aria-busy={!loaded}>
          {loaded ? (
            <>
              {hiddenCount > 0 && (
                <div className="mb-5 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setHistoryOpen((open) => !open)}
                    aria-expanded={historyOpen}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                  >
                    <ChevronUp className={historyOpen ? 'h-4 w-4 rotate-180 transition-transform' : 'h-4 w-4 transition-transform'} />
                    {historyOpen ? 'Verlauf ausblenden' : `Ganzen Verlauf anzeigen · ${hiddenCount} frühere ${hiddenCount === 1 ? 'Nachricht' : 'Nachrichten'}`}
                    <Kbd>V</Kbd>
                  </button>
                </div>
              )}
              <ChatThread lead={lead} messages={visibleMessages} highlightLatestReply />
              <ConversationNote lead={lead} />
            </>
          ) : detail.status === 'error' ? (
            <DetailError leadId={lead.id} />
          ) : (
            <Placeholder className="ml-10 h-24 w-[70%] rounded-[20px]" />
          )}
        </div>

        <section className="mx-auto mt-8 w-full max-w-[560px]" aria-label="Antworten" data-testid="reply-answer">
          <WriteLabel
            onClear={answer ? writeOwn : undefined}
            hint={suggestion.state.status === 'done' ? 'Vorschlag – einfach überschreiben' : null}
          >
            Deine Antwort an {lead.person.firstName}
          </WriteLabel>
          <div>
            <MessageEditor
              ref={editorRef}
              value={answer}
              onChange={setAnswer}
              variables={variables}
              onSubmit={sendAnswer}
              label="Deine Antwort"
              placeholder={`Schreib ${lead.person.firstName} selbst – oder hol dir einen Vorschlag …`}
              actions={<SuggestButton state={suggestion.state} onClick={() => void suggestion.run()} />}
              submitVerb={sendMode === 'send' ? 'senden' : 'eintragen'}
              copyable={sendMode === 'protocol'}
              copyDisabled={!!answerBlocked}
            />
            <SuggestionNote state={suggestion.state} />
          </div>
          {/* Ist „Antwort senden“ schon die Haupt-Aktion (Übergabe aus, kein Termin möglich), nicht noch einmal. */}
          {(handover || meetingFirst) && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={sendAnswer}
                disabled={!loaded || !!answerBlocked}
                icon={<Send className="h-3.5 w-3.5" />}
                data-testid="reply-send"
              >
                {sendMode === 'send' ? 'Antwort senden' : 'Antwort als gesendet eintragen'}
              </Button>
            </div>
          )}
        </section>

        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {canBookMeeting && !meetingFirst && (
            <button
              type="button"
              onClick={bookMeeting}
              disabled={!loaded}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40"
              data-testid="reply-meeting"
            >
              <CalendarCheck className="h-3.5 w-3.5" aria-hidden />
              Termin vereinbart
              <Kbd>T</Kbd>
            </button>
          )}
          <button
            type="button"
            onClick={skip}
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-2"
            data-testid="reply-skip"
          >
            Heute überspringen
            <Kbd>S</Kbd>
          </button>
        </div>
      </FocusPage>

      <CloseExportModal
        open={handover && exportOpen && present}
        lead={lead}
        messages={messages}
        signal={signal}
        crmMode={crmMode}
        onClose={() => setExportOpen(false)}
        onConfirm={handOver}
      />
    </>
  );
}

/** Einschätzung der Antwort als ein Satz unter der Nachricht (`lead.conversation`, vom Backend bei jeder Antwort). */
function ConversationNote({ lead }: { lead: CockpitLead }) {
  const conversation = lead.conversation;
  if (!conversation) return null;
  // Älter als die letzte Antwort: das Backend schätzt die neue gerade ein (live per KI, beim nächsten Laden da).
  const outdated = lead.lastReplyAt !== null && conversation.replyAt < lead.lastReplyAt;
  const { label, detail } = replyAssessmentParts(conversation);
  const interested = conversation.replyIntent === 'interested';
  return (
    <section className="mt-4 text-center" data-testid="reply-assessment">
      <StatusSentence tone={interested ? 'good' : conversation.replyIntent === 'not_interested' ? 'warn' : 'neutral'}>
        <span className="font-semibold" data-testid="reply-intent">
          {label}
        </span>
        {detail && <span className="text-ink-2"> · {detail}</span>}
      </StatusSentence>
      {conversation.summary && <p className="mx-auto mt-1.5 max-w-[520px] text-[13.5px] leading-[1.6] text-ink-3">{conversation.summary}</p>}
      {outdated && <p className="mt-1.5 text-[12.5px] text-ink-3">Die neueste Antwort wird gerade eingeschätzt …</p>}
    </section>
  );
}
