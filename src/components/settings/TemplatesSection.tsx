import { AnimatePresence, motion } from 'motion/react';
import { Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  DEFAULT_TOPIC,
  hiringRoleText,
  FOUNDER_GREETINGS,
  INVITE_NOTE_LIMIT,
  TEMPLATE_CATEGORIES,
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_MAX_PER_CATEGORY,
  TEMPLATE_PLACEHOLDERS,
  TEMPLATE_SEGMENTS,
  TEMPLATE_SEGMENT_LABELS,
  renderTemplate,
  templateCategory,
  templateLetter,
  unknownPlaceholders,
  type MessageKind,
  type MessageTemplate,
  type TemplateCategory,
  type TemplatePlaceholder,
  type TemplateSegment,
} from '../../../shared/messages';
import { cn } from '../../lib/cn';
import { ApiError, settingsApi, templatesApi } from '../../lib/leadSearchApi';
import { readableError } from '../../lib/leadView';
import { EASE_OUT } from '../../lib/motion';
import { unresolvedPlaceholders } from '../../lib/template';
import { formatRelative } from '../../lib/time';
import { useHotkeys } from '../../lib/useHotkeys';
import { useDemo } from '../../state/demo';
import { shortTemplateName, useTemplates } from '../../state/templates';
import { Button } from '../ui/Button';
import { DisclosureToggle } from '../ui/Disclosure';
import { DisclosureRow } from '../ui/DisclosureRow';
import { AREA, FIELD, HEADING, LABEL, TEXT_BUTTON } from './look';

const NAME_MAX_LENGTH = 80;

const PLACEHOLDER_HELP: Record<TemplatePlaceholder, string> = {
  vorname: 'Vorname des Leads',
  firma: 'Firmenname',
  thema: `„${DEFAULT_TOPIC}“`,
  grussformel: 'deine Grußformel',
  metapause: 'wie lange keine Meta-Ads mehr, z. B. „seit rund 4 Monaten“',
  metastopp: 'wann die Meta-Ads aufgehört haben, z. B. „vor rund 4 Monaten“',
  stelle: 'wen die Firma sucht, z. B. „Verstärkung als Vertriebsmitarbeiter (m/w/d)“',
};

/** Entwurf einer vorhandenen Vorlage: geänderte Felder, „zurücksetzen“ oder „löschen“. */
type RowDraft = { name?: string; text?: string; segment?: TemplateSegment | null } | { reset: true } | { remove: true };

/** Segment (27.10.): für wen die Vorlage gilt. null = alle Leads. */
const segmentText = (segment: TemplateSegment | null | undefined) => (segment ? TEMPLATE_SEGMENT_LABELS[segment] : 'Alle Leads');

/** Neue, noch nicht gespeicherte Vorlage. */
interface AddedRow {
  key: string;
  category: TemplateCategory;
  name: string;
  text: string;
  segment: TemplateSegment | null;
}

const isReset = (draft: RowDraft | undefined): draft is { reset: true } => !!draft && 'reset' in draft;
const isRemove = (draft: RowDraft | undefined): draft is { remove: true } => !!draft && 'remove' in draft;

const limitFor = (kind: MessageKind) => (kind === 'invite_note' ? INVITE_NOTE_LIMIT : TEMPLATE_MAX_LENGTH);

/** Fehler im Entwurf – dieselben Regeln wie `PUT`/`POST /api/templates`. Neue Vorlagen dürfen ohne Namen sein. */
export function validateTemplate(
  template: { kind: MessageKind },
  name: string,
  text: string,
  options: { nameRequired?: boolean } = {},
): { name?: string; text?: string } {
  const errors: { name?: string; text?: string } = {};
  if (!name.trim() && options.nameRequired !== false) errors.name = 'Bitte einen Namen eingeben.';
  else if (name.trim().length > NAME_MAX_LENGTH) errors.name = `Höchstens ${NAME_MAX_LENGTH} Zeichen.`;
  // Wie die Sperre beim Senden (`unresolvedPlaceholders`): alles in {{…}}, was kein bekannter Platzhalter ist.
  const unknown = [
    ...new Set([
      ...unknownPlaceholders(text),
      ...unresolvedPlaceholders(text).filter((key) => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(key)),
    ]),
  ];
  if (!text.trim()) errors.text = 'Bitte einen Text eingeben.';
  else if (unknown.length) {
    errors.text = `Unbekannter Platzhalter: ${unknown.map((key) => `{{${key}}}`).join(', ')} – erlaubt sind ${TEMPLATE_PLACEHOLDERS.map((key) => `{{${key}}}`).join(', ')}.`;
  } else if (text.trim().length > limitFor(template.kind)) {
    errors.text =
      template.kind === 'invite_note'
        ? `Die Notiz zur Vernetzungsanfrage darf höchstens ${INVITE_NOTE_LIMIT} Zeichen haben.`
        : `Höchstens ${TEMPLATE_MAX_LENGTH.toLocaleString('de-DE')} Zeichen.`;
  }
  return errors;
}

