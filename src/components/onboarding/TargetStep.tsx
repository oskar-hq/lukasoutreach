import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ChevronRight, Delete, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AuthFounderId } from '../../../shared/auth';
import {
  AUTO_SEARCH_DAILY_BUDGET_MAX,
  AUTO_SEARCH_DAILY_TARGET_MAX,
  AUTO_SEARCH_DEFAULT_DAILY_BUDGET_EUR,
  type AutoSearchSchedule,
} from '../../../shared/autoSearch';
import { cn } from '../../lib/cn';
import { ApiError, autoSearchApi } from '../../lib/leadSearchApi';
import { EASE_OUT } from '../../lib/motion';
import { Logo } from '../layout/Logo';
import { WEEKDAYS } from '../autoSearch/format';

/** Ergebnis des Schritts – für „Alles bereit“. */
export interface TargetResult {
  dailyTarget: number;
  /** KI-Tagesbudget in Euro (Geld statt Suchläufe, Wunsch des Nutzers 11.10.). */
  dailyBudgetEur: number;
}

/** Budget-Schritte: bis 20 € in 1-€-Schritten, darüber in 5-€-Schritten. */
const budgetUp = (value: number) => Math.min(AUTO_SEARCH_DAILY_BUDGET_MAX, value < 20 ? value + 1 : value + 5);
const budgetDown = (value: number) => Math.max(1, value <= 20 ? value - 1 : value - 5);

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'] as const;

/**
 * Einrichtung, Schritt „Tagesziel“ (Wunsch des Nutzers 08.10., Stil wie Trade Republic): eine große Zahl, ein
 * Ziffernblock, unten „Weiter“. Speichert den Zeitplan der automatischen Suche des Gründers mit `dailyTarget` und
 * KI-Tagesbudget (`dailyBudgetEur`) und schaltet sie ein (Vertrag `shared/autoSearch.ts` → „Tagesziel“).
 */
