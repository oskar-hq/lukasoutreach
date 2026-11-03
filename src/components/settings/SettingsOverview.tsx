import type { SettingKey, SettingState } from '../../../shared/settings';
import { cn } from '../../lib/cn';
import { HEADING } from './look';

export function jumpToSetting(key: SettingKey) {
  const element = document.querySelector<HTMLElement>(`[data-testid="setting-${key}"]`);
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element?.querySelector<HTMLElement>('input, select, textarea, button')?.focus({ preventScroll: true });
}

function isSet(state: SettingState | undefined): boolean {
  if (!state) return false;
  if (state.secret) return state.secret.set;
  return state.value !== null && state.value !== undefined && state.value !== '';
}

/**
 * „Auf einen Blick“, erster Bereich der Einstellungen: nur was noch fehlt (Wunsch des Nutzers 23.10. – Schlüssel und
 * Grenzen stehen auf ihren Seiten). Ein Klick springt zum Feld. Farben nur als Punkte: gelb = fehlt (optional),
 * rot = fehlt (nötig).
 */
export function SettingsOverview({
  states,
  onJump = jumpToSetting,
}: {
  states: Map<SettingKey, SettingState>;
  /** Zum Feld springen – die Seite wechselt vorher in den Bereich. */
  onJump?: (key: SettingKey) => void;
}) {
  const todo: { key: SettingKey; text: string; level: 'bad' | 'warn' }[] = [];
  if (!isSet(states.get('UNIPILE_DSN')) || !isSet(states.get('UNIPILE_API_KEY'))) {
    todo.push({ key: 'UNIPILE_API_KEY', text: 'Unipile-Zugang fehlt – ohne ihn sucht die Lead-Suche nicht.', level: 'bad' });
  }
  if (!isSet(states.get('ANTHROPIC_API_KEY'))) todo.push({ key: 'ANTHROPIC_API_KEY', text: 'KI-Schlüssel fehlt – Leads werden nicht bewertet.', level: 'bad' });
  if (!isSet(states.get('UNIPILE_ACCOUNT_NICK')) && !isSet(states.get('UNIPILE_ACCOUNT_JOHANNES'))) {
    todo.push({ key: 'UNIPILE_ACCOUNT_NICK', text: 'Noch kein LinkedIn-Account zugeordnet – nötig für Senden und Tests.', level: 'warn' });
  }
  if (!isSet(states.get('META_ACCESS_TOKEN'))) todo.push({ key: 'META_ACCESS_TOKEN', text: 'Meta-Token fehlt – aktive Meta-Ads werden nicht erkannt.', level: 'warn' });
  // Aus der Mängelliste ein Ziel, das fast erreicht ist (Goal-Gradient, Wunsch des Nutzers 25.10.): vier Prüfungen oben.
  const CHECKS = 4;
  const done = CHECKS - todo.length;

  return (
    <section className="space-y-12" aria-label="Auf einen Blick" data-testid="settings-overview">
      <div data-testid="settings-todo">
        <h3 className={HEADING}>Zu erledigen</h3>
        <div className="mt-4 max-w-[360px]" data-testid="settings-setup-progress">
          <p className="flex justify-between text-[13px] text-ink-2">
            Einrichtung
            <span className="font-semibold tabular-nums text-ink">
              {done} von {CHECKS}
            </span>
          </p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-4" aria-hidden>
            <div className="h-full origin-left rounded-full bg-good transition-transform duration-500 ease-out" style={{ transform: `scaleX(${done / CHECKS})` }} />
          </div>
        </div>
        {todo.length === 0 ? (
          <p className="mt-5 flex items-baseline gap-2 text-[13px] text-ink-2">
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-good" aria-hidden /> Alles Wichtige ist eingerichtet.
          </p>
        ) : (
          <ul className="mt-5 space-y-3">
            {todo.map((item) => (
              <li key={item.key}>
                <button type="button" onClick={() => onJump(item.key)} className="flex items-baseline gap-2.5 text-left text-[13px] text-ink transition-colors hover:text-ink-2">
                  <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', item.level === 'bad' ? 'bg-bad' : 'bg-warn')} aria-hidden />
                  {item.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

    </section>
  );
}
