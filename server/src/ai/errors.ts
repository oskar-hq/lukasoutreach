import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic meldet ein leeres Guthaben als 400 `invalid_request_error` („Your credit balance is too low …“). Erkannt am
 * dokumentierten Text der Meldung – ein eigener Fehlertyp existiert dafür nicht. Ohne Guthaben scheitert jede weitere
 * Anfrage, deshalb behandeln alle Aufrufer das wie einen Zugangsfehler (Lauf abbrechen, verständlich melden).
 */
export function isCreditExhausted(error: unknown): boolean {
  return error instanceof Anthropic.APIError && error.status === 400 && /credit balance is too low/i.test(error.message);
}

export const CREDIT_EXHAUSTED_TITLE = 'Anthropic-Guthaben aufgebraucht';
export const CREDIT_EXHAUSTED_TEXT =
  'Das Guthaben bei Anthropic ist leer – die KI kann keine Profile mehr bewerten. Lade unter console.anthropic.com → Plans & Billing Guthaben auf (am besten mit automatischem Aufladen). Liegengebliebene Profile kommen beim nächsten Lauf zuerst dran.';
