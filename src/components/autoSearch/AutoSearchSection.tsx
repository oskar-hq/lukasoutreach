import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Play } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { FOUNDERS } from '../../data/founders';
import {
  AUTO_SEARCH_FOCUS_LABELS,
  autoSearchProblem,
  type AutoSearchListResponse,
  type AutoSearchSchedule,
  type AutoSearchUpdate,
  type Weekday,
} from '../../../shared/autoSearch';
import type { AuthFounderId } from '../../../shared/auth';
import {
  AUTO_SEARCH_DAILY_BUDGET_MAX,
  AUTO_SEARCH_DAILY_TARGET_MAX,
  AUTO_SEARCH_DEFAULT_DAILY_BUDGET_EUR,
  AUTO_SEARCH_DEFAULT_MAX_ROUNDS,
  AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
  AUTO_SEARCH_KAPITALANLAGE_PERCENT_STEP,
  AUTO_SEARCH_MAX_ROUNDS_LIMIT,
} from '../../../shared/autoSearch';
import { MAX_RESULTS_LIMIT } from '../../../shared/leadSearch';
import { cn } from '../../lib/cn';
import { HEADING, LABEL } from '../settings/look';
import { ApiError, autoSearchApi } from '../../lib/leadSearchApi';
import { useHotkeys } from '../../lib/useHotkeys';
import { useAccess, useAuth } from '../../state/auth';
import { useDemo } from '../../state/demo';
import { Spinner } from '../leadSearch/Funnel';
import { DelayedStatus } from '../stack/FocusView';
import { Button } from '../ui/Button';
import { DisclosureToggle } from '../ui/Disclosure';
import { Segmented } from '../ui/Segmented';
import { FIELD_INPUT, Field, Stepper, TermField } from './ProfileInputs';
import { WEEKDAYS, formatNextRun, lastRunText, todayText } from './format';
import { EASE_OUT } from '../../lib/motion';

/** So oft wird der Stand neu geladen, solange ein Lauf arbeitet. */
const POLL_MS = 5_000;
/** So lange wird nach „Jetzt einmal ausführen“ höchstens auf den Lauf im Stand gewartet. */
const PENDING_RUN_MS = 60_000;
/** So lange bleibt „Gespeichert“ stehen. */
const SAVED_MS = 4_000;

/** Stelle im Formular, an der eine Meldung erscheint. */
type Slot = 'days' | 'time' | 'secondTime' | 'keywords' | 'positions' | 'region' | 'maxResults' | 'profile';

const SLOT_SELECTOR: Record<Slot, string> = {
  days: '[data-testid="auto-days"] button',
  time: '[data-testid="auto-time"]',
  secondTime: '[data-testid="auto-second-time"]',
  keywords: '[data-testid="auto-keywords"] input',
  positions: '[data-testid="auto-positions"] input',
  region: '[data-testid="auto-region"]',
  maxResults: '[data-testid="auto-max-results-input"]',
  profile: '[data-testid="auto-keywords"] input',
};

/** Diese Stellen liegen im zuklappbaren Suchprofil. */
const PROFILE_SLOTS: Slot[] = ['keywords', 'positions', 'region', 'maxResults', 'profile'];

function toUpdate(schedule: AutoSearchSchedule): AutoSearchUpdate {
  const { enabled, days, time, profile } = schedule;
  return {
    enabled,
    days: [...days],
    time,
    secondTime: schedule.secondTime ?? null,
    profile: { ...profile, keywords: [...profile.keywords], positions: [...profile.positions] },
    dailyTarget: schedule.dailyTarget ?? null,
    maxRounds: schedule.maxRounds ?? AUTO_SEARCH_DEFAULT_MAX_ROUNDS,
    // Noch nie gespeichert → mit KI-Tagesbudget vorbelegen (Geld statt Läufe, Wunsch des Nutzers 11.10.).
    dailyBudgetEur: schedule.dailyBudgetEur !== undefined && (schedule.dailyBudgetEur !== null || schedule.updatedAt !== null) ? schedule.dailyBudgetEur : AUTO_SEARCH_DEFAULT_DAILY_BUDGET_EUR,
    kapitalanlagePercent: schedule.kapitalanlagePercent ?? AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
  };
}

