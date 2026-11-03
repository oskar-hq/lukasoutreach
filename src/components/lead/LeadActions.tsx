import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CLOSED_LEAD_STAGES,
  LEAD_ACTION_RULES,
  LEAD_STAGE_LABELS,
  type BoardColumn,
  type CockpitLead,
  type LeadAction,
  type LeadActionRequest,
  type LeadDetailResponse,
} from '../../../shared/leads';
import { FOUNDER_IDS, FOUNDERS, otherFounder } from '../../data/founders';
import { cn } from '../../lib/cn';
import { HANDOVER_NOTE_MAX_LENGTH } from '../../../shared/crm';
import { HIRING_ROLE_MAX_LENGTH, metaAdsLabel } from '../../../shared/leadSearch';
import { DEAL_VALUE_MAX, type ManualMetaAds } from '../../../shared/leads';
import { metaPauseText } from '../../../shared/messages';
import { LEAD_FEEDBACK_REASONS, LEAD_FEEDBACK_REASON_LABELS, type LeadFeedbackInput } from '../../../shared/learning';
import { ApiError, boardApi, crmApi, leadsApi } from '../../lib/leadSearchApi';
import { metaStoppedText, readableError } from '../../lib/leadView';
import { MESSAGE_TEXT_LIMIT, useCockpit } from '../../state/cockpit';
import type { FounderId } from '../../state/types';
import { Kbd } from '../ui/Kbd';
import { Eyebrow } from './Eyebrow';
import { DeleteConfirm, useLeadDataActions } from './LeadDataActions';
import { FORM_LABELS, INSTANT_ACTIONS, type ActionForm, type PrimaryAction } from './leadStage';
import { SheetItem, SheetList } from './PanelSheet';

const NEXT_STEP_LIMIT = 200;

/** Darf die Aktion aus der aktuellen Stufe gemeldet werden? (`LEAD_ACTION_RULES`, wie im Backend.) */
export function actionAllowed(lead: CockpitLead, action: LeadAction): boolean {
  const rule = LEAD_ACTION_RULES[action];
  return rule.from === 'any' || rule.from.includes(lead.stage);
}

const FORMS: Record<ActionForm, { action: LeadAction; placeholder: string; required: boolean; submit: string }> = {
  note: { action: 'note', placeholder: 'Was ist passiert, was ist wichtig?', required: true, submit: 'Notiz speichern' },
  // Auf LinkedIn geschrieben, ohne dass die Aufgabe heute im Stapel war (z. B. ein Lead außerhalb des Tageslimits).
  message: { action: 'message_sent', placeholder: 'Was hast du auf LinkedIn geschrieben? (optional)', required: false, submit: 'Nachricht eintragen' },
  reply: { action: 'message_received', placeholder: 'Antwort aus LinkedIn hier einfügen …', required: true, submit: 'Antwort eintragen' },
  meeting: { action: 'meeting_booked', placeholder: 'Wann und wie? (optional)', required: false, submit: 'Termin eintragen' },
  handover: { action: 'handed_over', placeholder: 'Notiz für Close (optional), z. B. „Termin Do. 10 Uhr“', required: false, submit: 'An Close übergeben' },
  lost: { action: 'lost', placeholder: 'Grund (optional)', required: false, submit: 'Als verloren eintragen' },
};

/** Welche Text-Formulare in dieser Stufe gehen (Notiz immer). `crmMode !== null`: Übergabe möglich. */
export function formAllowed(lead: CockpitLead, form: ActionForm, canHandOver: boolean): boolean {
  if (form === 'handover') return canHandOver && actionAllowed(lead, 'handed_over');
  if (form === 'lost') return !CLOSED_LEAD_STAGES.includes(lead.stage);
  return actionAllowed(lead, FORMS[form].action);
}

/** Sheet-Titel eines Formulars – ohne Close-Anbindung heißt die Übergabe anders. */
export function formTitle(form: ActionForm, viaClose: boolean): string {
  return form === 'handover' && !viaClose ? 'Übergabe eintragen' : FORM_LABELS[form];
}

