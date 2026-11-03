import type { KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

interface RadioChoiceProps<T extends string> {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  testId?: string;
}

/**
 * Auswahl als Segmentsteuerung mit Radio-Semantik (wie in den Einstellungen): Pfeiltasten wechseln, ↵ schickt das
 * Formular ab, in dem sie steht.
 */
export function RadioChoice<T extends string>({ options, value, onChange, labelledBy, describedBy, invalid, testId }: RadioChoiceProps<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.closest('form')?.requestSubmit();
      return;
    }
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    // Fokus folgt der Auswahl.
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[options.indexOf(next)]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onKeyDown={onKeyDown}
      data-testid={testId}
      className={cn(
        'inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full border bg-white/[0.03] p-1',
        invalid ? 'border-white/25' : 'border-line',
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (value === null && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-8 rounded-full px-3.5 text-[13px] font-medium transition-[background-color,color,transform] duration-100 active:scale-[0.97]',
              checked ? 'bg-ink text-black' : 'text-ink-2 hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
