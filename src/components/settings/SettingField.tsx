import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { AnthropicModelsResponse, SettingDefinition, SettingKey, SettingState, SettingValue } from '../../../shared/settings';
import { settingsApi } from '../../lib/leadSearchApi';
import { cn } from '../../lib/cn';
import { StatusLine } from '../ui/Status';
import { FIELD, ROW, SUB, TEXT_BUTTON } from './look';

/** Entwurf einer Einstellung: `undefined` = unverändert, `null` = zurück zu .env/Standard, sonst der neue Wert. */
export type DraftValue = SettingValue | null | undefined;


/** Anzeige eines Werts ohne Eingabe (z. B. Rückfallwert, nur lesbar). */
export function formatValue(definition: SettingDefinition, value: SettingValue | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'nicht gesetzt';
  if (definition.type === 'boolean') return value ? 'an' : 'aus';
  if (definition.type === 'choice') return definition.options?.find((option) => option.value === value)?.label ?? String(value);
  if (value === 'off') return 'aus';
  return String(value);
}

/** „Gesetzt · endet auf …abcd“ – ohne `hint` (kurze Schlüssel) nur „Gesetzt“. */
export function secretText(secret: { set: boolean; hint: string | null } | undefined, set = 'Gesetzt', unset = 'Nicht gesetzt'): string {
  if (!secret?.set) return unset;
  return secret.hint ? `${set} · endet auf …${secret.hint}` : set;
}

/** Prüft einen Entwurf wie das Backend (Grenzen, Muster, Adressen) – null = in Ordnung. */
export function validateDraft(definition: SettingDefinition, value: SettingValue | null): string | null {
  if (value === null) return null;
  switch (definition.type) {
    case 'integer':
    case 'number': {
      if (definition.allowOff && value === 'off') return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Bitte gib eine Zahl ein.';
      if (definition.type === 'integer' && !Number.isInteger(value)) return 'Bitte gib eine ganze Zahl ein.';
      if (definition.min !== undefined && value < definition.min) return `Mindestens ${definition.min}.`;
      if (definition.max !== undefined && value > definition.max) return `Höchstens ${definition.max}.`;
      return null;
    }
    case 'url': {
      if (value === '') return null;
      const text = String(value).trim();
      const withScheme = definition.key === 'UNIPILE_DSN' && !/^[a-z]+:\/\//i.test(text) ? `https://${text}` : text;
      let url: URL;
      try {
        url = new URL(withScheme);
      } catch {
        return 'Bitte gib eine vollständige Adresse ein, z. B. https://…';
      }
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return 'Nur Adressen mit https:// sind erlaubt.';
      if (url.username || url.password) return 'Die Adresse darf keine Zugangsdaten enthalten.';
      if (url.pathname.replace(/\/+$/, '') || url.search || url.hash) return 'Nur die Adresse ohne Pfad, z. B. https://beispiel.de.';
      if (definition.key === 'UNIPILE_DSN' && !url.hostname.endsWith('.unipile.com')) return 'Die Adresse muss auf .unipile.com enden.';
      return null;
    }
    case 'text':
      if (definition.pattern && value !== '' && !new RegExp(definition.pattern).test(String(value))) return 'Das Format passt nicht.';
      return null;
    case 'secret':
      if (value !== '' && definition.minLength && String(value).length < definition.minLength) {
        return `Mindestens ${definition.minLength} Zeichen.`;
      }
      return null;
    default:
      return null;
  }
}

interface SettingFieldProps {
  definition: SettingDefinition;
  state: SettingState;
  draft: DraftValue;
  onDraft: (value: DraftValue) => void;
  error?: string;
  safeMode: boolean;
  /** Zusatzzeile unter dem Feld, z. B. die Client-IP bei TRUST_PROXY_HOPS. */
  note?: string;
  /**
   * Einziger Wert einer Unterseite: Die Seite trägt seinen Namen schon als Titel (Beschriftung nur für Screenreader),
   * die Eingabe steht links in voller Breite.
   */
  solo?: boolean;
}

/** Kurze Textwerte (Zeiten, Zeitzone, Version, IDs): schmaleres Feld. */
const SHORT_TEXT = new Set<SettingKey>(['LINKEDIN_WORK_HOURS', 'LINKEDIN_WORK_DAYS', 'LINKEDIN_TIMEZONE', 'LINKEDIN_PAUSE_SECONDS', 'META_GRAPH_VERSION', 'UNIPILE_LOCATION_ID']);

