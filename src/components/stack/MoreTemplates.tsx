import { ChevronDown } from 'lucide-react';
import { templateLetter, type MessageTemplate } from '../../../shared/messages';
import { cn } from '../../lib/cn';
import { shortTemplateName } from '../../state/templates';

/** So viele Vorlagen stehen als Reiter (Tasten 1–8) – weitere (bis Z) über „Weitere“. */
export const TABBED_TEMPLATES = 8;

/** Auswahl der Vorlagen ab I – erscheint nur, wenn eine Kategorie mehr als acht hat. */
export function MoreTemplates({
  templates,
  value,
  onChange,
  className,
}: {
  templates: readonly MessageTemplate[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const rest = templates.slice(TABBED_TEMPLATES);
  if (rest.length === 0) return null;
  const picked = rest.some((entry) => entry.id === value);
  return (
    <label className={cn('relative inline-flex items-center', className)}>
      <span className="sr-only">Weitere Vorlagen</span>
      <select
        value={picked ? value : ''}
        onChange={(event) => event.target.value && onChange(event.target.value)}
        className={cn(
          'h-9 appearance-none rounded-[10px] bg-surface-3 pl-3.5 pr-8 text-[13px] font-medium outline-none transition-colors focus:border-accent',
          picked ? 'text-ink' : 'text-ink-2',
        )}
        data-testid="more-templates"
      >
        <option value="" disabled>
          Weitere ({templateLetter(TABBED_TEMPLATES)}–{templateLetter(templates.length - 1)})
        </option>
        {rest.map((entry, index) => (
          <option key={entry.id} value={entry.id}>
            {templateLetter(TABBED_TEMPLATES + index)} · {shortTemplateName(entry)}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 h-3.5 w-3.5 text-ink-3" aria-hidden />
    </label>
  );
}
