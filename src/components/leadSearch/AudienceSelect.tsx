import { ChevronDown } from 'lucide-react';
import { useId } from 'react';
import { SEARCH_AUDIENCE_OPTIONS, SEARCH_PRESETS, type SearchAudience } from '../../../shared/leadSearch';
import { FIELD_INPUT } from '../autoSearch/ProfileInputs';
import { cn } from '../../lib/cn';

/**
 * Zielgruppe der Suche als Dropdown (Kundengespräch 27.10.: „mit so einem Dropdown-Menü auswählen, nach welcher
 * Zielgruppe man suchen möchte“). Beide Zielgruppen, Kapitalanlage-Vertriebe oder Finanzdienstleister – die Wahl setzt
 * Stichwörter und Positionen. Wer danach selbst etwas ändert, sieht „Eigene Auswahl“; ein altes Bauträger-Profil
 * steht nur noch, solange es eingestellt ist.
 */
export function AudienceSelect({
  audience,
  onPick,
  testId = 'audience-select',
  hint = true,
}: {
  audience: SearchAudience | null;
  onPick: (audience: SearchAudience) => void;
  testId?: string;
  /** Satz unter dem Dropdown, wen das Preset findet. */
  hint?: boolean;
}) {
  const id = useId();
  const options = audience && !SEARCH_AUDIENCE_OPTIONS.includes(audience) ? [...SEARCH_AUDIENCE_OPTIONS, audience] : SEARCH_AUDIENCE_OPTIONS;
  return (
    <div data-testid="search-audience">
      <label htmlFor={id} className="mb-2 block text-[13px] font-medium text-ink-2">
        Zielgruppe
      </label>
      <div className="relative">
        <select
          id={id}
          value={audience ?? ''}
          onChange={(event) => event.target.value && onPick(event.target.value as SearchAudience)}
          className={cn(FIELD_INPUT, 'appearance-none pr-10 font-medium')}
          data-testid={testId}
        >
          {!audience && (
            <option value="" disabled>
              Eigene Auswahl
            </option>
          )}
          {options.map((value) => (
            <option key={value} value={value}>
              {SEARCH_PRESETS[value].label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
      </div>
      {hint && (
        <p className="mt-2 text-[12.5px] text-ink-3" data-testid="audience-hint">
          {audience ? SEARCH_PRESETS[audience].hint : 'Eigene Auswahl – wähle eine Zielgruppe, um Stichwörter und Positionen zurückzusetzen.'}
        </p>
      )}
    </div>
  );
}
