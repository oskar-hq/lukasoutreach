import { Minus, Plus, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Eingaben für ein Suchprofil (Stichwörter, Positionen, Anzahl) – gemeinsam für die Lead-Suche von Hand
 * (`leadSearch/SearchForm.tsx`) und die automatische Suche (`AutoSearchSection.tsx`).
 */

export const FIELD_INPUT =
  'h-12 w-full rounded-2xl border border-transparent bg-surface-3 px-4 text-[16px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent sm:text-[15px]';

export function Field({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Begriffe als Chips: Enter oder Komma fügt hinzu, Rücktaste im leeren Feld entfernt den letzten. */
export function TermField({
  label,
  values,
  onChange,
  testId,
  invalid,
  describedBy,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  testId: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [draft, setDraft] = useState('');
  const id = useId();

  const commit = () => {
    const parts = draft
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length) onChange([...values, ...parts.filter((part) => !values.includes(part))].slice(0, 20));
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // ⌘/Strg+↵ gehört dem Formular (Speichern), nicht dem Chip.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      commit();
      return;
    }
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <Field label={label} htmlFor={id}>
      <div
        className={cn(
          'flex min-h-12 flex-wrap items-center gap-1.5 rounded-2xl border border-transparent bg-surface-3 p-2 transition-colors focus-within:border-accent',
          invalid && 'border-bad/60',
        )}
        data-testid={testId}
      >
        {values.map((value) => (
          <span key={value} className="inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-[8px] bg-surface-4 pl-3 pr-1 text-[13px] font-semibold text-ink">
            <span className="truncate">{value}</span>
            <button
              type="button"
              aria-label={`${value} entfernen`}
              onClick={() => onChange(values.filter((entry) => entry !== value))}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-white/10 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          placeholder={values.length ? 'Hinzufügen …' : 'Begriff eingeben …'}
          className="h-8 min-w-[120px] flex-1 bg-transparent px-2 text-[16px] text-ink outline-none placeholder:text-ink-4 sm:text-[15px]"
        />
      </div>
    </Field>
  );
}

/**
 * Zahl mit − und +. `editable`: Die Zahl lässt sich auch tippen – dann kann sie außerhalb von min…max liegen
 * (oder leer sein, `NaN`), die Prüfung meldet das am Feld.
 */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label = 'Max. Profile pro Lauf',
  testId = 'max-results',
  editable = false,
  invalid,
  describedBy,
  id,
  showMax = true,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label?: string;
  testId?: string;
  editable?: boolean;
  invalid?: boolean;
  describedBy?: string;
  id?: string;
  /** „von 25“ neben der Zahl – aus bei praktisch unbegrenzten Werten (Profile pro Lauf, Suchläufe pro Tag). */
  showMax?: boolean;
}) {
  const digits = String(max).length;
  const known = Number.isFinite(value);
  const set = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  const step = 'flex h-9 w-9 items-center justify-center rounded-full text-ink-2 transition-[background-color,color,transform] duration-100 hover:bg-surface-3 hover:text-ink active:scale-[0.94] disabled:pointer-events-none disabled:opacity-30';
  const onArrows = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowUp' || (!editable && event.key === 'ArrowRight')) {
      event.preventDefault();
      set(known ? value + 1 : min);
    } else if (event.key === 'ArrowDown' || (!editable && event.key === 'ArrowLeft')) {
      event.preventDefault();
      set(known ? value - 1 : min);
    }
  };
  return (
    <div
      role={editable ? undefined : 'spinbutton'}
      tabIndex={editable ? undefined : 0}
      aria-label={editable ? undefined : label}
      aria-valuenow={editable ? undefined : value}
      aria-valuemin={editable ? undefined : min}
      aria-valuemax={editable ? undefined : max}
      onKeyDown={editable ? undefined : onArrows}
      className={cn(
        'flex h-12 items-center justify-between rounded-2xl border border-transparent bg-surface-3 px-1.5 outline-none focus-visible:border-white/25',
        editable && 'focus-within:border-accent',
        invalid && 'border-bad/60',
      )}
      data-testid={testId}
    >
      <button type="button" aria-label="Weniger" className={step} onClick={() => set(known ? value - 1 : min)} disabled={known && value <= min}>
        <Minus className="h-4 w-4" />
      </button>
      {editable ? (
        <span className="flex items-baseline">
          <input
            id={id}
            inputMode="numeric"
            autoComplete="off"
            aria-label={label}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={describedBy}
            value={known ? String(value) : ''}
            onChange={(event) => {
              const typed = event.target.value.replace(/\D/g, '').slice(0, digits);
              onChange(typed ? Number(typed) : Number.NaN);
            }}
            onKeyDown={onArrows}
            className={cn(
              'bg-transparent text-right text-[16px] font-semibold tabular-nums text-ink outline-none',
              digits > 3 ? 'w-12' : 'w-9',
              !showMax && 'text-center',
            )}
            data-testid={`${testId}-input`}
          />
          {showMax && <span className="ml-1.5 text-[13px] text-ink-3">von {max}</span>}
        </span>
      ) : (
        <span className="text-[16px] font-semibold tabular-nums text-ink" data-testid={`${testId}-value`}>
          {value}
          {showMax && <span className="ml-1.5 text-[13px] font-normal text-ink-3">von {max}</span>}
        </span>
      )}
      <button type="button" aria-label="Mehr" className={step} onClick={() => set(known ? value + 1 : min)} disabled={known && value >= max}>
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