/** Speichern im Panel: ein Request zur Zeit, Fehler als Satz. */
export function useLeadRun(lead: CockpitLead) {
  const { mutateLead } = useCockpit();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** true, wenn gespeichert. */
  const run = async (request: () => Promise<LeadDetailResponse>, messageSent = false): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await mutateLead(request, lead.id, { messageSent });
      return true;
    } catch (failure) {
      setError(failure instanceof ApiError ? readableError(failure, 'Das hat nicht geklappt.') : 'Keine Verbindung – nichts gespeichert.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, setError };
}

export type LeadRun = ReturnType<typeof useLeadRun>;

/** Felder, die sich im Panel bearbeiten lassen – je eine Zeile unter „Daten“, bearbeitet im Sheet. */
export type DataField = 'next' | 'deal' | 'meta' | 'hiring' | 'followUp' | 'owner';

export const FIELD_LABELS: Record<DataField, string> = {
  next: 'Nächster Schritt',
  deal: 'Deal Value',
  meta: 'Meta-Ads',
  hiring: 'Sucht Mitarbeiter',
  followUp: 'Follow-up',
  owner: 'Zuständig',
};

const germanDay = (at: number) => new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const HIRING_SOURCE: Record<NonNullable<CockpitLead['hiring']>['source'], string> = {
  profile: 'laut Profil',
  ai: 'laut KI',
  manual: 'von Hand',
};

function metaSummary(lead: CockpitLead): string {
  if (!lead.metaAds) return 'nicht geprüft';
  return lead.metaAds.state === 'stopped' ? metaStoppedText(lead.metaAds.lastStop) : metaAdsLabel(lead.metaAds);
}

/**
 * „Daten“: nächster Schritt, Deal Value, Meta-Ads, Hiring, Zuständig (und die Board-Spalte, falls es eigene gibt).
 * Eine Zeile pro Feld, Tippen öffnet das Sheet zum Bearbeiten. Ohne Rechte (Mitarbeiter, fremder Lead) nur lesen.
 */
export function DataRows({
  lead,
  disabled,
  readOnly,
  onEdit,
  onBoardColumn,
}: {
  lead: CockpitLead;
  disabled: boolean;
  readOnly: boolean;
  onEdit: (field: DataField) => void;
  onBoardColumn: (value: string | null) => void;
}) {
  const metaKnown = !!lead.metaAds && lead.metaAds.state !== 'unchecked';
  const rows: { field: DataField; testId: string; value: ReactNode; empty: boolean; title?: string }[] = [
    { field: 'next', testId: 'next-step', value: lead.nextStep ?? 'noch keiner', empty: !lead.nextStep },
    {
      field: 'deal',
      testId: 'deal-value',
      value: lead.dealValue != null ? <span className="tabular-nums">{euro.format(lead.dealValue)}</span> : 'noch keiner',
      empty: lead.dealValue == null,
    },
    {
      field: 'meta',
      testId: 'meta-ads',
      value: (
        <>
          {metaSummary(lead)}
          {lead.metaAds?.manual ? <span className="text-ink-3"> · von Hand</span> : null}
          {lead.metaAds?.source === 'person' ? <span className="text-ink-3"> · über den privaten Namen</span> : null}
        </>
      ),
      empty: !metaKnown,
    },
    {
      field: 'hiring',
      testId: 'hiring',
      value: lead.hiring ? (
        <>
          {lead.hiring.role ?? 'ja'}
          <span className="text-ink-3"> · {HIRING_SOURCE[lead.hiring.source]}</span>
        </>
      ) : (
        'kein Hinweis'
      ),
      empty: !lead.hiring,
      title: lead.hiring?.evidence ?? undefined,
    },
    {
      field: 'followUp',
      testId: 'follow-up-plan',
      // Wiedervorlage (22.10.): bis zum Tag pausiert, dann wieder in den Aufgaben – mit oder ohne Spalte.
      value: lead.followUpPlan
        ? `pausiert bis ${germanDay(lead.followUpPlan.at)}${lead.followUpPlan.columnName ? ` · ${lead.followUpPlan.columnName}` : ''}`
        : lead.followUpDueAt
          ? 'fällig – steht in den Aufgaben'
          : 'keins geplant',
      empty: !lead.followUpPlan && !lead.followUpDueAt,
    },
    { field: 'owner', testId: 'owner', value: FOUNDERS[lead.owner].name, empty: false },
  ];

  return (
    <section aria-labelledby="lead-data-title" data-testid="lead-data">
      <Eyebrow id="lead-data-title">Daten</Eyebrow>
      <div className="overflow-hidden rounded-2xl bg-surface-3">
        {rows.map((row) => {
          const content = (
            <>
              <span className="w-[126px] shrink-0 text-ink-2">{FIELD_LABELS[row.field]}</span>
              <span className={cn('min-w-0 flex-1 break-words py-3 sm:py-2.5', row.empty ? 'text-ink-3' : 'text-ink')}>{row.value}</span>
            </>
          );
          const rowClass = 'flex min-h-[50px] w-full items-center gap-2.5 border-b border-white/[0.05] px-3.5 text-left text-[14px] sm:min-h-[44px]';
          return readOnly ? (
            <div key={row.field} className={rowClass} data-testid={row.testId} title={row.title}>
              {content}
            </div>
          ) : (
            <button
              key={row.field}
              type="button"
              onClick={() => onEdit(row.field)}
              disabled={disabled}
              title={row.title}
              data-testid={row.testId}
              aria-label={`${FIELD_LABELS[row.field]} ändern`}
              className={cn(rowClass, 'group transition-colors hover:bg-white/[0.03] disabled:cursor-not-allowed')}
            >
              {content}
              <span aria-hidden className="text-[18px] text-ink-4 transition-colors group-hover:text-ink-2">
                ›
              </span>
            </button>
          );
        })}
        <BoardColumnRow lead={lead} disabled={disabled || readOnly} onSave={onBoardColumn} />
      </div>
    </section>
  );
}

/** Eigene Board-Spalte wählen (auch ohne Ziehen, z. B. per Tastatur oder auf dem Handy). Nur, wenn es Spalten gibt. */
function BoardColumnRow({ lead, disabled, onSave }: { lead: CockpitLead; disabled: boolean; onSave: (value: string | null) => void }) {
  const [columns, setColumns] = useState<BoardColumn[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    boardApi
      .columns()
      .then((response) => !cancelled && setColumns(response.columns))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!columns?.length) return null;
  return (
    <label className="flex min-h-[50px] w-full items-center gap-2.5 px-3.5 text-[14px]">
      <span className="w-[126px] shrink-0 text-ink-2">Spalte im Board</span>
      {/* Natives Auswahlfeld: auf dem iPhone das System-Rad. */}
      <select
        value={lead.boardColumn ?? ''}
        disabled={disabled}
        onChange={(event) => onSave(event.target.value || null)}
        className="min-w-0 flex-1 appearance-none bg-transparent py-3 text-[14px] text-ink outline-none disabled:opacity-60"
        data-testid="board-column-select"
      >
        <option value="">Nach Stufe ({LEAD_STAGE_LABELS[lead.stage]})</option>
        {columns.map((column) => (
          <option key={column.id} value={column.id}>
            {column.name}
          </option>
        ))}
      </select>
      <span aria-hidden className="text-[18px] text-ink-4">
        ›
      </span>
    </label>
  );
}

// Handy: 16 px (sonst zoomt iOS beim Fokus), Desktop kompakter.
const FIELD_INPUT =
  'h-12 w-full rounded-[14px] border border-white/[0.08] bg-surface-4/60 px-3.5 text-[16px] text-ink outline-none placeholder:text-ink-3 focus:border-accent sm:h-10 sm:rounded-xl sm:text-[14px]';

/** Weißer Knopf über die ganze Breite – die Haupt-Aktion im Sheet. */
function SheetSubmit({ children, disabled, testId, busy, kbd = '↵' }: { children: ReactNode; disabled?: boolean; testId?: string; busy?: boolean; kbd?: string }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-busy={busy}
      data-testid={testId}
      className="mt-2.5 inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-[14px] bg-ink text-[16px] font-bold text-black transition-transform active:scale-[0.98] disabled:opacity-40 sm:h-10 sm:rounded-xl sm:text-[14px]"
    >
      {children}
      {kbd && <Kbd tone="dark">{kbd}</Kbd>}
    </button>
  );
}