/**
 * Eine Einstellung als Zeile (Design v2, 09.10.): Beschriftung links, Eingabe rechts. Erklärtexte bleiben nur für
 * Screenreader; sichtbar ist nur, was abweicht (geändert, aus der .env, Problem, Fehler).
 */
export function SettingField({ definition, state, draft, onDraft, error, safeMode, note, solo = false }: SettingFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const problemId = `${id}-problem`;
  const noteId = `${id}-note`;
  const readOnly = !!definition.readOnlyReason;
  const changed = draft !== undefined;
  // Fehler zuerst – beim Fokus nach einem Fehler wird der Grund vorgelesen.
  const describedBy = [error && errorId, state.problem && problemId, helpId, note && noteId].filter(Boolean).join(' ');
  const fallbackText =
    definition.type === 'secret' ? secretText(state.fallbackSecret, 'gesetzt', 'nicht gesetzt') : formatValue(definition, state.fallback);
  const resetLabel = `Zurück zu ${state.fallbackSource === 'env' ? '.env' : 'Standard'} (${fallbackText})`;
  const showReset = !readOnly && !safeMode && (changed || state.source === 'software');
  // Lange Werte (Adressen, Schlüssel im Eingabemodus) nehmen auf dem Handy die ganze Breite.
  const wide = !readOnly && !safeMode && ['text', 'url', 'secret'].includes(definition.type) && !SHORT_TEXT.has(definition.key);

  return (
    <div data-testid={`setting-${definition.key}`}>
      <div className={solo ? 'flex flex-col items-start gap-3' : ROW}>
        <div className="flex min-w-0 flex-col gap-1">
          {/* Name wie bei den Schaltern: groß und klar, ohne Symbole (Wunsch des Nutzers 23.10.). */}
          <label id={labelId} htmlFor={id} className={solo ? 'sr-only' : 'text-[16px] font-semibold tracking-[-0.01em] text-ink'}>
            {definition.label}
          </label>
          {/* Nur ungespeicherte Änderungen – woher ein Wert kommt (.env), interessiert beim Einstellen niemanden. */}
          {changed && !readOnly && (
            <span className={cn(SUB, 'flex items-center gap-1.5 text-accent')} data-testid="setting-source">
              geändert
            </span>
          )}
          {note && (
            <span id={noteId} className="text-[11px] text-ink-3">
              {note}
            </span>
          )}
        </div>

        <div className={cn(solo ? 'flex w-full min-w-0' : 'ml-auto flex min-w-0 justify-end', wide && !solo && 'w-full sm:w-auto')}>
          {readOnly ? (
            <p className="text-[13px] font-semibold tabular-nums text-ink">
              {formatValue(definition, state.value)}
              <span className="sr-only"> · {definition.readOnlyReason}</span>
            </p>
          ) : safeMode ? (
            <SafeModeValue definition={definition} state={state} draft={draft} onDraft={onDraft} />
          ) : (
            <Input
              id={id}
              labelId={labelId}
              definition={definition}
              state={state}
              draft={draft}
              onDraft={onDraft}
              describedBy={describedBy}
              invalid={!!error}
            />
          )}
        </div>
      </div>
      <p id={helpId} className="sr-only">
        {definition.help}
      </p>

      {error && (
        <StatusLine tone="bad" role="alert" className={cn('mt-2 text-[12.5px]', !solo && 'justify-end text-right')}>
          <span id={errorId}>{error}</span>
        </StatusLine>
      )}
      {state.problem && (
        <StatusLine className="mt-2 text-[12.5px]">
          <span id={problemId}>{state.problem}</span>
        </StatusLine>
      )}

      {showReset && (
        <div className={cn('flex', solo ? 'mt-4' : 'mt-1.5 justify-end')}>
          {/* Eigene Keys: Nach dem Klick landet der Fokus nie auf der Gegen-Aktion an derselben Stelle. */}
          {changed ? (
            <button key="discard" type="button" onClick={() => onDraft(undefined)} className={TEXT_BUTTON}>
              Änderung verwerfen
            </button>
          ) : (
            <button key="reset" type="button" onClick={() => onDraft(null)} className={TEXT_BUTTON} data-testid="setting-reset">
              {resetLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Input({
  id,
  labelId,
  definition,
  state,
  draft,
  onDraft,
  describedBy,
  invalid,
}: {
  id: string;
  labelId: string;
  definition: SettingDefinition;
  state: SettingState;
  draft: DraftValue;
  onDraft: (value: DraftValue) => void;
  describedBy: string;
  invalid: boolean;
}) {
  if (draft === null && definition.type !== 'secret') {
    return (
      <p className="text-right text-[12.5px] text-ink-2" data-testid="setting-pending-reset">
        {`Beim Speichern zurück zu ${state.fallbackSource === 'env' ? '.env' : 'Standard'} (${formatValue(definition, state.fallback)}).`}
      </p>
    );
  }

  switch (definition.type) {
    case 'secret':
      return <SecretInput id={id} definition={definition} state={state} draft={draft} onDraft={onDraft} describedBy={describedBy} invalid={invalid} />;
    case 'boolean': {
      const on = (draft ?? state.value) === true;
      return (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          aria-describedby={describedBy}
          onClick={() => onDraft(!on)}
          className={cn(
            'relative h-[26px] w-11 shrink-0 rounded-full transition-[background-color,transform] duration-200 ease-out active:scale-[0.96] motion-reduce:transition-none',
            on ? 'bg-good' : 'bg-surface-4',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-300 ease-[cubic-bezier(.3,1.3,.5,1)] motion-reduce:transition-none',
              on ? 'translate-x-[18px]' : 'translate-x-0',
            )}
          />
        </button>
      );
    }
    case 'choice':
      return (
        <ChoiceGroup
          labelId={labelId}
          options={definition.options ?? []}
          value={String(draft ?? state.value ?? '')}
          onChange={(value) => onDraft(value)}
          describedBy={describedBy}
          invalid={invalid}
        />
      );
    case 'integer':
    case 'number': {
      const current = draft ?? state.value;
      const off = definition.allowOff && current === 'off';
      const number = typeof current === 'number' && Number.isFinite(current) ? current : null;
      const step = (delta: number) => {
        const base = number ?? definition.min ?? 0;
        let next = base + delta;
        if (definition.min !== undefined) next = Math.max(definition.min, next);
        if (definition.max !== undefined) next = Math.min(definition.max, next);
        onDraft(next);
      };
      return (
        <div className="flex items-center gap-3">
          {definition.allowOff && (
            <button
              type="button"
              aria-pressed={off}
              onClick={() => onDraft(off ? (definition.min ?? 0) : 'off')}
              className={cn('h-8 rounded-[8px] px-2.5 text-[12px] font-semibold transition-colors', off ? 'bg-surface-4 text-ink' : 'text-ink-3 hover:text-ink')}
            >
              Aus
            </button>
          )}
          <div className={cn('flex h-[38px] items-center rounded-[10px] border border-transparent bg-surface-3 focus-within:border-accent has-[input[aria-invalid=true]]:border-bad/60', off && 'opacity-40')}>
            {definition.type === 'integer' && (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                disabled={off || (definition.min !== undefined && number !== null && number <= definition.min)}
                onClick={() => step(-1)}
                className="h-full w-9 rounded-l-[10px] text-[16px] text-ink-2 transition-colors hover:text-ink active:bg-surface-4 disabled:opacity-30"
              >
                −
              </button>
            )}
            <input
              id={id}
              type="number"
              inputMode={definition.type === 'integer' ? 'numeric' : 'decimal'}
              step={definition.type === 'integer' ? 1 : 'any'}
              min={definition.min}
              max={definition.max}
              disabled={off}
              value={off || current === null || current === undefined ? '' : String(current)}
              onChange={(event) => {
                const text = event.target.value;
                onDraft(text === '' ? NaN : Number(text));
              }}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              className={cn(
                'h-full min-w-0 bg-transparent text-center text-[16px] font-semibold tabular-nums text-ink outline-none [appearance:textfield] sm:text-[14px] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
                definition.type === 'integer' ? 'w-14' : 'w-24 px-3',
              )}
            />
            {definition.type === 'integer' && (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                disabled={off || (definition.max !== undefined && number !== null && number >= definition.max)}
                onClick={() => step(1)}
                className="h-full w-9 rounded-r-[10px] text-[16px] text-ink-2 transition-colors hover:text-ink active:bg-surface-4 disabled:opacity-30"
              >
                +
              </button>
            )}
          </div>
        </div>
      );
    }
    default: {
      const current = draft ?? state.value ?? '';
      if (definition.optionsFrom === 'anthropic_models') {
        return <ModelSelect id={id} value={String(current)} onDraft={onDraft} describedBy={describedBy} invalid={invalid} />;
      }
      return (
        <input
          id={id}
          type={definition.type === 'url' ? 'url' : 'text'}
          inputMode={definition.type === 'url' ? 'url' : undefined}
          value={String(current)}
          onChange={(event) => onDraft(event.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={cn(FIELD, 'text-right', SHORT_TEXT.has(definition.key) ? 'w-[200px]' : 'w-full sm:w-[300px]')}
        />
      );
    }
  }
}

/** Auswahl eines Werts als Radiogruppe (Pfeiltasten wechseln, nur die Auswahl ist ein Tab-Stopp). */
function ChoiceGroup({
  labelId,
  options,
  value,
  onChange,
  describedBy,
  invalid,
}: {
  labelId: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  describedBy: string;
  invalid: boolean;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = Math.max(0, options.findIndex((option) => option.value === value));
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    // Fokus folgt der Auswahl.
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]');
    buttons[options.indexOf(next)]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      onKeyDown={onKeyDown}
      className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-[10px] bg-surface-3 p-[3px]"
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!value && option === options[0]) ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-8 rounded-[8px] px-3 text-[13px] font-semibold transition-[background-color,color,transform] duration-100 active:scale-[0.97]',
              checked ? 'bg-surface-4 text-ink shadow-[0_1px_2px_rgb(0_0_0/0.4)]' : 'text-ink-3 hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Geheimnis: nie anzeigen, nur „Gesetzt · endet auf …abcd“. „Ersetzen“ öffnet das Eingabefeld (erst Tippen ist eine
 * Änderung), „Entfernen“ setzt `''` (überdeckt einen Wert aus der .env) bzw. `null` (es gibt keinen in der .env).
 */
function SecretInput({
  id,
  definition,
  state,
  draft,
  onDraft,
  describedBy,
  invalid,
}: {
  id: string;
  definition: SettingDefinition;
  state: SettingState;
  draft: DraftValue;
  onDraft: (value: DraftValue) => void;
  describedBy: string;
  invalid: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const statusId = `${id}-status`;
  const set = state.secret?.set ?? false;

  if (draft === null) {
    return (
      <p className="text-right text-[12.5px] text-ink-2" data-testid="secret-pending-remove">
        {state.fallbackSecret?.set
          ? `Wird beim Speichern auf den Schlüssel aus der .env zurückgesetzt (${secretText(state.fallbackSecret, 'gesetzt')}).`
          : 'Wird beim Speichern entfernt.'}
      </p>
    );
  }
  if (draft === '' && !editing) {
    return (
      <p className="text-right text-[12.5px] text-ink-2" data-testid="secret-pending-remove">
        Wird beim Speichern entfernt – auch ein Schlüssel aus der .env gilt dann nicht mehr.
      </p>
    );
  }

  if (editing || (typeof draft === 'string' && draft !== '')) {
    return (
      <div className="flex w-full items-center gap-3 sm:w-[300px]">
        <input
          id={id}
          type="password"
          value={typeof draft === 'string' ? draft : ''}
          onChange={(event) => onDraft(event.target.value === '' ? undefined : event.target.value)}
          placeholder="Neuer Wert"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          autoFocus
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={cn(FIELD, 'min-w-0 flex-1')}
          data-testid="secret-input"
        />
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            onDraft(undefined);
          }}
          className={cn(TEXT_BUTTON, 'shrink-0')}
        >
          Abbrechen
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      <span id={statusId} className={cn('text-[13px] font-semibold', set ? 'text-ink' : 'text-ink-3')} data-testid="secret-status">
        {secretText(state.secret)}
      </span>
      {/* Sichtbar nur „Ersetzen“/„Eintragen“; der Name nennt die Beschriftung mit, Stand und Hilfe als Beschreibung. */}
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`${definition.label} ${set ? 'ersetzen' : 'eintragen'}`}
        aria-describedby={`${statusId} ${describedBy}`}
        className="h-8 rounded-[8px] bg-surface-3 px-3 text-[12px] font-semibold text-ink transition-colors hover:bg-surface-4"
        data-testid="secret-replace"
      >
        {set ? 'Ersetzen' : 'Eintragen'}
      </button>
      {set && (
        <button
          type="button"
          onClick={() => onDraft(state.fallbackSecret?.set ? '' : null)}
          className={TEXT_BUTTON}
          data-testid="secret-remove"
        >
          Entfernen
        </button>
      )}
    </div>
  );
}

/** Notfallmodus: Software-Werte werden ignoriert – nur ansehen und löschen. */
function SafeModeValue({
  definition,
  state,
  draft,
  onDraft,
}: {
  definition: SettingDefinition;
  state: SettingState;
  draft: DraftValue;
  onDraft: (value: DraftValue) => void;
}) {
  const stored = state.stored;
  const storedText = stored ? (stored.secret ? secretText(stored.secret, 'gesetzt', 'leer') : formatValue(definition, stored.value)) : null;
  return (
    <div className="space-y-1 text-right text-[12.5px] text-ink-2">
      <p>
        Wirksam (aus {state.fallbackSource === 'env' ? 'der .env' : 'dem Standard'}):{' '}
        <span className="text-ink">
          {definition.type === 'secret' ? secretText(state.secret, 'gesetzt', 'nicht gesetzt') : formatValue(definition, state.value)}
        </span>
      </p>
      {storedText !== null && (
        <p className="flex flex-wrap items-center gap-x-3">
          <span>
            In der Software gespeichert, aber ignoriert: <span className="text-ink">{storedText}</span>
          </span>
          {draft === null ? (
            <button key="undo" type="button" onClick={() => onDraft(undefined)} className="text-[12.5px] text-ink-3 hover:text-ink-2">
              Wird gelöscht · rückgängig
            </button>
          ) : (
            <button
              key="delete"
              type="button"
              onClick={() => onDraft(null)}
              className="text-[12.5px] text-ink-3 hover:text-ink-2"
              data-testid="setting-delete-stored"
            >
              Löschen
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** Merkt sich die Modellliste für diese Sitzung – sie ändert sich höchstens stündlich. */
let modelsRequest: Promise<AnthropicModelsResponse> | null = null;
const OWN = '__eigene__';

/**
 * Modell per Auswahl statt Code abtippen (Wunsch des Nutzers 12.10.): Liste von `GET /api/settings/models`, neueste
 * zuerst, Anzeigename statt ID. „Andere Modell-ID …“ lässt ein Modell zu, das die Liste noch nicht kennt.
 */
function ModelSelect({
  id,
  value,
  onDraft,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  onDraft: (value: DraftValue) => void;
  describedBy: string;
  invalid: boolean;
}) {
  const [list, setList] = useState<AnthropicModelsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [own, setOwn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    modelsRequest ??= settingsApi.models();
    modelsRequest
      .then((response) => !cancelled && setList(response))
      .catch(() => {
        modelsRequest = null;
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const models = list?.models ?? [];
  const known = models.some((model) => model.id === value);
  // Ohne Liste oder bei einem unbekannten Wert: Textfeld, damit nichts verloren geht.
  if (failed || own || (list && value && !known)) {
    return (
      <span className="flex w-full flex-col items-end gap-1 sm:w-[300px]">
        <input
          id={id}
          type="text"
          value={value}
          onChange={(event) => onDraft(event.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          placeholder="z. B. claude-opus-5-5"
          className={cn(FIELD, 'w-full text-right')}
          data-testid="model-input"
        />
        {list && (
          <button
            type="button"
            className={cn(TEXT_BUTTON, 'text-[12px]')}
            onClick={() => {
              setOwn(false);
              if (!known) onDraft(models[0]?.id ?? value);
            }}
          >
            Aus der Liste wählen
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="flex w-full flex-col items-start gap-1 sm:w-[300px]">
      <select
        id={id}
        value={list ? value : ''}
        disabled={!list}
        onChange={(event) => (event.target.value === OWN ? setOwn(true) : onDraft(event.target.value))}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className={cn(FIELD, 'w-full cursor-pointer')}
        data-testid="model-select"
      >
        {!list && <option value="">Modelle werden geladen …</option>}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
        {list && <option value={OWN}>Andere Modell-ID …</option>}
      </select>
      {list && (
        <span className="text-[12px] text-ink-3" data-testid="model-source">
          {list.source === 'anthropic' ? `${models.length} Modelle, live von Anthropic` : list.notice}
          {value && ` · ${value}`}
        </span>
      )}
    </span>
  );
}
