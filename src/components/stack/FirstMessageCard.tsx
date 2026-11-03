import { ChevronDown, Send } from 'lucide-react';
import { useIsPresent } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fillTemplate, firstAudiences, unresolvedPlaceholders, variablesForCockpitLead } from '../../lib/template';
import { useHotkeys } from '../../lib/useHotkeys';
import { MESSAGE_TEXT_LIMIT } from '../../state/cockpit';
import { shortTemplateName, useTemplates } from '../../state/templates';
import { templateLetter, templateSegmentOf, type TemplateAudience } from '../../../shared/messages';
import { cn } from '../../lib/cn';
import { metaLibraryUrl } from '../../lib/leadView';
import { safeHref } from '../../lib/safeHref';
import { MoreTemplates, TABBED_TEMPLATES } from './MoreTemplates';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { StatusLine } from '../ui/Status';
import { ACTION_TEXTS, SKIP_TOAST, messageAccount, useActionMode } from './actionMode';
import { AccountHint, FocusPage, PersonHeader, Placeholder, SignalText, StatusSentence, StepRail, WriteLabel } from './FocusParts';
import { MessageEditor, focusAtEnd } from './MessageEditor';
import type { CardProps } from './cardTypes';
import { SuggestButton, SuggestionNote, useSuggestion } from './Suggestion';
import { useSwipeActions } from './swipe';
import { useTaskCard } from './useTaskCard';
import { LogReply } from './LogReply';

/** Warum „Senden“ gesperrt ist – oder null. */
export function blockReason(text: string): string | null {
  if (!text.trim()) return 'Die Nachricht ist leer.';
  if (text.length > MESSAGE_TEXT_LIMIT) return `Höchstens ${MESSAGE_TEXT_LIMIT.toLocaleString('de-DE')} Zeichen.`;
  const open = unresolvedPlaceholders(text);
  if (open.length) return `Ersetze ${open.map((key) => `{{${key}}}`).join(', ')} noch im Text.`;
  return null;
}

/** Ersten offenen Platzhalter markieren – statt stumm nichts zu tun, wenn ↵ gesperrt ist. */
export function selectFirstPlaceholder(field: HTMLTextAreaElement | null) {
  if (!field) return;
  const match = /\{\{\s*\w+\s*\}\}/.exec(field.value);
  field.focus();
  if (match) field.setSelectionRange(match.index, match.index + match[0].length);
  else field.setSelectionRange(field.value.length, field.value.length);
}

type FirstAudience = Exclude<TemplateAudience, 'any'>;

/** Kategorien der Erstnachricht, von Hand wählbar – Namen wie die Standardvorlagen. */
const FIRST_AUDIENCES: FirstAudience[] = ['greenfield', 'reactivation', 'active', 'hiring'];
const FIRST_AUDIENCE_LABELS: Record<FirstAudience, string> = {
  greenfield: 'Meta Ads nie',
  reactivation: 'Meta Ads aus',
  active: 'Schaltet Meta Ads',
  hiring: 'Sucht Mitarbeiter',
};

/** Schlüssel für freien Text ohne Vorlage. */
const FREE = '';

export function FirstMessageCard(props: CardProps) {
  const data = useTaskCard(props.card);
  const templates = useTemplates();
  // Vorlage erst wählen, wenn Signal und Vorlagen da sind – danach nie mehr automatisch umschalten.
  if (!data.signalReady || templates.state.status === 'loading') return <MessageSkeleton {...props} eyebrow="Erstnachricht" />;
  return <FirstMessageReady {...props} />;
}