function SheetSecondary({ children, onClick, disabled, testId }: { children: ReactNode; onClick: () => void; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="mt-2 h-[46px] w-full rounded-[14px] text-[15px] font-semibold text-ink-2 transition-colors hover:text-ink disabled:opacity-40 sm:mt-1 sm:h-9 sm:text-[13.5px]"
    >
      {children}
    </button>
  );
}

/** Inhalt des Bearbeiten-Sheets für ein Feld. `onDone` schließt das Sheet. */
export function FieldEditor({ field, lead, runner, onDone }: { field: DataField; lead: CockpitLead; runner: LeadRun; onDone: () => void }) {
  return (
    <>
      <FieldEditorBody field={field} lead={lead} runner={runner} onDone={onDone} />
      {runner.error && <SheetError>{runner.error}</SheetError>}
    </>
  );
}

function FieldEditorBody({ field, lead, runner, onDone }: { field: DataField; lead: CockpitLead; runner: LeadRun; onDone: () => void }) {
  const save = (patch: Parameters<typeof leadsApi.update>[1]) => runner.run(() => leadsApi.update(lead.id, patch)).then((ok) => ok && onDone());
  switch (field) {
    case 'next':
      return <NextStepEditor lead={lead} busy={runner.busy} onSave={(nextStep) => save({ nextStep })} onDone={onDone} />;
    case 'deal':
      return <DealValueEditor lead={lead} busy={runner.busy} onSave={(dealValue) => save({ dealValue })} onDone={onDone} />;
    case 'meta':
      return <MetaAdsEditor lead={lead} busy={runner.busy} onSave={(metaAds) => save({ metaAds })} />;
    case 'hiring':
      return <HiringEditor lead={lead} busy={runner.busy} onSave={(hiring) => save({ hiring })} />;
    case 'followUp':
      return <FollowUpEditor lead={lead} busy={runner.busy} onSave={(followUpPlan) => save({ followUpPlan })} />;
    case 'owner':
      return (
        <SheetList>
          {FOUNDER_IDS.map((id: FounderId) => (
            <SheetItem
              key={id}
              checked={lead.owner === id}
              disabled={runner.busy}
              testId={`owner-${id}`}
              onClick={() => (lead.owner === id ? onDone() : void save({ owner: id }))}
            >
              {FOUNDERS[id].name}
            </SheetItem>
          ))}
        </SheetList>
      );
  }
}

