import { useId } from 'react';
import { cn } from '../../lib/cn';

/**
 * Schalter einer einfachen Einstellungsseite (Wunsch des Nutzers 23.10.): ein Satz, den man sofort versteht
 * („Jede Nacht sichern“), rechts der Schalter. Gilt beim Umlegen – kein Speichern-Knopf, kein Kleingedrucktes.
 */
export function QuickSwitch({
  label,
  on,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-6" data-testid={testId}>
      <label htmlFor={id} className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cn(
          'relative h-8 w-[52px] shrink-0 rounded-full transition-[background-color,transform] duration-200 ease-out active:scale-[0.96] disabled:opacity-50 motion-reduce:transition-none',
          on ? 'bg-good' : 'bg-surface-4',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute left-[3px] top-[3px] h-[26px] w-[26px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-300 ease-[cubic-bezier(.3,1.3,.5,1)] motion-reduce:transition-none',
            on ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}