/** Platzhalter für Nachrichten-Karten, bis Verlauf und Signal da sind – Knöpfe schon mit den richtigen Texten. */
export function MessageSkeleton({ card, onOpenLead, eyebrow }: CardProps & { eyebrow: string }) {
  const { lead } = useTaskCard(card);
  const mode = useActionMode(messageAccount(lead));
  const texts = ACTION_TEXTS.send[mode];
  return (
    <FocusPage
      actions={
        <>
          <Button variant="outline" size="xl" disabled className="w-full">
            Nicht senden
          </Button>
          <Button variant="primary" size="xl" disabled icon={<Send className="h-4 w-4" />} className="w-full">
            <span className="sm:hidden">{texts.short}</span>
            <span className="hidden sm:inline">{texts.button}</span>
          </Button>
        </>
      }
    >
      <div aria-busy="true">
        <StepRail step={eyebrow === 'Erstnachricht' ? 'first' : 'followup'} />
        <PersonHeader lead={lead} compact profileLink={mode === 'protocol'} onOpen={() => onOpenLead(lead.id)} />
        <AccountHint kind="message" account={lead.linkedin?.sentBy} owner={lead.owner} />
        {/* Gleiche Abstände wie die fertige Karte – damit nichts springt. */}
        {eyebrow === 'Erstnachricht' ? (
          <>
            <Placeholder className="mx-auto mt-1 h-5 w-56" />
            <Placeholder className="mx-auto mt-8 h-10 w-72" />
            <Placeholder className="mt-4 h-[180px] w-full rounded-[22px]" />
          </>
        ) : (
          <>
            <Placeholder className="mx-auto mt-6 h-8 w-48" />
            <Placeholder className="mx-auto mt-4 h-10 w-80" />
            <Placeholder className="mt-4 h-[140px] w-full rounded-[22px]" />
          </>
        )}
      </div>
    </FocusPage>
  );
}