/** Schnellwahl (22.10.: auch Tage) – jedes andere Datum geht über das Feld „Ab dem“. */
const FOLLOW_UP_PRESETS: { label: string; days?: number; months?: number }[] = [
  { label: '2 Tage', days: 2 },
  { label: '4 Tage', days: 4 },
  { label: '1 Woche', days: 7 },
  { label: '2 Wochen', days: 14 },
];

/** „JJJJ-MM-TT“ in Ortszeit. */
function dateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function presetDate(preset: (typeof FOLLOW_UP_PRESETS)[number]): string {
  const date = new Date();
  if (preset.days) date.setDate(date.getDate() + preset.days);
  if (preset.months) date.setMonth(date.getMonth() + preset.months);
  return dateInput(date);
}

/**
 * Follow-up planen (Wunsch des Nutzers 20.10., Wiedervorlage 22.10.): Datum (Schnellwahl oder frei), optional eine
 * eigene Board-Spalte. Bis zum Tag pausiert der Lead (keine Aufgaben), ab dem Tag (8 Uhr) steht er wieder in den
 * Aufgaben – auch nach allen Follow-ups oder als verlorener Lead. Vorgewählt: eine „Follow“-Spalte, sonst keine.
 */
function FollowUpEditor({ lead, busy, onSave }: { lead: CockpitLead; busy: boolean; onSave: (value: { at: number; column: string | null } | null) => void }) {
  const [columns, setColumns] = useState<BoardColumn[] | null>(null);
  const [date, setDate] = useState(lead.followUpPlan ? dateInput(new Date(lead.followUpPlan.at)) : presetDate(FOLLOW_UP_PRESETS[3]));
  const [column, setColumn] = useState(lead.followUpPlan?.column ?? '');
  useEffect(() => {
    let cancelled = false;
    boardApi
      .columns()
      .then((response) => {
        if (cancelled) return;
        setColumns(response.columns);
        // Wie bisher: eine Spalte mit „Follow“ im Namen vorgewählt (20.10.) – sonst keine.
        setColumn((current) => current || (response.columns.find((entry) => /follow/i.test(entry.name))?.id ?? ''));
      })
      .catch(() => !cancelled && setColumns([]));
    return () => {
      cancelled = true;
    };
  }, []);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!date) return;
        onSave({ at: new Date(`${date}T08:00`).getTime(), column: column || null });
      }}
      data-testid="follow-up-form"
    >
      <p className="mb-3 text-[13.5px] leading-relaxed text-ink-2">Bis dahin ist der Lead pausiert – ab dem Tag steht er wieder in deinen Aufgaben.</p>
      <div className="grid grid-cols-4 gap-1 rounded-[12px] bg-surface-4/60 p-[3px]">
        {FOLLOW_UP_PRESETS.map((preset) => {
          const value = presetDate(preset);
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={date === value}
              onClick={() => setDate(value)}
              className={cn('h-10 rounded-[9px] text-[13px] font-semibold transition-colors', date === value ? 'bg-white/[0.14] text-ink' : 'text-ink-2 hover:text-ink')}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <label className="mt-3 block text-[13px] font-medium text-ink-2">
        Ab dem
        <input
          type="date"
          value={date}
          min={dateInput(tomorrow)}
          onChange={(event) => setDate(event.target.value)}
          className={cn(FIELD_INPUT, 'mt-1.5')}
          data-testid="follow-up-date"
        />
      </label>
      {!!columns?.length && (
        <label className="mt-3 block text-[13px] font-medium text-ink-2">
          Im Board zusätzlich in die Spalte
          <select value={column} onChange={(event) => setColumn(event.target.value)} className={cn(FIELD_INPUT, 'mt-1.5 appearance-none')} data-testid="follow-up-column">
            <option value="">Keine – Stufe bleibt</option>
            {columns.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <SheetSubmit disabled={busy || !date} busy={busy} testId="follow-up-save">
        {busy ? 'Wird gespeichert …' : 'Follow-up planen'}
      </SheetSubmit>
      {lead.followUpPlan && (
        <SheetSecondary onClick={() => onSave(null)} disabled={busy} testId="follow-up-remove">
          Geplantes Follow-up entfernen
        </SheetSecondary>
      )}
    </form>
  );
}

/** Nächster Schritt: ein Satz. ↵ speichert, Esc verwirft (schließt das Sheet). */
function NextStepEditor({ lead, busy, onSave, onDone }: { lead: CockpitLead; busy: boolean; onSave: (value: string | null) => void; onDone: () => void }) {
  const [value, setValue] = useState(lead.nextStep ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const next = value.trim() || null;
        if (next === (lead.nextStep ?? null)) onDone();
        else onSave(next);
      }}
    >
      <input
        autoFocus
        value={value}
        maxLength={NEXT_STEP_LIMIT}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Nächster Schritt"
        placeholder="z. B. Termin Do. 10 Uhr bestätigen"
        className={FIELD_INPUT}
      />
      <SheetSubmit disabled={busy} busy={busy}>
        {busy ? 'Wird gespeichert …' : 'Speichern'}
      </SheetSubmit>
    </form>
  );
}

/** Deal Value (11.10.): ganze Euro. Leer = keiner. Zählt im Dashboard. */
function DealValueEditor({ lead, busy, onSave, onDone }: { lead: CockpitLead; busy: boolean; onSave: (value: number | null) => void; onDone: () => void }) {
  const current = lead.dealValue ?? null;
  const [value, setValue] = useState(current === null ? '' : String(current));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // „25.000“ oder „25000 €“ – nur die Ziffern zählen.
        const digits = value.replace(/\D/g, '');
        const next = digits ? Math.min(DEAL_VALUE_MAX, Number(digits)) : null;
        if (next === current) onDone();
        else onSave(next);
      }}
    >
      <div className="relative">
        <input
          autoFocus
          value={value}
          inputMode="numeric"
          maxLength={14}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Deal Value in Euro"
          placeholder="z. B. 25000"
          className={cn(FIELD_INPUT, 'pr-9 tabular-nums')}
          data-testid="deal-value-input"
        />
        <span aria-hidden className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[16px] text-ink-3">
          €
        </span>
      </div>
      <SheetSubmit disabled={busy} busy={busy} testId="deal-value-save">
        {busy ? 'Wird gespeichert …' : 'Speichern'}
      </SheetSubmit>
    </form>
  );
}