export function TargetStep({
  founder,
  initial,
  onBack,
  onDone,
}: {
  founder: AuthFounderId;
  initial: TargetResult | null;
  onBack: () => void;
  onDone: (result: TargetResult | null) => void;
}) {
  const [digits, setDigits] = useState(initial ? String(initial.dailyTarget) : '');
  const [budget, setBudget] = useState(initial?.dailyBudgetEur ?? AUTO_SEARCH_DEFAULT_DAILY_BUDGET_EUR);
  const [schedule, setSchedule] = useState<AutoSearchSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = Number(digits || '0');

  useEffect(() => {
    let cancelled = false;
    autoSearchApi
      .list()
      .then((response) => {
        if (cancelled) return;
        const own = response.schedules.find((entry) => entry.founder === founder) ?? null;
        setSchedule(own);
        if (!initial && own?.dailyTarget) setDigits(String(own.dailyTarget));
        if (!initial && own?.dailyBudgetEur) setBudget(Math.max(1, Math.round(own.dailyBudgetEur)));
      })
      .catch(() => !cancelled && setError('Die automatische Suche ist gerade nicht erreichbar. Du kannst das Ziel später unter Einstellungen festlegen.'));
    return () => {
      cancelled = true;
    };
  }, [founder, initial]);

  const press = (key: (typeof KEYS)[number]) => {
    setError(null);
    if (key === 'back') setDigits((current) => current.slice(0, -1));
    else if (key) {
      setDigits((current) => {
        const next = (current + key).replace(/^0+/, '');
        return Number(next) > AUTO_SEARCH_DAILY_TARGET_MAX ? current : next;
      });
    }
  };

  // Tastatur: Ziffern, Rücktaste, ↵ = Weiter.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) press(event.key as (typeof KEYS)[number]);
      else if (event.key === 'Backspace') press('back');
      else if (event.key === 'Enter' && value > 0) void save();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const save = async () => {
    if (saving || value < 1) return;
    if (!schedule) {
      setError('Die automatische Suche ist gerade nicht erreichbar. Versuch es gleich noch einmal oder überspring den Schritt.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await autoSearchApi.update(founder, {
        enabled: true,
        days: schedule.days.length ? schedule.days : [1, 2, 3, 4, 5],
        time: schedule.time,
        profile: schedule.profile,
        dailyTarget: value,
        dailyBudgetEur: budget,
      });
      onDone({ dailyTarget: value, dailyBudgetEur: budget });
    } catch (caught) {
      setSaving(false);
      setError(caught instanceof ApiError && caught.message ? caught.message : 'Speichern hat nicht geklappt. Versuch es noch einmal.');
    }
  };

  const days = schedule?.days.length ? schedule.days : [1, 2, 3, 4, 5];
  const dayText = days.length === 5 && days.every((day, index) => day === index + 1) ? 'werktags' : days.map((day) => WEEKDAYS[day - 1]?.short ?? '').join(', ');
  const perRun = schedule?.profile.maxResults ?? 15;

  return (
    <div className="mx-auto flex min-h-dvh max-w-[520px] flex-col px-6 pb-8" data-testid="setup-target">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <button type="button" onClick={onBack} className="flex min-h-11 items-center gap-1.5 text-[14px] text-ink-3 transition-colors hover:text-ink">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Zurück
        </button>
      </header>

      <p className="mt-6 text-[12px] font-semibold text-ink-3">Tagesziel</p>
      <h1 className="display mt-2 text-[28px] font-semibold sm:text-[32px]">Wie viele qualifizierte Leads willst du pro Tag?</h1>

      <div className="flex flex-1 flex-col items-center justify-center py-8" aria-live="polite">
        <div className="relative flex h-[96px] items-center justify-center overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={value}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.18, ease: EASE_OUT }}
              aria-hidden
              className={cn('text-[80px] font-semibold leading-none tracking-[-0.04em] tabular-nums sm:text-[88px]', value ? 'text-ink' : 'text-ink-4')}
            >
              {value}
            </motion.span>
          </AnimatePresence>
        </div>
        {/* Die animierte Zahl ist nur fürs Auge – vorgelesen (und geprüft) wird diese. */}
        <span className="sr-only" data-testid="setup-target-value">
          {value}
        </span>
        <p className="mt-3 text-[15px] text-ink-3">{value === 1 ? 'Lead pro Tag' : 'Leads pro Tag'}</p>
      </div>

      <div className="grid grid-cols-3 gap-y-1" role="group" aria-label="Ziffern">
        {KEYS.map((key, index) =>
          key === '' ? (
            <span key={index} />
          ) : (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              aria-label={key === 'back' ? 'Letzte Ziffer löschen' : key}
              data-testid={`setup-target-key-${key}`}
              className="flex h-16 items-center justify-center rounded-2xl text-[28px] font-semibold text-ink transition-[background-color,transform] duration-100 active:scale-95 active:bg-surface-3"
            >
              {key === 'back' ? <Delete className="h-6 w-6" strokeWidth={2} aria-hidden /> : key}
            </button>
          ),
        )}
      </div>

      <div className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-[13.5px] leading-snug text-ink-2" id="setup-budget-label">
          KI-Budget höchstens <span className="font-semibold tabular-nums text-ink">{budget} €</span> pro Tag
          <span className="block text-[12.5px] text-ink-3">
            Läufe je bis zu {perRun} Profile · {dayText} ab {schedule?.time ?? '07:00'} Uhr
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-labelledby="setup-budget-label">
          <button
            type="button"
            onClick={() => setBudget(budgetDown)}
            disabled={budget <= 1}
            aria-label="Budget senken"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-3 text-ink transition-colors hover:bg-surface-4 disabled:opacity-40"
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setBudget(budgetUp)}
            disabled={budget >= AUTO_SEARCH_DAILY_BUDGET_MAX}
            aria-label="Budget erhöhen"
            data-testid="setup-budget-plus"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-3 text-ink transition-colors hover:bg-surface-4 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 flex items-baseline gap-2 text-[13.5px] leading-snug text-ink" data-testid="setup-target-error">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => onDone(null)}
          className="min-h-11 px-1 text-[14px] font-medium text-ink-3 transition-colors hover:text-ink"
          data-testid="setup-target-skip"
        >
          Später
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={value < 1 || saving}
          data-testid="setup-target-next"
          className={cn(
            'flex h-[60px] w-[200px] items-center justify-between rounded-[18px] px-6 text-[16px] font-semibold transition-[background-color,color,transform] duration-150 active:scale-[0.98]',
            value >= 1 ? 'bg-ink text-black' : 'bg-surface-4 text-ink-3',
          )}
        >
          {saving ? 'Speichert…' : 'Weiter'}
          <ChevronRight className="h-5 w-5" strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </div>
  );
}