function FirstMessageReady({ card, onDecide, onOpenLead, hotkeysEnabled }: CardProps) {
  const { lead, signal, draft } = useTaskCard(card);
  const present = useIsPresent();
  const mode = useActionMode(messageAccount(lead));
  const texts = ACTION_TEXTS.send[mode];
  const templates = useTemplates();
  const variables = useMemo(() => variablesForCockpitLead(lead), [lead]);
  // Vorlagen der Zielgruppe (G1/G2 bzw. R1/R2) aus `GET /api/templates` – mit Hiring-Signal zuerst die Recruiting-Vorlagen.
  // Von Hand gewählte Kategorie (Wunsch des Nutzers 15.10.: die automatische Einordnung passt nicht immer) ersetzt sie.
  const [audience, setAudience] = useState<FirstAudience | null>(null);
  const autoAudiences = firstAudiences(lead);
  // Segment (27.10.): Finanzdienstleister bekommen ihre eigenen Texte, alle anderen die für Kapitalanlage.
  const segment = templateSegmentOf(lead.assessment?.category);
  const candidates = (audience ? [audience] : autoAudiences).flatMap((entry) => templates.firstFor(entry, segment));
  const audienceOptions = FIRST_AUDIENCES.filter((entry) => templates.firstFor(entry, segment).length > 0);

  const [templateId, setTemplateId] = useState<string>(() => {
    // Ein wiederhergestellter Entwurf ohne passende Vorlage bleibt freier Text – nie einer Vorlage zuschreiben.
    if (draft) return draft.label && candidates.some((template) => template.id === draft.label) ? draft.label : FREE;
    return candidates[0]?.id ?? FREE;
  });
  // Nur bearbeitete Texte je Vorlage – unbearbeitete folgen dem aktuellen Vorlagentext. FREE = ohne Vorlage.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => (draft?.text ? { [templateId]: draft.text } : {}));
  // Vorlage, auf der ein Vorschlag beruht, wenn er als freier Text landet – für das Label beim Senden.
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null);
  const hasFree = drafts[FREE] !== undefined;
  const template = templateId === FREE && (hasFree || candidates.length === 0) ? null : (candidates.find((entry) => entry.id === templateId) ?? candidates[0] ?? null);
  const key = template?.id ?? FREE;
  const original = useMemo(() => (template ? fillTemplate(template.text, variables) : ''), [template, variables]);
  const text = drafts[key] ?? original;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const blocked = blockReason(text);
  const hintId = `${card.id}-send-hint`;
  // Vorschlag ersetzt den Text der Vorlage, auf der er beruht (sonst der gerade gewählten).
  const applySuggestion = useCallback(
    (next: string, suggestedId: string | null) => {
      const target = suggestedId && candidates.some((entry) => entry.id === suggestedId) ? suggestedId : key;
      setTemplateId(target);
      setSuggestedFrom(target === FREE ? suggestedId : null);
      setDrafts((current) => ({ ...current, [target]: next }));
    },
    [candidates, key],
  );
  const suggestion = useSuggestion(lead.id, 'first', applySuggestion, template?.id);

  useEffect(() => {
    if (draft) focusAtEnd(editorRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = () => {
    if (blocked) {
      selectFirstPlaceholder(editorRef.current);
      return;
    }
    onDecide({
      decision: 'send',
      positive: true,
      action: { action: 'message_sent', text, ...(template ? { label: template.id } : suggestedFrom ? { label: suggestedFrom } : {}) },
      toast: { pending: `Erstnachricht ${texts.pending}`, done: texts.done, short: texts.toastShort },
    });
  };

  const skip = () => onDecide({ decision: 'skip', positive: false, action: null, toast: SKIP_TOAST });

  // Selbst schreiben: leeres Feld als „Eigene Nachricht“, Cursor hinein.
  const writeOwn = () => {
    setDrafts((current) => ({ ...current, [FREE]: '' }));
    setTemplateId(FREE);
    setSuggestedFrom(null);
    requestAnimationFrame(() => focusAtEnd(editorRef.current));
  };

  // Kategorie wechseln: erste Vorlage der neuen Kategorie; eigene Texte (auch freier Text) bleiben erhalten.
  const pickAudience = (next: FirstAudience) => {
    setAudience(next);
    const first = templates.firstFor(next, segment)[0];
    if (first && templateId !== FREE) setTemplateId(first.id);
  };
  const shownAudience = audience ?? autoAudiences[0];
  // Die Kategorie wählt die Karte selbst (Signal, Meta-Ads) – die vier Möglichkeiten erst auf Klick (Wunsch des Nutzers
  // 25.10.: nicht zwei Schalterreihen übereinander). Mit einer Kategorie allein gibt es nichts zu wählen.
  const [audienceOpen, setAudienceOpen] = useState(false);
  const canPickAudience = audienceOptions.length > 1;

  // Vorlagen der Zielgruppe – und „Eigene Nachricht“, sobald es freien Text gibt (Entwurf, Vorschlag ohne Vorlage).
  const pickerOptions = [
    ...candidates.slice(0, TABBED_TEMPLATES).map((entry, index) => ({
      value: entry.id,
      label: (
        <>
          <span className="sm:hidden">{templateLetter(index)}</span>
          <span className="hidden max-w-[170px] truncate align-bottom sm:inline-block">
            {templateLetter(index)} · {shortTemplateName(entry)}
          </span>
        </>
      ),
    })),
    ...(hasFree && candidates.length ? [{ value: FREE, label: <>Eigene Nachricht</> }] : []),
  ].map((option, index) => ({ ...option, shortcut: String(index + 1) }));

  useHotkeys(
    {
      enter: send,
      arrowright: send,
      arrowleft: skip,
      e: () => focusAtEnd(editorRef.current),
      k: () => void suggestion.run(),
      ...Object.fromEntries(pickerOptions.map((option, index) => [String(index + 1), () => setTemplateId(option.value)])),
    },
    hotkeysEnabled && present,
  );
  useSwipeActions({
    right: { label: texts.swipe, run: send, enabled: !blocked },
    left: { label: 'Nicht senden', run: skip },
  });

  // Die Vorlagen sind für Firmen ohne aktive Meta-Ads – passt der Lead nicht sicher dazu, sagen wir es.
  // Wie das Backend (`suggest.ts`): ohne Score zählt der Meta-Ads-Check, ohne beides ist es „unklar“.
  const leadType =
    lead.score?.leadType ??
    (lead.metaAds?.state === 'active' ? 'active' : lead.metaAds?.state === 'none' || lead.metaAds?.state === 'stopped' ? null : 'unclear');
  const company = lead.company.name || 'Die Firma';
  // Recruiting-Vorlage: Die Meta-Ads spielen im Text keine Rolle.
  const metaUrl = metaLibraryUrl(lead);
  // Von Hand gewählte Kategorie: Wer sie wählt, hat die Ads schon eingeschätzt – keine Warnung mehr.
  const metaWarning =
    template?.audience === 'hiring' || audience
      ? null
      : leadType === 'active'
        ? `${company} schaltet gerade Meta-Ads – erst die Kampagnen von Hand prüfen (oft wird dort viel Budget verbrannt), dann die Nachricht anpassen.`
        : leadType === 'unclear'
          ? `Meta-Ads bei ${company} unklar – prüf den Satz zur Werbung.`
          : null;

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
      <StepRail step="first" />
      <div className="mt-6">
        <PersonHeader lead={lead} compact profileLink={mode === 'protocol'} onOpen={() => onOpenLead(lead.id)} />
        <AccountHint kind="message" account={lead.linkedin?.sentBy} owner={lead.owner} />
      </div>
      <StatusSentence tone="good" testId="task-sentence">
        Hat angenommen – schreib {lead.person.firstName} jetzt
        {signal && (
          <>
            {' · '}
            <SignalText signal={signal} ready />
          </>
        )}
      </StatusSentence>

      <div className="mt-6 flex flex-col items-center">
        {canPickAudience && audienceOpen && (
          <div
            className="mb-3 flex max-w-full flex-wrap items-center justify-center gap-1.5 transition-[opacity,translate] duration-200 ease-out starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
            role="radiogroup"
            aria-label="Kategorie der Vorlage"
            data-testid="audience-picker"
          >
            {audienceOptions.map((entry) => {
              const active = entry === shownAudience;
              return (
                <button
                  key={entry}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => pickAudience(entry)}
                  className={cn(
                    'h-7 rounded-full px-3 text-[12.5px] font-medium transition-colors',
                    active ? 'bg-ink text-black' : 'text-ink-2 hover:text-ink',
                  )}
                  data-testid={`audience-${entry}`}
                >
                  {FIRST_AUDIENCE_LABELS[entry]}
                </button>
              );
            })}
          </div>
        )}
        {candidates.length > 0 ? (
          <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
            {canPickAudience && shownAudience && (
              <button
                type="button"
                onClick={() => setAudienceOpen((open) => !open)}
                aria-expanded={audienceOpen}
                title="Kategorie der Vorlage wechseln"
                className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                data-testid="audience-toggle"
              >
                <span className="sr-only">Kategorie: </span>
                {FIRST_AUDIENCE_LABELS[shownAudience]}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', audienceOpen && 'rotate-180')} aria-hidden />
              </button>
            )}
            <Segmented ariaLabel="Template wählen" value={template?.id ?? FREE} onChange={setTemplateId} options={pickerOptions} />
            <MoreTemplates templates={candidates} value={template?.id ?? FREE} onChange={setTemplateId} />
          </div>
        ) : (
          <TemplatesUnavailable />
        )}
      </div>
      {metaWarning && (
        <StatusLine
          testId="template-warning"
          className="mx-auto mt-4 max-w-[520px] justify-center text-[12.5px]"
          action={
            metaUrl && (
              <a
                href={safeHref(metaUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="whitespace-nowrap font-medium text-ink underline-offset-4 hover:underline"
                data-testid="template-warning-meta-link"
              >
                Werbebibliothek öffnen ↗
              </a>
            )
          }
        >
          {metaWarning}
        </StatusLine>
      )}

      <div className="mt-6">
        <WriteLabel onClear={text ? writeOwn : undefined} hint={template ? 'Vorschlag – einfach überschreiben' : null}>
          Deine Nachricht an {lead.person.firstName}
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

/** Ohne Vorlagen (Server nicht erreichbar oder keine passende) bleibt die Karte nutzbar: freier Text oder Vorschlag. */
export function TemplatesUnavailable() {
  const { state, reload, reloading } = useTemplates();
  return (
    <p role="alert" className="flex max-w-[520px] flex-wrap items-baseline justify-center gap-x-2 text-[12.5px] text-ink" data-testid="templates-unavailable">
      <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
      {state.status === 'error' ? 'Vorlagen konnten nicht geladen werden.' : 'Keine passende Vorlage.'}
      {state.status === 'error' && (
        <button
          type="button"
          onClick={reload}
          disabled={reloading}
          className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline disabled:opacity-40"
        >
          {reloading ? 'Wird geladen …' : 'Erneut laden'}
        </button>
      )}
    </p>
  );
}