/** So geht der Plan an den Server: Tage sortiert ohne Doppelte, Begriffe und Region ohne Leerraum. */
function normalize(update: AutoSearchUpdate): AutoSearchUpdate {
  const clean = (words: string[]) => words.map((word) => word.trim()).filter(Boolean);
  return {
    enabled: update.enabled,
    days: [...new Set(update.days)].sort((a, b) => a - b),
    time: update.time.trim(),
    // Leeres Feld = kein zweiter Termin.
    secondTime: update.secondTime?.trim() ? update.secondTime.trim() : null,
    profile: {
      keywords: clean(update.profile.keywords),
      positions: clean(update.profile.positions),
      region: update.profile.region.trim(),
      maxResults: update.profile.maxResults,
    },
    dailyTarget: update.dailyTarget ?? null,
    maxRounds: update.maxRounds ?? AUTO_SEARCH_DEFAULT_MAX_ROUNDS,
    dailyBudgetEur: update.dailyBudgetEur ?? null,
    kapitalanlagePercent: update.kapitalanlagePercent ?? AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
  };
}

const same = (a: AutoSearchUpdate, b: AutoSearchUpdate) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/** Das Problem gehört an das Feld, das es auslöst (`AutoSearchField` wie in den 400-Antworten). */
function problemSlot(problem: NonNullable<ReturnType<typeof autoSearchProblem>>): Slot {
  return serverSlot(problem.field) ?? 'profile';
}

/** `field` aus einer 400-Antwort, z. B. „days“ oder „profile.maxResults“. */
function serverSlot(field: string | undefined): Slot | null {
  if (field === 'days' || field === 'time' || field === 'secondTime') return field;
  if (!field?.startsWith('profile')) return null;
  const sub = field.split('.')[1];
  return sub === 'keywords' || sub === 'positions' || sub === 'region' || sub === 'maxResults' ? sub : 'profile';
}

function loadErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'Die automatische Suche gibt es auf diesem Server noch nicht – sie kommt mit dem nächsten Update.';
  }
  if (error instanceof ApiError && error.code !== 'offline' && error.code !== 'error') return error.message;
  return 'Der Zeitplan ließ sich nicht laden. Ist der Server erreichbar?';
}

type Note = { founder: AuthFounderId; tone: 'good' | 'bad'; text: string; id: number; runId?: string };

/**
 * Einstellungen → „Automatische Suche“ (`shared/autoSearch.ts`): Zeitplan und Suchprofil je Gründer.
 * Gründer sehen nur ihren Plan, Admins wählen Nick oder Johannes. Bleibt beim Wechseln der Reiter geladen.
 */