const META_OPTIONS: { value: ManualMetaAds['state']; label: string }[] = [
  { value: 'none', label: 'Nie geschaltet' },
  { value: 'stopped', label: 'Aus' },
  { value: 'active', label: 'Läuft' },
];

/**
 * Meta-Ads von Hand (11.10.): Ohne Meta-Token prüft niemand, ob die Firma Anzeigen schaltet. Hier eintragen – „Aus“ mit
 * Datum macht den Lead zur Reactivation (andere Erstnachricht, {{metapause}} = „seit rund 4 Monaten“).
 */
function MetaAdsEditor({ lead, busy, onSave }: { lead: CockpitLead; busy: boolean; onSave: (value: ManualMetaAds) => void }) {
  const known = lead.metaAds && lead.metaAds.state !== 'unchecked' ? lead.metaAds.state : null;
  const [state, setState] = useState<ManualMetaAds['state']>(known ?? 'stopped');
  const [lastStop, setLastStop] = useState(lead.metaAds?.lastStop ?? '');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(state === 'stopped' ? { state, lastStop: lastStop || null } : { state });
      }}
      data-testid="meta-ads-form"
    >
      <div role="radiogroup" aria-label="Meta-Ads" className="grid grid-cols-3 gap-1 rounded-[12px] bg-surface-4/60 p-[3px]">
        {META_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={state === option.value}
            onClick={() => setState(option.value)}
            className={cn(
              'h-10 rounded-[9px] text-[14px] font-semibold transition-colors',
              state === option.value ? 'bg-white/[0.14] text-ink' : 'text-ink-2 hover:text-ink',
            )}
            data-testid={`meta-ads-${option.value}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {state === 'stopped' && (
        <label className="mt-3 block text-[13px] text-ink-2">
          <span className="mx-1 mb-1.5 block">Aus seit</span>
          <input
            type="date"
            value={lastStop}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(event) => setLastStop(event.target.value)}
            className={FIELD_INPUT}
            data-testid="meta-ads-since"
          />
          <span className="mx-1 mt-1.5 block">{lastStop ? metaPauseText(lastStop) : 'Datum unbekannt → „seit einiger Zeit“'}</span>
        </label>
      )}
      <SheetSubmit disabled={busy} busy={busy} testId="meta-ads-save">
        {busy ? 'Wird gespeichert …' : 'Speichern'}
      </SheetSubmit>
    </form>
  );
}

/**
 * Hiring-Signal (Wunsch des Nutzers 13.10.): Sucht die Firma Mitarbeiter, schlägt die Erstnachricht eine Recruiting-
 * Vorlage vor ({{stelle}} = „Verstärkung als …“). Die Lead-Suche erkennt es aus dem Profil oder per KI – hier von Hand
 * eintragen, ändern oder entfernen.
 */
function HiringEditor({ lead, busy, onSave }: { lead: CockpitLead; busy: boolean; onSave: (value: { role: string | null } | null) => void }) {
  const hiring = lead.hiring ?? null;
  const [role, setRole] = useState(hiring?.role ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ role: role.trim() || null });
      }}
      data-testid="hiring-form"
    >
      <input
        type="text"
        autoFocus
        value={role}
        maxLength={HIRING_ROLE_MAX_LENGTH}
        aria-label="Sucht Mitarbeiter als"
        placeholder="Stelle, z. B. Vertriebsmitarbeiter (m/w/d)"
        onChange={(event) => setRole(event.target.value)}
        className={FIELD_INPUT}
        data-testid="hiring-role"
      />
      <p className="mx-1 mt-1.5 text-[12.5px] leading-snug text-ink-3">
        Die Erstnachricht schlägt dann die Recruiting-Vorlage vor. Stelle leer lassen, wenn sie unbekannt ist.
      </p>
      <SheetSubmit disabled={busy} busy={busy} testId="hiring-save">
        {busy ? 'Wird gespeichert …' : 'Speichern'}
      </SheetSubmit>
      {hiring && (
        <SheetSecondary onClick={() => onSave(null)} disabled={busy} testId="hiring-remove">
          Sucht niemanden
        </SheetSecondary>
      )}
    </form>
  );
}

/**
 * Lead-Qualität (Wunsch des Nutzers 13.10., `shared/learning.ts`): „Passt“ / „Passt nicht“ mit einem Klick – bei „Passt
 * nicht“ danach optional ein Grund (ein Klick). Erneuter Klick auf die gewählte Seite nimmt die Rückmeldung zurück.
 * Automatische Rückmeldungen (Antwort, Termin, Übergabe) stehen als „automatisch“ da und lassen sich überschreiben.
 * Fließt als Beispiel in die KI-Bewertung und in die Gewichtung der Suchanfragen.
 */
export function QualityFeedback({ lead, disabled, onSave }: { lead: CockpitLead; disabled: boolean; onSave: (value: LeadFeedbackInput | null) => void }) {
  const feedback = lead.feedback ?? null;
  const verdict = feedback?.verdict ?? null;
  const manual = feedback?.source === 'manual';
  const choose = (next: 'good' | 'bad') => onSave(verdict === next && manual ? null : { verdict: next });
  const options = [
    { value: 'good' as const, label: 'Passt', Icon: ThumbsUp, on: 'border-good bg-good/15' },
    { value: 'bad' as const, label: 'Passt nicht', Icon: ThumbsDown, on: 'border-bad bg-bad/15' },
  ];

  return (
    <section data-testid="lead-feedback" aria-labelledby="lead-feedback-title">
      <Eyebrow id="lead-feedback-title">Lead-Qualität bewerten</Eyebrow>
      <div role="radiogroup" aria-labelledby="lead-feedback-title" className="grid grid-cols-2 gap-2">
        {options.map(({ value, label, Icon, on }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={verdict === value}
            disabled={disabled}
            onClick={() => choose(value)}
            className={cn(
              'inline-flex h-[46px] items-center justify-center gap-2 rounded-xl border text-[15px] font-semibold sm:h-10 sm:text-[14px] text-ink transition-[background-color,border-color,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50',
              verdict === value ? on : 'border-white/[0.08] bg-surface-3 hover:bg-surface-4',
            )}
            data-testid={`lead-feedback-${value}`}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      {feedback && !manual && (
        <p className="mt-2 text-[12.5px] text-ink-3" data-testid="lead-feedback-auto">
          automatisch{feedback.outcome ? ` · ${feedback.outcome}` : ''}
        </p>
      )}
      {verdict === 'bad' && manual && (
        <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Grund" data-testid="lead-feedback-reasons">
          {LEAD_FEEDBACK_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              aria-pressed={feedback?.reason === reason}
              disabled={disabled}
              onClick={() => onSave({ verdict: 'bad', reason: feedback?.reason === reason ? null : reason })}
              className={cn(
                'h-8 rounded-full border px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                feedback?.reason === reason ? 'border-ink bg-ink text-black' : 'border-white/10 text-ink-2 hover:text-ink',
              )}
              data-testid={`lead-feedback-reason-${reason}`}
            >
              {LEAD_FEEDBACK_REASON_LABELS[reason]}
            </button>
          ))}
        </div>
      )}
      {verdict && <p className="mt-2 text-[12px] leading-snug text-ink-3">Die KI bekommt das bei der nächsten Suche als Beispiel mit.</p>}
    </section>
  );
}

/**
 * Text-Formular im Sheet (Notiz, Nachricht, Antwort, Termin, Übergabe, verloren). Mit Close-Anbindung legt das Backend
 * den Lead bei der Übergabe in Close an, sonst wird sie nur eingetragen. ⌘↵ speichert.
 */
export function ActionFormSheet({
  form,
  lead,
  runner,
  viaClose,
  locked,
  onDone,
}: {
  form: ActionForm;
  lead: CockpitLead;
  runner: LeadRun;
  viaClose: boolean;
  locked: boolean;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const spec = FORMS[form];
  const handoverByHand = form === 'handover' && !viaClose;
  const limit = form === 'handover' ? HANDOVER_NOTE_MAX_LENGTH : MESSAGE_TEXT_LIMIT;
  const tooLong = text.length > limit;
  const trimmed = text.trim();

  useEffect(() => fieldRef.current?.focus({ preventScroll: true }), []);
  // Im Textfeld macht ↵ eine neue Zeile – gespeichert wird mit ⌘↵ bzw. Strg+↵.
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Strg ';

  const submit = () => {
    if ((spec.required && !trimmed) || tooLong) return;
    const body: LeadActionRequest = { action: spec.action, ...(trimmed ? { text: trimmed } : {}) };
    void runner
      .run(
        () => (form === 'handover' && viaClose ? crmApi.handover(lead.id, trimmed ? { note: trimmed } : {}) : leadsApi.act(lead.id, body)),
        spec.action === 'message_sent',
      )
      .then((ok) => ok && onDone());
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {handoverByHand && <p className="mx-1 mb-2.5 text-[13px] text-ink-2">Close ist nicht angebunden – leg den Lead selbst in Close an, hier wird die Übergabe nur eingetragen.</p>}
      <textarea
        ref={fieldRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        aria-label={formTitle(form, viaClose)}
        rows={form === 'reply' || form === 'message' ? 5 : 4}
        placeholder={spec.placeholder}
        className="block w-full resize-none rounded-[14px] border border-white/[0.08] bg-surface-4/60 p-3 text-[16px] leading-[1.45] text-ink outline-none placeholder:text-ink-3 focus:border-accent sm:rounded-xl sm:text-[14px]"
        data-testid="action-text"
      />
      {tooLong && <p className="mx-1 mt-1 text-[12px] text-ink">Höchstens {limit.toLocaleString('de-DE')} Zeichen.</p>}
      {runner.error && <SheetError>{runner.error}</SheetError>}
      <SheetSubmit disabled={runner.busy || locked || tooLong || (spec.required && !trimmed)} busy={runner.busy} testId="action-submit" kbd={mod + '↵'}>
        {runner.busy ? 'Wird gespeichert …' : handoverByHand ? 'Als übergeben eintragen' : spec.submit}
      </SheetSubmit>
    </form>
  );
}

export function SheetError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mx-1 mt-2 flex items-baseline gap-2 text-[13px] text-ink">
      <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
      {children}
    </p>
  );
}

/**
 * Leiste unten im Panel: die eine Haupt-Aktion der Stufe (weiß), Notiz und „Mehr“. Abgeschlossene Leads haben keine
 * Haupt-Aktion – dort steht „Wieder öffnen“ grau.
 */
export function LeadFooter({
  primary,
  disabled,
  busy,
  onPrimary,
  onNote,
  onMore,
}: {
  primary: PrimaryAction;
  disabled: boolean;
  busy: boolean;
  onPrimary: () => void;
  onNote: () => void;
  onMore: () => void;
}) {
  const quiet = primary.kind === 'instant' && primary.action === 'reopened';
  const square =
    'flex h-[50px] w-[50px] shrink-0 items-center justify-center gap-1.5 rounded-[14px] bg-surface-4 text-[18px] text-ink transition-[background-color,transform] hover:bg-white/10 active:scale-[0.96] disabled:opacity-40 sm:h-11 sm:w-auto sm:min-w-11 sm:px-3 sm:text-[15px]';
  return (
    <div className="shrink-0 border-t border-white/[0.05] bg-surface-1" data-testid="lead-footer">
      {/* Desktop: rechtsbündig in der Inhaltsbreite, Haupt-Aktion nicht über die ganze Breite. */}
      <div className="mx-auto flex w-full max-w-[1120px] gap-2 px-4 pt-2.5 pb-3 sm:justify-end sm:px-8 sm:py-3">
        <button
          type="button"
          onClick={onPrimary}
          disabled={disabled}
          aria-busy={busy}
          data-testid={primary.testId}
          className={cn(
            'inline-flex h-[50px] min-w-0 flex-1 items-center justify-center gap-2 rounded-[14px] px-3 text-[16px] transition-transform active:scale-[0.98] disabled:opacity-40 sm:h-11 sm:max-w-[340px] sm:text-[15px]',
            quiet ? 'bg-surface-4 font-semibold text-ink hover:bg-white/10' : 'bg-ink font-bold text-black',
          )}
        >
          <span className="truncate">{primary.label}</span>
          <Kbd tone={quiet ? 'light' : 'dark'}>↵</Kbd>
        </button>
        <button type="button" onClick={onNote} disabled={disabled} title="Notiz (N)" aria-label="Notiz schreiben" data-testid="footer-note" className={square}>
          ✎<Kbd>N</Kbd>
        </button>
        <button type="button" onClick={onMore} title="Weitere Aktionen (M)" aria-label="Weitere Aktionen" data-testid="footer-more" className={square}>
          •••<Kbd>M</Kbd>
        </button>
      </div>
    </div>
  );
}

/** „Weitere Aktionen“: alles, was in dieser Stufe geht, außer der Haupt-Aktion – dazu Übergeben, Export, Löschen. */
export function MoreSheetContent({
  lead,
  primary,
  canHandOver,
  readOnly,
  disabled,
  onForm,
  onInstant,
  onOwner,
  onResetInvite,
  onDelete,
}: {
  lead: CockpitLead;
  primary: PrimaryAction;
  canHandOver: boolean;
  readOnly: boolean;
  disabled: boolean;
  onForm: (form: ActionForm) => void;
  onInstant: (action: (typeof INSTANT_ACTIONS)[number]['action']) => void;
  onOwner: (owner: FounderId) => void;
  /** „Vernetzt“ zurücknehmen (20.10.) – nur aus „Vernetzt“, solange noch nichts geschrieben ist. */
  onResetInvite: () => void;
  onDelete: () => void;
}) {
  const data = useLeadDataActions(lead);
  const other = otherFounder(lead.owner);
  const isPrimary = (testId: string) => primary.testId === testId;
  const forms = (['message', 'reply', 'meeting', 'handover'] as const).filter((form) => formAllowed(lead, form, canHandOver) && !isPrimary(`action-form-${form}`));
  const instants = INSTANT_ACTIONS.filter((entry) => actionAllowed(lead, entry.action) && !isPrimary(entry.testId));
  const lost = formAllowed(lead, 'lost', canHandOver);

  return (
    <>
      {!readOnly && (
        <SheetList>
          {instants.map((entry) => (
            <SheetItem key={entry.action} onClick={() => onInstant(entry.action)} disabled={disabled} testId={entry.testId}>
              {entry.label}
            </SheetItem>
          ))}
          {forms.map((form) => (
            <SheetItem key={form} onClick={() => onForm(form)} disabled={disabled} testId={`action-form-${form}`}>
              {FORM_LABELS[form]}
            </SheetItem>
          ))}
          {lead.stage === 'connected' && (
            <SheetItem onClick={onResetInvite} disabled={disabled} meta="Doch nicht vernetzt" testId="action-reset-invite">
              Zurück auf „Anfrage gesendet“
            </SheetItem>
          )}
          <SheetItem onClick={() => onOwner(other)} disabled={disabled} meta={`Zuständig: ${FOUNDERS[lead.owner].name}`} testId="action-owner">
            An {FOUNDERS[other].name} übergeben
          </SheetItem>
          {lost && (
            <SheetItem onClick={() => onForm('lost')} disabled={disabled} testId="action-form-lost">
              Als verloren markieren
            </SheetItem>
          )}
        </SheetList>
      )}
      {data.allowed && (
        <div className={cn(!readOnly && 'mt-3')}>
          <SheetList>
            <SheetItem onClick={() => void data.exportData()} disabled={data.busy !== null} testId="lead-export">
              {data.busy === 'export' ? 'Wird exportiert …' : 'Daten exportieren'}
            </SheetItem>
            <SheetItem onClick={onDelete} tone="bad" testId="lead-delete">
              Lead endgültig löschen
            </SheetItem>
          </SheetList>
          {data.error && <SheetError>{data.error}</SheetError>}
        </div>
      )}
    </>
  );
}

/** Lösch-Rückfrage im Sheet – eigener Hook-Zustand (busy, Fehler). */
export function DeleteSheetContent({ lead, onCancel }: { lead: CockpitLead; onCancel: () => void }) {
  const data = useLeadDataActions(lead);
  return <DeleteConfirm lead={lead} busy={data.busy === 'delete'} error={data.error} onConfirm={() => void data.remove()} onCancel={onCancel} />;
}
