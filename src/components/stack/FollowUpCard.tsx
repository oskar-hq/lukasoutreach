import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { ChevronDown, Send } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { formatRelative } from '../../lib/time';
import { fillTemplate, variablesForCockpitLead } from '../../lib/template';
import { useHotkeys } from '../../lib/useHotkeys';
import { MESSAGE_TEXT_LIMIT } from '../../state/cockpit';
import { shortTemplateName, useTemplates } from '../../state/templates';
import { templateLetter, templateSegmentOf } from '../../../shared/messages';
import { MoreTemplates, TABBED_TEMPLATES } from './MoreTemplates';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { ACTION_TEXTS, SKIP_TOAST, messageAccount, useActionMode } from './actionMode';
import { ChatThread } from './ChatThread';
import { blockReason, selectFirstPlaceholder, TemplatesUnavailable } from './FirstMessageCard';
import { AccountHint, DetailError, FocusPage, PersonHeader, Placeholder, StatusSentence, StepRail, WriteLabel } from './FocusParts';
import { MessageEditor, focusAtEnd } from './MessageEditor';
import { MessageSkeleton } from './FirstMessageCard';
import type { CardProps } from './cardTypes';
import { SuggestButton, SuggestionNote, useSuggestion } from './Suggestion';
import { useSwipeActions } from './swipe';
import { useTaskCard } from './useTaskCard';
import { LogReply } from './LogReply';

/** Standard von `MAX_FOLLOW_UPS` im Backend – solange `rules` noch nicht geladen sind. */
const MAX_FOLLOW_UPS_DEFAULT = 3;

/** Eigene Nachricht statt Vorlage. */
const CUSTOM = 'custom';

export function FollowUpCard(props: CardProps) {
  const { signalReady } = useTaskCard(props.card);
  const templates = useTemplates();
  // Erst zeigen, wenn Signal und Vorlagen da sind – die Auswahl wird nur einmal angelegt.
  if (!signalReady || templates.state.status === 'loading') return <MessageSkeleton {...props} eyebrow="Follow-up" />;
  return <FollowUpReady {...props} />;
}