/**
 * Vorlagen bearbeiten (`GET/POST /api/templates`, `PUT/DELETE /api/templates/:id`, `POST …/reset`). Je Kategorie
 * mindestens eine Vorlage mit Text, höchstens 26 – nach Reihenfolge A bis Z benannt wie auf den Karten.
 * Änderungen gelten für beide Gründer ab der nächsten Karte.
 */
export function TemplatesSection({ active }: { active: boolean }) {
  const { state, reload, reloading, replace, add, drop } = useTemplates();
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [added, setAdded] = useState<AddedRow[]>([]);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string; id: number } | null>(null);
  const [saving, setSaving] = useState(false);
  /** Speichern wurde mit Fehlern versucht – dann zeigen auch leere neue Vorlagen ihren Fehler. */
  const [tried, setTried] = useState(false);
  /** Aufgeklappte Vorlagen – mehrere gleichzeitig möglich. */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const messageId = useRef(0);
  const addedSeq = useRef(0);
  // Notiz zur Vernetzungsanfrage ausgeschaltet (Einstellungen → Tagesstapel, INVITE_NOTE)? Bei jedem Öffnen neu lesen –
  // die Einstellung kann gerade eben in einem anderen Bereich geändert worden sein.
  const [inviteNoteOff, setInviteNoteOff] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    settingsApi
      .get()
      .then((response) => {
        if (alive) setInviteNoteOff(response.settings.find((setting) => setting.key === 'INVITE_NOTE')?.value === 'off');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [active]);

  const templates = state.status === 'ready' ? state.templates : [];
  const changed = templates.filter((template) => drafts[template.id] !== undefined);
  const changeCount = changed.length + added.length;
  const invalidKeys = [
    ...changed.flatMap((template) => {
      const draft = drafts[template.id];
      if (isReset(draft) || isRemove(draft)) return [];
      const errors = validateTemplate(template, draft?.name ?? template.name, draft?.text ?? template.text);
      return errors.name || errors.text ? [template.id] : [];
    }),
    ...added.flatMap((row) => {
      const errors = validateTemplate(categoryInfo(row.category), row.name, row.text, { nameRequired: false });
      return errors.name || errors.text ? [row.key] : [];
    }),
  ];

  const say = (tone: 'good' | 'bad', text: string) => setMessage({ tone, text, id: ++messageId.current });
  const clearError = (key: string) =>
    setServerErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || changeCount === 0) return;
    if (invalidKeys.length) {
      setTried(true);
      const letters = invalidKeys.map((key) => labelOf(key)).join(', ');
      say('bad', `Bitte erst korrigieren: ${letters}.`);
      // Erst aufklappen, dann fokussieren – das Feld ist sonst versteckt.
      const first = invalidKeys[0];
      setOpen((current) => ({ ...current, [first]: true }));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-template-key="${first}"] [aria-invalid="true"]`)?.focus());
      return;
    }
    setSaving(true);
    setTried(false);
    setMessage(null);
    let failed = 0;
    const fail = (key: string, error: unknown, fallback: string) => {
      failed++;
      // Der Grund steht an der Vorlage – also aufklappen.
      setOpen((current) => ({ ...current, [key]: true }));
      const gone = error instanceof ApiError && error.status === 404;
      if (gone) reload();
      const text = gone ? 'Diese Vorlage gibt es nicht mehr.' : error instanceof ApiError ? readableError(error, fallback) : `Keine Verbindung – ${fallback.toLowerCase()}`;
      setServerErrors((current) => ({ ...current, [key]: text }));
    };
    // Nacheinander – schlägt eine fehl, sind die anderen trotzdem gespeichert. Erst Änderungen, dann neue Vorlagen,
    // damit „löschen und neu anlegen“ nicht an der Grenze von 26 scheitert.
    for (const template of changed) {
      const draft = drafts[template.id];
      try {
        if (isRemove(draft)) {
          await templatesApi.remove(template.id);
          drop(template.id);
        } else {
          const saved = isReset(draft)
            ? await templatesApi.reset(template.id)
            : await templatesApi.update(template.id, {
                name: (draft?.name ?? template.name).trim(),
                text: (draft?.text ?? template.text).trim(),
                ...(template.custom && draft && 'segment' in draft && draft.segment !== undefined ? { segment: draft.segment } : {}),
              });
          replace(saved);
        }
        // Nur den gesendeten Entwurf entfernen – was währenddessen getippt wurde, bleibt.
        setDrafts((current) => {
          if (current[template.id] !== draft) return current;
          const next = { ...current };
          delete next[template.id];
          return next;
        });
        clearError(template.id);
      } catch (error) {
        fail(template.id, error, 'Nicht gespeichert.');
      }
    }
    for (const row of added) {
      try {
        const created = await templatesApi.create({
          category: row.category,
          text: row.text.trim(),
          ...(row.name.trim() ? { name: row.name.trim() } : {}),
          ...(row.segment ? { segment: row.segment } : {}),
        });
        add(created);
        setAdded((current) => current.filter((entry) => entry.key !== row.key));
        clearError(row.key);
        // Die neue Vorlage bleibt aufgeklappt, wenn die Zeile es war.
        setOpen((current) => (current[row.key] ? { ...current, [created.id]: true } : current));
      } catch (error) {
        fail(row.key, error, 'Nicht angelegt.');
      }
    }
    setSaving(false);
    if (failed) say('bad', failed === 1 ? 'Eine Änderung wurde nicht gespeichert – Grund steht an der Vorlage.' : `${failed} Änderungen wurden nicht gespeichert – Grund steht an den Vorlagen.`);
    else say('good', 'Gespeichert – gilt ab der nächsten Karte für beide Gründer.');
  };

  useHotkeys({ enter: () => void save() }, active && changeCount > 0 && !saving);

  // Beim Öffnen des Bereichs frisch laden – der andere Gründer hat vielleicht inzwischen etwas geändert.
  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  /** Zeilen einer Kategorie in Reihenfolge: gespeicherte, dann neue. */
  const rowsOf = (category: TemplateCategory) => [
    ...templates.filter((template) => templateCategory(template) === category).map((template) => ({ key: template.id, template, added: null as AddedRow | null })),
    ...added.filter((row) => row.category === category).map((row) => ({ key: row.key, template: null as MessageTemplate | null, added: row })),
  ];

  /** „Follow-up 1 · B“ – für Meldungen. */
  function labelOf(key: string): string {
    for (const category of TEMPLATE_CATEGORIES) {
      const index = rowsOf(category.id).findIndex((row) => row.key === key);
      if (index >= 0) return `${category.label} ${templateLetter(index)}`;
    }
    return key;
  }

  if (state.status === 'loading') {
    return (
      <p className="py-16 text-[14px] text-ink-3" role="status">
        Vorlagen werden geladen …
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="py-16">
        <p className="text-[15px] text-ink-2" role="alert" data-testid="templates-load-error">
          {state.message}
        </p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={reload} disabled={reloading}>
          {reloading ? 'Wird geladen …' : 'Erneut versuchen'}
        </Button>
      </div>
    );
  }

  const setDraft = (id: string, next: RowDraft | undefined) =>
    setDrafts((current) => {
      const copy = { ...current };
      if (next === undefined) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  const addRow = (category: TemplateCategory) => {
    const key = `new-${++addedSeq.current}`;
    setAdded((current) => [...current, { key, category, name: '', text: '', segment: null }]);
    setOpen((current) => ({ ...current, [key]: true }));
    setMessage(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-template-key="${key}"] textarea`)?.focus());
  };
  const barVisible = changeCount > 0 || !!message;

  return (
    <form onSubmit={(event) => void save(event)} noValidate className="pb-40" data-testid="templates">
      {/* Während des Speicherns gesperrt – sonst gingen Eingaben verloren, die nach dem Absenden kommen. */}
      <fieldset disabled={saving} className="contents">
        <div className="space-y-12">
          {TEMPLATE_CATEGORIES.map((category) => {
            const rows = rowsOf(category.id);
            // Was nach dem Speichern bleibt – die letzte Vorlage einer Kategorie lässt sich nicht löschen.
            const remaining = rows.filter((row) => !(row.template && isRemove(drafts[row.template.id]))).length;
            const full = rows.length >= TEMPLATE_MAX_PER_CATEGORY;
            const unused = category.id === 'invite' && inviteNoteOff;
            return (
              <section
                key={category.id}
                aria-labelledby={`templates-${category.id}`}
                data-testid={`templates-${category.id}`}
                data-unused={unused || undefined}
                className={cn(unused && 'opacity-50 transition-opacity focus-within:opacity-100 hover:opacity-100')}
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 id={`templates-${category.id}`} className={HEADING}>
                      {category.label}
                    </h2>
                    {unused && (
                      <p className="mt-1 text-[12.5px] text-ink-3" data-testid="templates-invite-unused">
                        Wird gerade nicht verwendet – die Notiz zur Vernetzungsanfrage ist unter Einstellungen → Tagesstapel
                        ausgeschaltet. Hier musst du nichts eintragen.
                      </p>
                    )}
                  </div>
                  {full ? (
                    <span className="text-[12px] text-ink-3">A–Z voll</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => addRow(category.id)}
                      className="-mr-2 inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                      aria-label={`Vorlage ${templateLetter(rows.length)} zu ${category.label} hinzufügen`}
                      data-testid={`template-add-${category.id}`}
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                      Vorlage
                    </button>
                  )}
                </div>
                <div className="mt-1">
                  {rows.map((row, index) =>
                    row.template ? (
                      <TemplateRow
                        key={row.key}
                        letter={templateLetter(index)}
                        template={row.template}
                        draft={drafts[row.template.id]}
                        onDraft={(next) => {
                          setDraft(row.key, next);
                          clearError(row.key);
                        }}
                        canRemove={remaining > 1}
                        serverError={serverErrors[row.key]}
                        onSave={() => void save()}
                        open={!!open[row.key]}
                        onToggle={() => setOpen((current) => ({ ...current, [row.key]: !current[row.key] }))}
                      />
                    ) : (
                      <NewTemplateRow
                        key={row.key}
                        letter={templateLetter(index)}
                        row={row.added!}
                        kind={category.kind}
                        onChange={(patch) => {
                          setAdded((current) => current.map((entry) => (entry.key === row.key ? { ...entry, ...patch } : entry)));
                          clearError(row.key);
                        }}
                        onDiscard={() => {
                          setAdded((current) => current.filter((entry) => entry.key !== row.key));
                          clearError(row.key);
                        }}
                        serverError={serverErrors[row.key]}
                        showEmpty={tried}
                        onSave={() => void save()}
                        open={!!open[row.key]}
                        onToggle={() => setOpen((current) => ({ ...current, [row.key]: !current[row.key] }))}
                      />
                    ),
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </fieldset>

      <AnimatePresence>
        {barVisible && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="glass fixed inset-x-0 bottom-[var(--nav-bottom)] z-40 border-t border-line"
          >
            <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
              <p
                key={message?.tone === 'bad' ? message.id : 'status'}
                role={message?.tone === 'bad' ? 'alert' : 'status'}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-[13.5px] text-ink"
                data-testid="templates-message"
              >
                {message && (changeCount === 0 || message.tone === 'bad') ? (
                  <>
                    <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', message.tone === 'good' ? 'bg-good' : 'bg-bad')} aria-hidden />
                    {message.text}
                  </>
                ) : (
                  `${changeCount} ${changeCount === 1 ? 'Änderung' : 'Änderungen'}`
                )}
              </p>
              {changeCount > 0 && (
                <>
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setDrafts({});
                      setAdded([]);
                      setServerErrors({});
                      setMessage(null);
                    }}
                  >
                    Verwerfen
                  </Button>
                  <Button type="submit" variant="primary" shortcut={saving ? undefined : '↵'} disabled={saving} data-testid="templates-save">
                    {saving ? 'Wird gespeichert…' : 'Speichern'}
                  </Button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

function categoryInfo(category: TemplateCategory) {
  return TEMPLATE_CATEGORIES.find((entry) => entry.id === category)!;
}

/** Buchstabe der Vorlage als runde Marke. */
function Letter({ letter, muted = false }: { letter: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold tabular-nums',
        muted ? 'text-ink-4' : 'text-ink',
      )}
    >
      {letter}
    </span>
  );
}

/** Kurzer Stand rechts in der Zeile – nur bei einer Abweichung. */
function RowStatus({ tone, children }: { tone: 'accent' | 'warn' | 'muted'; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-ink-3">
      {tone !== 'muted' && <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'accent' ? 'bg-accent' : 'bg-warn')} aria-hidden />}
      {children}
    </span>
  );
}

function TemplateRow({
  letter,
  template,
  draft,
  onDraft,
  canRemove,
  serverError,
  onSave,
  open,
  onToggle,
}: {
  letter: string;
  template: MessageTemplate;
  draft: RowDraft | undefined;
  onDraft: (next: RowDraft | undefined) => void;
  canRemove: boolean;
  serverError: string | undefined;
  onSave: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  const resetting = isReset(draft);
  const removing = isRemove(draft);
  const locked = resetting || removing;
  const name = locked ? template.name : (draft?.name ?? template.name);
  const text = locked ? template.text : (draft?.text ?? template.text);
  const segment = !locked && draft && 'segment' in draft && draft.segment !== undefined ? draft.segment : (template.segment ?? null);
  const errors = locked ? {} : validateTemplate(template, name, text);
  // Fehler erst zeigen, wenn wirklich etwas geändert wurde – oder der Server ihn meldet.
  const textError = (draft && !locked ? errors.text : undefined) ?? serverError;
  const nameError = draft && !locked ? errors.name : undefined;

  const update = (patch: { name?: string; text?: string; segment?: TemplateSegment | null }) => {
    const next = { name, text, segment, ...patch };
    // Zurück auf den gespeicherten Stand = keine Änderung mehr.
    onDraft(next.name === template.name && next.text === template.text && next.segment === (template.segment ?? null) ? undefined : next);
  };

  // Stand nur bei einer Abweichung – kein „Standard“.
  const status = removing ? (
    <RowStatus tone="warn">Wird gelöscht</RowStatus>
  ) : resetting ? (
    <RowStatus tone="warn">Wird zurückgesetzt</RowStatus>
  ) : draft ? (
    <RowStatus tone="accent">Geändert</RowStatus>
  ) : !template.isDefault ? (
    <RowStatus tone="muted">
      {template.custom ? 'Eigene' : 'Angepasst'}
      <span className="hidden sm:inline">
        {template.updatedBy ? ` von ${template.updatedBy}` : ''}
        {template.updatedAt ? ` · ${formatRelative(template.updatedAt)}` : ''}
      </span>
    </RowStatus>
  ) : null;

  return (
    <article data-testid={`template-${template.id}`} data-template-key={template.id} aria-labelledby={`${id}-title`}>
      <DisclosureRow
        id={id}
        as="h3"
        titleWeight="normal"
        leading={<Letter letter={letter} muted={removing} />}
        title={
          <span className={cn(removing && 'text-ink-3 line-through')}>
            {shortTemplateName({ ...template, name }) || name}
            {segment && <span className="text-ink-3" data-testid={`template-segment-${template.id}`}> · {TEMPLATE_SEGMENT_LABELS[segment]}</span>}
          </span>
        }
        status={status}
        open={open}
        onToggle={onToggle}
        testId={`template-toggle-${template.id}`}
        panelClassName="pb-6 pl-9"
      >
        <Editor
          id={id}
          testKey={template.id}
          kind={template.kind}
          name={name}
          text={text}
          disabled={locked}
          textError={textError}
          nameError={nameError}
          segment={segment}
          // Standardtexte haben ein festes Segment – nur eigene Vorlagen lassen sich umstellen.
          segmentEditable={!!template.custom}
          onChange={update}
          onSave={onSave}
          actions={<>
          {locked ? (
            <button type="button" onClick={() => onDraft(undefined)} className={TEXT_BUTTON} data-testid={`template-undo-reset-${template.id}`}>
              {removing ? 'Doch behalten' : 'Doch nicht zurücksetzen'}
            </button>
          ) : (
            <>
              {!template.isDefault && !template.custom && (
                <button type="button" onClick={() => onDraft({ reset: true })} className={TEXT_BUTTON} data-testid={`template-reset-${template.id}`}>
                  Zurücksetzen
                </button>
              )}
              {canRemove && (
                <button
                  type="button"
                  onClick={() => onDraft({ remove: true })}
                  className={cn(TEXT_BUTTON, 'hover:text-bad')}
                  data-testid={`template-remove-${template.id}`}
                >
                  Löschen
                </button>
              )}
            </>
          )}
        </>}
        />
      </DisclosureRow>
    </article>
  );
}

function NewTemplateRow({
  letter,
  row,
  kind,
  onChange,
  onDiscard,
  serverError,
  showEmpty,
  onSave,
  open,
  onToggle,
}: {
  letter: string;
  row: AddedRow;
  kind: MessageKind;
  onChange: (patch: { name?: string; text?: string; segment?: TemplateSegment | null }) => void;
  onDiscard: () => void;
  serverError: string | undefined;
  /** Nach einem Speicherversuch auch „leer“ melden. */
  showEmpty: boolean;
  onSave: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  const errors = validateTemplate({ kind }, row.name, row.text, { nameRequired: false });
  // Leeres Feld erst nach dem ersten Tippen oder einem Speicherversuch bemängeln.
  const textError = (row.text || showEmpty ? errors.text : undefined) ?? serverError;
  return (
    <article data-testid={`template-${row.key}`} data-template-key={row.key} aria-labelledby={`${id}-title`}>
      <DisclosureRow
        id={id}
        as="h3"
        titleWeight="normal"
        leading={<Letter letter={letter} />}
        title={
          <span>
            {row.name.trim() || 'Neue Vorlage'}
            {row.segment && <span className="text-ink-3"> · {TEMPLATE_SEGMENT_LABELS[row.segment]}</span>}
          </span>
        }
        status={<RowStatus tone="accent">Neu</RowStatus>}
        open={open}
        onToggle={onToggle}
        testId={`template-toggle-${row.key}`}
        panelClassName="pb-6 pl-9"
      >
        <Editor
          id={id}
          testKey={row.key}
          kind={kind}
          name={row.name}
          text={row.text}
          disabled={false}
          textError={textError}
          nameError={errors.name}
          namePlaceholder="Neue Vorlage"
          segment={row.segment}
          segmentEditable
          onChange={onChange}
          onSave={onSave}
          actions={
            <button type="button" onClick={onDiscard} className={TEXT_BUTTON} data-testid={`template-discard-${row.key}`}>
              Verwerfen
            </button>
          }
        />
      </DisclosureRow>
    </article>
  );
}

/** Text mit Platzhaltern, Zeichenzähler, Name und Vorschau. */
function Editor({
  id,
  testKey,
  kind,
  name,
  text,
  disabled,
  textError,
  nameError,
  namePlaceholder,
  segment,
  segmentEditable,
  onChange,
  onSave,
  actions,
}: {
  id: string;
  testKey: string;
  kind: MessageKind;
  name: string;
  text: string;
  disabled: boolean;
  textError: string | undefined;
  nameError: string | undefined;
  namePlaceholder?: string;
  segment: TemplateSegment | null;
  /** false = festes Segment (Standardtext), nur anzeigen. */
  segmentEditable: boolean;
  onChange: (patch: { name?: string; text?: string; segment?: TemplateSegment | null }) => void;
  onSave: () => void;
  /** Knöpfe rechts neben „Vorschau“ (Zurücksetzen, Löschen …). */
  actions?: ReactNode;
}) {
  const { state } = useDemo();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const limit = limitFor(kind);
  const length = text.trim().length;
  const greeting = FOUNDER_GREETINGS[state.founder ?? 'nick'];
  const sample = renderTemplate(text, {
    vorname: 'Anna',
    firma: 'Muster Immobilien GmbH',
    thema: DEFAULT_TOPIC,
    grussformel: greeting,
    stelle: hiringRoleText('Vertriebsmitarbeiter (m/w/d)'),
  });

  const insert = (key: TemplatePlaceholder) => {
    const field = textRef.current;
    const token = `{{${key}}}`;
    if (!field || disabled) return;
    const start = field.selectionStart ?? text.length;
    const end = field.selectionEnd ?? text.length;
    onChange({ text: text.slice(0, start) + token + text.slice(end) });
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <>
      <label className="sr-only" htmlFor={`${id}-text`}>
        Text
      </label>
      <textarea
        id={`${id}-text`}
        ref={textRef}
        value={text}
        onChange={(event) => onChange({ text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave();
          }
        }}
        disabled={disabled}
        rows={kind === 'invite_note' ? 3 : 7}
        placeholder="Text der Vorlage"
        aria-invalid={textError ? true : undefined}
        aria-describedby={`${id}-count${textError ? ` ${id}-text-error` : ''}`}
        className={AREA}
        data-testid={`template-text-${testKey}`}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="-ml-1.5 flex flex-wrap gap-0.5" aria-label="Platzhalter einfügen" role="group">
          {TEMPLATE_PLACEHOLDERS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => insert(key)}
              disabled={disabled}
              className="rounded-md px-1.5 py-0.5 font-mono text-[11.5px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40"
              title={`${PLACEHOLDER_HELP[key]} einfügen`}
            >
              {`{{${key}}}`}
            </button>
          ))}
        </div>
        <p id={`${id}-count`} className={cn('text-[11px] font-semibold tabular-nums', length > limit ? 'text-bad' : 'text-ink-3')} data-testid={`template-count-${testKey}`}>
          {length.toLocaleString('de-DE')} / {limit.toLocaleString('de-DE')}
        </p>
      </div>
      {textError && (
        <p id={`${id}-text-error`} role="alert" className="mt-1.5 flex items-baseline gap-2 text-[12.5px] text-ink" data-testid={`template-error-${testKey}`}>
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {textError}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <label className={LABEL} htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          value={name}
          onChange={(event) => onChange({ name: event.target.value })}
          disabled={disabled}
          placeholder={namePlaceholder}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          className={cn(FIELD, 'w-full sm:w-[300px]')}
          data-testid={`template-name-${testKey}`}
        />
      </div>
      {nameError && (
        <p id={`${id}-name-error`} role="alert" className="mt-1.5 text-right text-[12.5px] text-ink">
          {nameError}
        </p>
      )}

      {/* Segment (27.10., Kundengespräch: eigene Strecke für Finanzdienstleister): für wen die Vorlage gilt. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <label className={LABEL} htmlFor={`${id}-segment`}>
          Für
        </label>
        {segmentEditable ? (
          <select
            id={`${id}-segment`}
            value={segment ?? ''}
            onChange={(event) => onChange({ segment: (event.target.value || null) as TemplateSegment | null })}
            disabled={disabled}
            className={cn(FIELD, 'w-full appearance-none sm:w-[300px]')}
            data-testid={`template-segment-select-${testKey}`}
          >
            <option value="">Alle Leads</option>
            {TEMPLATE_SEGMENTS.map((value) => (
              <option key={value} value={value}>
                {TEMPLATE_SEGMENT_LABELS[value]}
              </option>
            ))}
          </select>
        ) : (
          <p id={`${id}-segment`} className="w-full text-[14px] text-ink-2 sm:w-[300px]" data-testid={`template-segment-fixed-${testKey}`}>
            {segmentText(segment)}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <DisclosureToggle className="-ml-2" open={preview} onToggle={() => setPreview((value) => !value)} controls={preview ? `${id}-preview` : undefined}>
          Vorschau
        </DisclosureToggle>
        <div className="flex flex-wrap items-center gap-x-4">{actions}</div>
      </div>
      {preview && (
        <div id={`${id}-preview`} className="mt-2 rounded-[12px] bg-surface-2 px-4 py-3" data-testid={`template-preview-${testKey}`}>
          <p className="mb-1.5 text-[11px] font-semibold text-ink-3">Beispiel: Anna von Muster Immobilien GmbH</p>
          <p className="whitespace-pre-wrap text-[14px] leading-[1.6] text-ink/90">{sample}</p>
        </div>
      )}
    </>
  );
}