export function AutoSearchSection({ active }: { active: boolean }) {
  const access = useAccess();
  const { adminFounder } = useAuth();
  const { state, dispatch } = useDemo();
  const base = useId();
  const formRef = useRef<HTMLFormElement>(null);

  const [data, setData] = useState<AutoSearchListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [picked, setPicked] = useState<AuthFounderId | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<AuthFounderId, AutoSearchUpdate>>>({});
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<(Note & { slot: Slot | null }) | null>(null);
  const [saved, setSaved] = useState<Note | null>(null);
  const [saving, setSaving] = useState(false);
  const [runNote, setRunNote] = useState<Note | null>(null);
  const [starting, setStarting] = useState(false);
  const [pendingRun, setPendingRun] = useState<{ founder: AuthFounderId; runId: string } | null>(null);
  /** Suchprofil aufgeklappt – bleibt beim Wechsel zwischen Nick und Johannes. */
  const [profileOpen, setProfileOpen] = useState(false);
  const noteId = useRef(0);
  /** Jede Ladung und jedes Speichern zählt hoch – ältere Antworten überschreiben nichts. */
  const loadSeq = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const seq = ++loadSeq.current;
    try {
      const response = await autoSearchApi.list();
      if (seq !== loadSeq.current) return;
      setData(response);
      setLoadError(null);
    } catch (error) {
      // Beim Nachladen im Hintergrund bleibt der bisherige Stand stehen.
      if (seq !== loadSeq.current || quiet) return;
      setLoadError(loadErrorText(error));
    }
  }, []);

  // Beim Öffnen des Reiters frisch laden (der andere Gründer oder ein Lauf hat vielleicht etwas geändert).
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  // Späte Antworten nach dem Verlassen verwerfen.
  useEffect(() => () => void ++loadSeq.current, []);

  const schedules = data?.schedules ?? [];
  const preferred = picked ?? (access.role === 'admin' ? adminFounder : access.founder);
  const schedule = schedules.find((entry) => entry.founder === preferred) ?? schedules[0] ?? null;
  const founder = schedule?.founder ?? null;
  const draft = founder && schedule ? (drafts[founder] ?? toUpdate(schedule)) : null;
  const dirty = !!founder && drafts[founder] !== undefined;
  const running = schedule?.lastRun?.status === 'running';
  // Pause zwischen zwei Läufen fürs Tagesziel: die Suche ist noch dran, auch wenn gerade nichts läuft (22.10.).
  const anyRunning = schedules.some((entry) => entry.lastRun?.status === 'running' || !!entry.followUpAt);
  const own = access.role !== 'admin' || (access.user?.founder ?? null) === founder;
  const founderName = founder ? FOUNDERS[founder].name : '';
  const stack = own ? 'den Tagesstapel' : `den Tagesstapel von ${founderName}`;

  // Solange ein Lauf arbeitet, einer eingereiht ist oder gerade gestartet wurde, alle 5 s nachsehen – nur bei offenem Reiter.
  const watching = anyRunning || pendingRun !== null;
  useEffect(() => {
    if (!active || !watching) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, watching, load]);

  // Gestarteter Lauf ist im Stand angekommen → nicht mehr extra warten; ist er fertig, Bestätigung ausblenden.
  useEffect(() => {
    if (pendingRun) {
      const entry = schedules.find((candidate) => candidate.founder === pendingRun.founder);
      if (entry?.lastRun?.runId === pendingRun.runId) setPendingRun(null);
    }
    if (runNote?.runId) {
      const entry = schedules.find((candidate) => candidate.founder === runNote.founder);
      if (entry?.lastRun?.runId === runNote.runId && entry.lastRun.status !== 'running') setRunNote(null);
    }
  }, [schedules, pendingRun, runNote]);
  useEffect(() => {
    if (!pendingRun) return;
    const timer = window.setTimeout(() => setPendingRun(null), PENDING_RUN_MS);
    return () => window.clearTimeout(timer);
  }, [pendingRun]);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const problem = draft ? autoSearchProblem(normalize(draft)) : null;
  const localSlot = tried && problem && draft ? problemSlot(problem) : null;
  const ownServerError = serverError && serverError.founder === founder ? serverError : null;
  const errorAt = (slot: Slot): string | null =>
    localSlot === slot ? problem!.message : !localSlot && ownServerError?.slot === slot ? ownServerError.text : null;

  const focusSlot = (slot: Slot) =>
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(SLOT_SELECTOR[slot])?.focus());
  /** Fehler im Suchprofil: erst aufklappen, dann fokussieren – nie aus dem Fehler ableiten. */
  const reveal = (slot: Slot) => {
    if (PROFILE_SLOTS.includes(slot)) setProfileOpen(true);
    focusSlot(slot);
  };
  const profileError = PROFILE_SLOTS.map(errorAt).find(Boolean) ?? null;

  const change = (patch: Partial<Omit<AutoSearchUpdate, 'profile'>> & { profile?: Partial<AutoSearchUpdate['profile']> }) => {
    if (!founder || !schedule || !draft) return;
    const next: AutoSearchUpdate = { ...draft, ...patch, profile: { ...draft.profile, ...patch.profile } };
    setDrafts((current) => {
      const copy = { ...current };
      if (same(next, toUpdate(schedule))) delete copy[founder];
      else copy[founder] = next;
      return copy;
    });
    setServerError(null);
    setSaved(null);
  };

  const discard = () => {
    if (!founder) return;
    setDrafts((current) => {
      const copy = { ...current };
      delete copy[founder];
      return copy;
    });
    setServerError(null);
    setTried(false);
  };

  const saveRef = useRef<() => Promise<void>>(async () => {});
  const save = async () => {
    if (!founder || !draft || saving || !dirty) return;
    const body = normalize(draft);
    const found = autoSearchProblem(body);
    if (found) {
      setTried(true);
      reveal(problemSlot(found));
      return;
    }
    const sent = drafts[founder];
    setSaving(true);
    setServerError(null);
    setSaved(null);
    try {
      const result = await autoSearchApi.update(founder, body);
      // Ein noch laufendes Nachladen kennt den neuen Stand nicht.
      ++loadSeq.current;
      setData((current) => current && { ...current, schedules: current.schedules.map((entry) => (entry.founder === result.founder ? result : entry)) });
      // Nur den gesendeten Entwurf entfernen – was währenddessen geändert wurde, bleibt.
      setDrafts((current) => {
        if (current[founder] !== sent) return current;
        const copy = { ...current };
        delete copy[founder];
        return copy;
      });
      setTried(false);
      setSaved({
        founder,
        tone: 'good',
        text: result.enabled && result.nextRunAt ? `Gespeichert – nächster Lauf ${formatNextRun(result.nextRunAt)}.` : 'Gespeichert – die automatische Suche ist aus.',
        id: ++noteId.current,
      });
    } catch (error) {
      const slot = error instanceof ApiError ? serverSlot(error.field) : null;
      const text =
        error instanceof ApiError && error.code === 'offline'
          ? 'Keine Verbindung – nicht gespeichert.'
          : error instanceof ApiError && error.code !== 'error'
            ? error.message
            : 'Nicht gespeichert.';
      setServerError({ founder, tone: 'bad', text, slot, id: ++noteId.current });
      if (slot) reveal(slot);
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  const runNow = async () => {
    if (!founder || starting || running) return;
    setStarting(true);
    setRunNote(null);
    try {
      const { runId } = await autoSearchApi.run(founder);
      setRunNote({ founder, tone: 'good', text: `Läuft – die Leads kommen danach in ${stack}.`, runId, id: ++noteId.current });
      setPendingRun({ founder, runId });
      void load(true);
    } catch (error) {
      const text =
        error instanceof ApiError && error.code === 'offline'
          ? 'Keine Verbindung – nicht gestartet.'
          : error instanceof ApiError && error.code !== 'error'
            ? error.message
            : 'Die Suche konnte nicht gestartet werden.';
      setRunNote({ founder, tone: 'bad', text, id: ++noteId.current });
      // Belegt: Vielleicht läuft gerade der eigene Plan – den Stand zeigen.
      if (error instanceof ApiError && error.code === 'busy') void load(true);
    } finally {
      setStarting(false);
    }
  };

  useHotkeys({ enter: () => void save() }, active && dirty && !saving && !state.panelLeadId);

  const ownSaved = saved && saved.founder === founder ? saved : null;
  const generalError = ownServerError && !ownServerError.slot ? ownServerError : null;
  const barVisible = active && (dirty || !!ownSaved || !!generalError);
  // Unten liegt die Leiste – beim Tabben soll das fokussierte Feld nicht darunter verschwinden.
  useEffect(() => {
    if (!barVisible) return;
    document.documentElement.style.scrollPaddingBottom = '120px';
    return () => {
      document.documentElement.style.scrollPaddingBottom = '';
    };
  }, [barVisible]);

  if (!data) {
    return (
      <div className="py-16">
        {loadError ? (
          <>
            <p className="text-[15px] text-ink-2" role="alert" data-testid="auto-load-error">
              {loadError}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              disabled={reloading}
              onClick={async () => {
                setReloading(true);
                await load();
                setReloading(false);
              }}
            >
              {reloading ? 'Wird geladen …' : 'Erneut versuchen'}
            </Button>
          </>
        ) : (
          active && <DelayedStatus>Zeitplan wird geladen …</DelayedStatus>
        )}
      </div>
    );
  }

  if (!schedule || !draft || !founder) {
    return (
      <p className="py-16 text-[15px] text-ink-2" data-testid="auto-empty">
        Für dein Konto gibt es keinen Zeitplan.
      </p>
    );
  }

  const describe = (slot: Slot) => (errorAt(slot) ? `${base}-${slot}-error` : undefined);
  const toggleDay = (day: Weekday) =>
    change({ days: draft.days.includes(day) ? draft.days.filter((entry) => entry !== day) : [...draft.days, day].sort((a, b) => a - b) });
  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      // Erst nach dem Neuzeichnen speichern: Ein gerade getipptes Stichwort übernimmt das Eingabefeld im selben
      // Tastendruck – `save` aus diesem Render sähe es noch nicht.
      window.setTimeout(() => void saveRef.current());
    }
  };
  const showSwitch = schedules.length > 1;
  const lastRun = schedule.lastRun;
  const followUpAt = schedule.followUpAt ?? null;
  const lastTone = !lastRun ? null : lastRun.status === 'done' ? 'bg-good' : lastRun.status === 'failed' ? 'bg-bad' : 'bg-warn';
  const ownRunNote = runNote && runNote.founder === founder ? runNote : null;

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={onFormKeyDown}
      className="pb-40 pt-10"
      data-testid="auto-search"
    >
      {showSwitch && (
        <div className="mb-8 flex flex-wrap items-center gap-3">
          <span className={LABEL}>Plan von</span>
          <Segmented
            ariaLabel="Plan von"
            value={founder}
            onChange={(next) => {
              setPicked(next);
              setTried(false);
            }}
            options={schedules.map((entry) => ({
              value: entry.founder,
              label: FOUNDERS[entry.founder].name,
              // Ungespeicherte Änderungen beim anderen Gründer nicht vergessen lassen.
              highlight: drafts[entry.founder] !== undefined,
            }))}
          />
        </div>
      )}

      {/* Der große Knopf zuerst (Wunsch des Nutzers 23.10.). */}
      <div className="mb-10 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button
          variant="primary"
          size="lg"
          icon={starting ? <Spinner className="h-3 w-3" /> : <Play className="h-4 w-4" />}
          onClick={() => void runNow()}
          disabled={starting || running}
          title={schedule.dailyTarget ? `Sucht wie ein Termin weiter, bis ${schedule.dailyTarget} neue qualifizierte Leads da sind` : undefined}
          data-testid="auto-run"
        >
          {starting ? 'Wird gestartet …' : 'Jetzt einmal ausführen'}
        </Button>
        {ownRunNote && (
          <p
            key={ownRunNote.id}
            role={ownRunNote.tone === 'bad' ? 'alert' : 'status'}
            className="flex min-w-0 items-baseline gap-2 text-[13.5px] text-ink"
            data-testid="auto-run-message"
          >
            <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', ownRunNote.tone === 'good' ? 'bg-good' : 'bg-bad')} aria-hidden />
            {ownRunNote.text}
          </p>
        )}
      </div>

      {/* Stand: was der Server gespeichert hat – nicht der Entwurf. */}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-4 text-[13px]" data-testid="auto-status">
        <dt className="text-ink-2">Nächster Lauf</dt>
        {followUpAt && !running ? (
          <dd className="text-right font-semibold text-ink" data-testid="auto-next">
            <span className="inline-flex items-baseline gap-2" data-testid="auto-follow-up">
              <span className="h-1.5 w-1.5 shrink-0 -translate-y-px animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden />
              {followUpAt > Date.now() ? `Sucht weiter – ${formatNextRun(followUpAt)}` : 'Sucht weiter – wartet auf eine andere Suche'}
            </span>
            <span className="block text-[11px] font-semibold text-ink-3">
              {followUpAt > Date.now() ? 'Pause zwischen zwei Läufen' : 'startet, sobald sie fertig ist'}
              {schedule.dailyTarget ? ` · bis ${schedule.dailyTarget} Leads` : ''}
              {schedule.followUpManual ? ' · von Hand gestartet' : ''}
            </span>
          </dd>
        ) : (
          <dd className="flex items-baseline justify-end gap-2 text-right font-semibold text-ink" data-testid="auto-next">
            <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', schedule.enabled ? 'bg-good' : 'bg-ink-4')} aria-hidden />
            {!schedule.enabled ? 'Aus' : schedule.nextRunAt ? formatNextRun(schedule.nextRunAt) : 'noch nicht geplant'}
          </dd>
        )}
        {schedule.nextFocus && (
          <>
            <dt className="text-ink-2">Zielgruppe</dt>
            <dd className="text-right font-semibold text-ink" data-testid="auto-focus">
              {AUTO_SEARCH_FOCUS_LABELS[schedule.nextFocus]}
            </dd>
          </>
        )}
        {schedule.today && schedule.today.rounds > 0 && (
          <>
            {/* Summe aller Läufe des Tages – „Letzter Lauf“ zeigt nur den jüngsten (Wunsch des Nutzers 15.10.). */}
            <dt className="text-ink-2">Heute</dt>
            <dd className="text-right font-semibold text-ink" data-testid="auto-today">
              {todayText(schedule.today, schedule.dailyTarget ?? null)}
            </dd>
          </>
        )}
        <dt className="text-ink-2">Letzter Lauf</dt>
        <dd className="flex min-w-0 items-baseline justify-end gap-2 text-right font-semibold text-ink" data-testid="auto-last">
          {running ? (
            <>
              <Spinner className="h-2.5 w-2.5 shrink-0 self-center" />
              <span>
                Läuft gerade …{' '}
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'SET_VIEW', view: 'search' })}
                  className="inline-flex items-center gap-1 font-medium text-ink-2 underline-offset-4 transition-colors hover:text-ink hover:underline"
                  data-testid="auto-to-search"
                >
                  Zur Lead-Suche <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </span>
            </>
          ) : lastRun ? (
            <>
              <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', lastTone)} aria-hidden />
              <span className="min-w-0">{lastRunText(lastRun)}</span>
            </>
          ) : (
            <span className="text-ink-2">noch keiner</span>
          )}
        </dd>
      </dl>

      {/* Während des Speicherns gesperrt – sonst gingen Eingaben verloren, die nach dem Absenden kommen. */}
      <fieldset disabled={saving} className="contents">
        <section className="mt-12" aria-labelledby={`${base}-plan`}>
          <h2 id={`${base}-plan`} className={HEADING}>
            Zeitplan
          </h2>
          <div className="flex items-center justify-between gap-4 py-6">
            <div className="min-w-0">
              <p id={`${base}-enabled`} className={LABEL}>
                Automatisch suchen
              </p>
            </div>
            <Switch checked={draft.enabled} onChange={(enabled) => change({ enabled })} labelledBy={`${base}-enabled`} />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[minmax(0,1fr)_180px]">
            <div>
              <p id={`${base}-days-label`} className="mb-2 text-[13px] font-medium text-ink-2">
                Wochentage
              </p>
              <div
                role="group"
                aria-labelledby={`${base}-days-label`}
                aria-describedby={describe('days')}
                className="flex flex-wrap gap-1.5"
                data-testid="auto-days"
              >
                {WEEKDAYS.map(({ day, short, long }) => {
                  const on = draft.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      aria-label={long}
                      title={long}
                      onClick={() => toggleDay(day)}
                      className={cn(
                        'flex h-11 w-11 items-center justify-center rounded-full text-[14px] font-medium transition-[background-color,color,transform] duration-100 active:scale-[0.94]',
                        on ? 'bg-ink text-black hover:bg-white' : 'bg-surface-3 text-ink-2 hover:bg-surface-4 hover:text-ink',
                      )}
                      data-testid={`auto-day-${day}`}
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
              <FieldError id={`${base}-days-error`} text={errorAt('days')} testId="auto-days-error" />
            </div>
            <div>
              <Field label="Uhrzeit (deutsche Zeit)" htmlFor={`${base}-time`}>
                <input
                  id={`${base}-time`}
                  type="time"
                  step={60}
                  value={draft.time}
                  onChange={(event) => change({ time: event.target.value })}
                  aria-invalid={errorAt('time') ? true : undefined}
                  aria-describedby={describe('time')}
                  className={cn(FIELD_INPUT, errorAt('time') && 'border-bad/60')}
                  data-testid="auto-time"
                />
              </Field>
              <FieldError id={`${base}-time-error`} text={errorAt('time')} testId="auto-time-error" />
              <div className="mt-3">
                <Field label="2. Uhrzeit (optional)" htmlFor={`${base}-second-time`}>
                  <input
                    id={`${base}-second-time`}
                    type="time"
                    step={60}
                    value={draft.secondTime ?? ''}
                    onChange={(event) => change({ secondTime: event.target.value || null })}
                    aria-invalid={errorAt('secondTime') ? true : undefined}
                    aria-describedby={describe('secondTime')}
                    className={cn(FIELD_INPUT, errorAt('secondTime') && 'border-bad/60')}
                    data-testid="auto-second-time"
                  />
                </Field>
                <FieldError id={`${base}-second-time-error`} text={errorAt('secondTime')} testId="auto-second-time-error" />
              </div>
            </div>
            <div>
              <Field label="Qualifizierte Leads pro Tag (0 = ein Lauf)" htmlFor={`${base}-target`}>
                <Stepper
                  id={`${base}-target`}
                  editable
                  label="Qualifizierte Leads pro Tag"
                  testId="auto-daily-target"
                  value={draft.dailyTarget ?? 0}
                  min={0}
                  max={AUTO_SEARCH_DAILY_TARGET_MAX}
                  onChange={(value) => change({ dailyTarget: value > 0 ? value : null })}
                />
              </Field>
            </div>
            <div>
              <Field label="KI-Budget pro Tag (€)" htmlFor={`${base}-budget`}>
                <Stepper
                  id={`${base}-budget`}
                  editable
                  label="KI-Budget pro Tag in Euro, 0 = ohne Budget"
                  testId="auto-daily-budget"
                  value={Math.round(draft.dailyBudgetEur ?? 0)}
                  min={0}
                  max={AUTO_SEARCH_DAILY_BUDGET_MAX}
                  showMax={false}
                  onChange={(value) => change({ dailyBudgetEur: value > 0 ? value : null })}
                />
              </Field>
            </div>
            {/* Ohne Budget wie bisher: höchstens so viele Läufe. Mit Budget zählt das Geld (Wunsch des Nutzers 11.10.). */}
            {draft.dailyBudgetEur == null && (
              <div>
                <Field label="Höchstens Suchläufe pro Tag" htmlFor={`${base}-rounds`}>
                  <Stepper
                    id={`${base}-rounds`}
                    editable
                    label="Höchstens Suchläufe pro Tag"
                    testId="auto-max-rounds"
                    value={draft.maxRounds ?? AUTO_SEARCH_DEFAULT_MAX_ROUNDS}
                    min={1}
                    max={AUTO_SEARCH_MAX_ROUNDS_LIMIT}
                    showMax={false}
                    onChange={(maxRounds) => change({ maxRounds })}
                  />
                </Field>
              </div>
            )}
          </div>
          {schedule.dailyTarget || schedule.dailyBudgetEur ? (
            <p className="mt-3 text-[12.5px] leading-[1.5] text-ink-3" data-testid="auto-daily-status">
              {dailyStatusText(schedule)}
            </p>
          ) : null}
          {schedule.today?.stopReason ? (
            // Warum heute Schluss war (Wunsch des Nutzers 13.10.: „nicht genug Leads gefunden“ – was hat gebremst?).
            <p className="mt-2 text-[12.5px] font-medium leading-[1.5] text-warn" data-testid="auto-stop-reason">
              {schedule.today.stopReason}
            </p>
          ) : null}
        </section>

        <TargetMix value={draft.kapitalanlagePercent ?? AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT} onChange={(kapitalanlagePercent) => change({ kapitalanlagePercent })} />

        <section className="mt-12" aria-labelledby={`${base}-profile`}>
          <div className="flex items-center justify-between gap-3">
            <h2 id={`${base}-profile`} className={HEADING}>
              Suchprofil
            </h2>
            <DisclosureToggle look="chip" className="-mr-2" testId="auto-profile-toggle" open={profileOpen} onToggle={() => setProfileOpen((value) => !value)} controls={`${base}-profile-fields`}>
              Bearbeiten
            </DisclosureToggle>
          </div>
          <div id={`${base}-profile-fields`}>
          {!profileOpen ? (
            <div className="mt-4 space-y-0.5 text-[13px] text-ink-2" data-testid="auto-profile-summary">
              <p className="truncate">{draft.profile.keywords.join(' · ') || 'Keine Stichwörter'}</p>
              <p className="truncate">
                {[draft.profile.positions.join(', '), draft.profile.region, `${draft.profile.maxResults} Profile pro Lauf`].filter(Boolean).join(' · ')}
              </p>
              {/* Probleme nie verstecken: Fehler im zugeklappten Profil bleibt sichtbar. */}
              <FieldError id={`${base}-profile-error`} text={profileError} testId="auto-profile-error" />
            </div>
          ) : (
          <div className="mt-5 space-y-5">
            <div>
              <TermField
                label="Stichwörter"
                values={draft.profile.keywords}
                onChange={(keywords) => change({ profile: { keywords } })}
                testId="auto-keywords"
                invalid={!!errorAt('keywords')}
                describedBy={describe('keywords')}
              />
              <FieldError id={`${base}-keywords-error`} text={errorAt('keywords')} testId="auto-keywords-error" />
            </div>
            <div>
              <TermField
                label="Positionen"
                values={draft.profile.positions}
                onChange={(positions) => change({ profile: { positions } })}
                testId="auto-positions"
                invalid={!!errorAt('positions')}
                describedBy={describe('positions')}
              />
              <FieldError id={`${base}-positions-error`} text={errorAt('positions')} testId="auto-positions-error" />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
              <div>
                <Field label="Region" htmlFor={`${base}-region`}>
                  <input
                    id={`${base}-region`}
                    value={draft.profile.region}
                    onChange={(event) => change({ profile: { region: event.target.value } })}
                    aria-invalid={errorAt('region') ? true : undefined}
                    aria-describedby={describe('region')}
                    className={cn(FIELD_INPUT, errorAt('region') && 'border-bad/60')}
                    data-testid="auto-region"
                  />
                </Field>
                <FieldError id={`${base}-region-error`} text={errorAt('region')} testId="auto-region-error" />
              </div>
              <div>
                <Field label="Profile pro Lauf" htmlFor={`${base}-max`}>
                  <Stepper
                    id={`${base}-max`}
                    editable
                    label="Profile pro Lauf"
                    testId="auto-max-results"
                    value={draft.profile.maxResults}
                    min={1}
                    max={MAX_RESULTS_LIMIT}
                    showMax={false}
                    onChange={(maxResults) => change({ profile: { maxResults } })}
                    invalid={!!errorAt('maxResults')}
                    describedBy={describe('maxResults')}
                  />
                </Field>
                <FieldError id={`${base}-maxResults-error`} text={errorAt('maxResults')} testId="auto-max-results-error" />
              </div>
            </div>
            <FieldError id={`${base}-profile-error`} text={errorAt('profile')} testId="auto-profile-error" />
          </div>
          )}
          </div>
        </section>
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
                key={generalError ? generalError.id : 'status'}
                role={generalError ? 'alert' : 'status'}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-[13.5px] text-ink"
                data-testid="auto-message"
              >
                {generalError ? (
                  <>
                    <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
                    {generalError.text}
                  </>
                ) : dirty ? (
                  <>
                    <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
                    <span className="sm:hidden">Ungespeichert</span>
                    <span className="hidden sm:inline">Ungespeicherte Änderungen{showSwitch ? ` · Plan von ${founderName}` : ''}</span>
                  </>
                ) : ownSaved ? (
                  <>
                    <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-good" aria-hidden />
                    {ownSaved.text}
                  </>
                ) : null}
              </p>
              {dirty && (
                <>
                  <Button variant="ghost" disabled={saving} onClick={discard} data-testid="auto-discard">
                    Verwerfen
                  </Button>
                  <Button type="submit" variant="primary" shortcut={saving ? undefined : '↵'} disabled={saving} data-testid="auto-save">
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

function FieldError({ id, text, testId }: { id: string; text: string | null; testId: string }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-baseline gap-2 text-[12.5px] text-ink" data-testid={testId}>
      <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
      {text}
    </p>
  );
}

/** Schalter an/aus – weiß wie der Primär-Button, wenn an. */
function Switch({ checked, onChange, labelledBy }: { checked: boolean; onChange: (checked: boolean) => void; labelledBy: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[26px] w-11 shrink-0 rounded-full transition-[background-color,transform] duration-200 active:scale-[0.96]',
        checked ? 'bg-good' : 'bg-surface-4',
      )}
      data-testid="auto-enabled"
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-300 ease-[cubic-bezier(.3,1.3,.5,1)] motion-reduce:transition-none',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )}
      />
    </button>
  );
}

const euroCents = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

/** Satz unter dem Tagesziel: was der Server an einem geplanten Tag tut und wie weit er heute ist. */
function dailyStatusText(schedule: AutoSearchSchedule): string {
  const budget = schedule.dailyBudgetEur ?? null;
  const target = schedule.dailyTarget ?? null;
  const per = `mit je bis zu ${schedule.profile.maxResults} Profilen`;
  const plan =
    target && budget !== null
      ? `Sucht an jedem geplanten Tag weiter, bis ${target} qualifizierte Leads da sind oder das KI-Budget von ${euroCents.format(budget)} aufgebraucht ist – Läufe ${per}.`
      : target
        ? `Sucht an jedem geplanten Tag weiter, bis ${target} qualifizierte Leads da sind – höchstens ${schedule.maxRounds ?? AUTO_SEARCH_DEFAULT_MAX_ROUNDS} Läufe ${per}.`
        : `Ein Lauf je Termin; er hört auf, Profile zu lesen, sobald das KI-Budget von ${euroCents.format(budget ?? 0)} für heute aufgebraucht ist.`;
  const today = schedule.today;
  if (!today) return plan;
  const parts = [
    target ? `${today.created} von ${target} Leads` : `${today.created} ${today.created === 1 ? 'Lead' : 'Leads'}`,
    `${today.rounds} ${today.rounds === 1 ? 'Lauf' : 'Läufe'}`,
  ];
  if (budget !== null) parts.push(`${euroCents.format(today.costEur ?? 0)} von ${euroCents.format(budget)} KI-Budget`);
  // Gemeinsames Tageslimit des Such-Accounts – bremst bei hohem Tagesziel oft vor dem Budget.
  if (today.profileFetches !== undefined && today.profilesPerDay) parts.push(`${today.profileFetches} von ${today.profilesPerDay} Profilabrufen (beide Gründer)`);
  return `${plan} Heute: ${parts.join(', ')}.`;
}

/**
 * Zielgruppen-Mix (Wunsch des Nutzers 27.10.): Regler von links (nur Finanzdienstleister) nach rechts (nur
 * Kapitalanlage-Vertriebe), 10er-Schritte, Standard 50 %. Jeder automatische Lauf sucht eine der beiden Gruppen.
 */
function TargetMix({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId();
  return (
    <section className="mt-12" aria-labelledby={`${id}-title`} data-testid="auto-mix">
      <h2 id={`${id}-title`} className={HEADING}>
        Zielgruppen-Mix
      </h2>
      <div className="mt-4 flex items-baseline justify-between gap-4 text-[13px]">
        <span className="text-ink-2">
          Finanzdienstleister <span className="font-semibold tabular-nums text-ink" data-testid="auto-mix-fdl">{100 - value} %</span>
        </span>
        <span className="text-right text-ink-2">
          <span className="font-semibold tabular-nums text-ink" data-testid="auto-mix-ka">{value} %</span> Kapitalanlage-Vertriebe
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={AUTO_SEARCH_KAPITALANLAGE_PERCENT_STEP}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Anteil Kapitalanlage-Vertriebe in Prozent, der Rest Finanzdienstleister"
        aria-valuetext={`${value} % Kapitalanlage-Vertriebe, ${100 - value} % Finanzdienstleister`}
        className="mt-3 h-11 w-full cursor-pointer accent-white"
        data-testid="auto-mix-slider"
      />
      <p className="mt-1 text-[12.5px] leading-[1.5] text-ink-3">
        So verteilen sich die automatischen Läufe – jeder Lauf sucht eine der beiden Zielgruppen.
      </p>
    </section>
  );
}