function FollowUpReady({ card, onDecide, onOpenLead, hotkeysEnabled }: CardProps) {
  const { lead, task, detail, rules, draft } = useTaskCard(card);
  const present = useIsPresent();
  const mode = useActionMode(messageAccount(lead));
  const texts = ACTION_TEXTS.send[mode];
  const variables = useMemo(() => variablesForCockpitLead(lead), [lead]);
  const stage = task.followUpNumber ?? lead.followUpsSent + 1;
  const maxStage = rules?.maxFollowUps ?? MAX_FOLLOW_UPS_DEFAULT;
  // Vorlagen gibt es für die Stufen 1–3 (`GET /api/templates`, F1A … F3B); ab Stufe 4 die von Stufe 3 (zum Anpassen).
  // Segment (27.10.): eigene Follow-up-Strecke für Finanzdienstleister.
  const templates = useTemplates().followupsFor(stage, templateSegmentOf(lead.assessment?.category));
  const messages = detail.messages;
  const historyReady = detail.status !== 'loading';

  const [variant, setVariant] = useState<string>(() => {
    if (draft) return draft.label && templates.some((template) => template.id === draft.label) ? draft.label : CUSTOM;
    // Aktives Gespräch (25.10.): Follow-up-Vorlagen gehen von „keine Antwort“ aus – hier passt nur ein eigener Text.
    if (task.active) return CUSTOM;
    return templates[0]?.id ?? CUSTOM;
  });
  // Nur bearbeitete Texte je Variante – unbearbeitete folgen dem aktuellen Vorlagentext.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => (draft?.text ? { [variant]: draft.text } : {}));
  // Vorlage, auf der ein Vorschlag beruht – für das Label, solange die eigene Nachricht daraus stammt.
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null);
  // Verlauf gleich offen (Wunsch des Nutzers 20.10.: den Chat beim Follow-up sehen); V klappt ihn zu.
  const [historyOpen, setHistoryOpen] = useState(true);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const template = templates.find((entry) => entry.id === variant) ?? null;
  const key = template ? template.id : CUSTOM;
  const original = useMemo(() => (template ? fillTemplate(template.text, variables) : ''), [template, variables]);
  const text = drafts[key] ?? original;
  const blocked = blockReason(text);
  const hintId = `${card.id}-send-hint`;

  // Vorschlag landet als „Eigene Nachricht“ – die Varianten bleiben unverändert wählbar.
  const applySuggestion = useCallback((next: string, templateId: string | null) => {
    setDrafts((current) => ({ ...current, [CUSTOM]: next }));
    setSuggestedFrom(templateId);
    setVariant(CUSTOM);
  }, []);
  const suggestion = useSuggestion(lead.id, 'followup', applySuggestion);

  // Selbst schreiben: leeres Feld als „Eigene Nachricht“, Cursor hinein.
  const writeOwn = () => {
    setDrafts((current) => ({ ...current, [CUSTOM]: '' }));
    setSuggestedFrom(null);
    setVariant(CUSTOM);
    requestAnimationFrame(() => focusAtEnd(editorRef.current));
  };
  const lastOwn = [...messages].reverse().find((message) => message.from === 'founder') ?? null;

  const choose = (next: string) => {
    setVariant(next);
    if (next === CUSTOM) requestAnimationFrame(() => focusAtEnd(editorRef.current));
  };

  const send = () => {
    if (blocked) {
      if (text.trim()) selectFirstPlaceholder(editorRef.current);
      else focusAtEnd(editorRef.current);
      return;
    }
    onDecide({
      decision: 'send',
      positive: true,
      action: { action: 'message_sent', text, ...(template ? { label: template.id } : suggestedFrom ? { label: suggestedFrom } : {}) },
      toast: {
        pending: `Follow-up ${stage} ${texts.pending}`,
        done: texts.done,
        short: texts.toastShort,
      },
    });
  };

  const skip = () => onDecide({ decision: 'skip', positive: false, action: null, toast: SKIP_TOAST });

  useHotkeys(
    {
      enter: send,
      arrowright: send,
      arrowleft: skip,
      e: () => focusAtEnd(editorRef.current),
      ...Object.fromEntries(templates.slice(0, TABBED_TEMPLATES).map((entry, index) => [String(index + 1), () => choose(entry.id)])),
      [String(Math.min(templates.length, TABBED_TEMPLATES) + 1)]: () => choose(CUSTOM),
      k: () => void suggestion.run(),
      v: () => setHistoryOpen((open) => !open),
    },
    hotkeysEnabled && present,
  );
  useSwipeActions({
    right: { label: `Follow-up ${stage} ${mode === 'send' ? 'senden' : 'eintragen'}`, run: send, enabled: !blocked },
    left: { label: 'Nicht senden', run: skip },
  });

  return (
    <FocusPage
      actions={
        <>
          <Button variant="outline" size="xl" shortcut="←" shortcutPosition="start" onClick={skip} className="w-full">
            Nicht senden
          </Button>
          <Button
            variant="primary"
            size="xl"
            shortcut="↵"
            onClick={send}
            disabled={!!blocked}
            aria-describedby={blocked ? hintId : undefined}
            icon={<Send className="h-4 w-4" />}
            className="w-full"
          >
            <span className="sm:hidden">{texts.short}</span>
            <span className="hidden sm:inline">{texts.button}</span>
          </Button>
        </>
      }
    >
      <StepRail step="followup" extra={task.active ? 'Aktives Gespräch · nachfassen' : task.resumed ? `Wiedervorlage · Follow-up ${stage}` : `Follow-up ${stage} von ${Math.max(maxStage, stage)}`} />
      <div className="mt-6">
        <PersonHeader lead={lead} compact profileLink={mode === 'protocol'} onOpen={() => onOpenLead(lead.id)} />
        <AccountHint kind="message" account={lead.linkedin?.sentBy} owner={lead.owner} />
      </div>
      <StatusSentence tone="warn" testId="task-sentence">
        {task.active ? `${lead.person.firstName} hat schon geantwortet – seitdem ruhig` : 'Noch keine Antwort'}
        {lastOwn ? ` – deine letzte Nachricht ${formatRelative(lastOwn.at)}` : ''}
      </StatusSentence>

      <div className="mt-6 flex flex-col items-center">
        {detail.status === 'error' ? (
          <DetailError leadId={lead.id} />
        ) : historyReady ? (
          <Button variant="ghost" size="sm" shortcut="V" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            Verlauf ({messages.length})
            <ChevronDown className={cn('h-4 w-4 transition-transform duration-300', historyOpen && 'rotate-180')} />
          </Button>
        ) : (
          <Placeholder className="h-8 w-48" />
        )}
      </div>
      <AnimatePresence initial={false}>
        {historyOpen && historyReady && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
            className="overflow-hidden"
          >
            <div className="scroll-thin mt-4 max-h-[320px] touch-pan-y overflow-y-auto">
              <ChatThread lead={lead} messages={messages} compact />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-4 flex flex-col items-center">
        {templates.length === 0 && (
          <div className="mb-3">
            <TemplatesUnavailable />
          </div>
        )}
        <Segmented
          ariaLabel="Follow-up-Variante"
          value={template ? template.id : CUSTOM}
          onChange={choose}
          options={[
            ...templates.slice(0, TABBED_TEMPLATES).map((entry, index) => ({
              value: entry.id,
              label: (
                <>
                  <span className="sm:hidden">Variante {templateLetter(index)}</span>
                  <span className="hidden max-w-[170px] truncate align-bottom sm:inline-block">
                    {templateLetter(index)} · {shortTemplateName(entry)}
                  </span>
                </>
              ),
              shortcut: String(index + 1),
            })),
            { value: CUSTOM, label: 'Eigene Nachricht', shortcut: String(Math.min(templates.length, TABBED_TEMPLATES) + 1) },
          ]}
        />
        <MoreTemplates templates={templates} value={template ? template.id : CUSTOM} onChange={choose} className="mt-2" />
        {stage > 3 && template && (
          <p className="mt-2.5 text-[12.5px] text-ink-3" data-testid="template-description">
            Vorlage von Follow-up 3 – bitte anpassen
          </p>
        )}
      </div>

      <div className="mt-6">
        <WriteLabel onClear={text ? writeOwn : undefined} hint={template ? 'Vorschlag – einfach überschreiben' : null}>
          Dein Follow-up an {lead.person.firstName}
        </WriteLabel>
        <MessageEditor
          ref={editorRef}
          value={text}
          onChange={(value) => setDrafts((current) => ({ ...current, [key]: value }))}
          variables={variables}
          onSubmit={send}
          placeholder={`Schreib ${lead.person.firstName} selbst – oder hol dir einen Vorschlag …`}
          limit={MESSAGE_TEXT_LIMIT}
          actions={<SuggestButton state={suggestion.state} onClick={() => void suggestion.run()} />}
          submitVerb={mode === 'send' ? 'senden' : 'eintragen'}
          copyable={mode === 'protocol'}
          copyDisabled={!!blocked}
          describedBy={blocked ? hintId : undefined}
        />
        <SuggestionNote state={suggestion.state} />
        {blocked && text.trim() && (
          <p id={hintId} className="mt-1 flex items-baseline gap-2 px-1 text-[12.5px] text-ink" data-testid="send-blocked">
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
            {blocked}
          </p>
        )}
      </div>
      <LogReply lead={lead} onDecide={onDecide} hotkeysEnabled={hotkeysEnabled && present} />
    </FocusPage>
  );
}
