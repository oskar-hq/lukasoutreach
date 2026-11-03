import { Check } from 'lucide-react';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth';
import { cn } from '../../lib/cn';
import { founderName } from './accountText';

interface FounderChecksProps {
  value: AuthFounderId[];
  onChange: (value: AuthFounderId[]) => void;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  testId?: string;
}

/**
 * Mitarbeiter: für welche Gründer er arbeitet – mehrere möglich (Vertrag `founders`). Echte Checkboxen, damit Tab,
 * Leertaste und Screenreader wie gewohnt funktionieren.
 */
export function FounderChecks({ value, onChange, labelledBy, describedBy, invalid, testId }: FounderChecksProps) {
  const toggle = (id: AuthFounderId) => onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);
  return (
    <div role="group" aria-labelledby={labelledBy} aria-describedby={describedBy} data-testid={testId} className="flex flex-wrap gap-2">
      {AUTH_FOUNDER_IDS.map((id) => {
        const checked = value.includes(id);
        return (
          <label
            key={id}
            className={cn(
              'relative flex h-11 cursor-pointer select-none items-center gap-2.5 rounded-xl border pl-3 pr-4 text-[14px] transition-colors',
              checked ? 'border-ink bg-surface-3 font-semibold text-ink' : invalid ? 'border-white/25 text-ink-2' : 'border-line-strong text-ink-2 hover:text-ink',
            )}
          >
            {/* Unsichtbar über der ganzen Fläche: Klick, Tab und Leertaste wie bei einer normalen Checkbox. */}
            <input type="checkbox" className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-xl opacity-0" checked={checked} onChange={() => toggle(id)} data-testid={testId ? `${testId}-${id}` : undefined} />
            <span
              aria-hidden
              className={cn(
                'flex h-[18px] w-[18px] items-center justify-center rounded-[5px] peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                checked ? 'bg-ink' : 'border border-white/25',
              )}
            >
              {checked && <Check className="h-3 w-3 text-black" strokeWidth={3.2} />}
            </span>
            {founderName(id)}
          </label>
        );
      })}
    </div>
  );
}

/** Auswahl → Vertrag: in fester Reihenfolge, `founder` = erster, `founders` = alle (nur, wenn es mehrere sind). */
export function founderFields(value: AuthFounderId[]): { founder: AuthFounderId | null; founders?: AuthFounderId[] } {
  const sorted = AUTH_FOUNDER_IDS.filter((id) => value.includes(id));
  if (sorted.length === 0) return { founder: null };
  return sorted.length > 1 ? { founder: sorted[0], founders: sorted } : { founder: sorted[0] };
}
