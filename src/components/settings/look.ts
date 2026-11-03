/**
 * Einheitlicher Look aller Einstellungsseiten (Design „Server und Anmeldung v2“, Wunsch des Nutzers 09.10.):
 * Beschriftung links in Grau, Wert oder Eingabe rechts, keine Rahmen und Trennlinien, kaum Erklärtext.
 */

/** Eingabefeld: dunkle Fläche ohne Rahmen, beim Fokus ein blauer Rand. 16 px auf dem Handy (kein Zoom unter iOS). */
export const FIELD =
  'h-[38px] rounded-[10px] border border-transparent bg-surface-3 px-3.5 text-[16px] font-medium text-ink outline-none transition-colors placeholder:font-normal placeholder:text-ink-4 focus:border-accent disabled:opacity-40 aria-[invalid=true]:border-bad/60 sm:text-[14px]';

/** Mehrzeiliges Feld (Vorlagen, Test-Nachricht). */
export const AREA =
  'w-full resize-y rounded-[12px] border border-transparent bg-surface-3 px-3.5 py-3 text-[16px] leading-[1.55] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent disabled:opacity-50 aria-[invalid=true]:border-bad/60 sm:text-[14px]';

/** Zeile: Beschriftung links, Steuerung rechts. Auf dem Handy bricht die Steuerung bei Bedarf um. */
export const ROW = 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2';

/** Beschriftung einer Zeile. */
export const LABEL = 'text-[13px] text-ink-2';

/** Kleine Zeile unter der Beschriftung (Stand, Hinweis) – höchstens ein paar Wörter. */
export const SUB = 'text-[11px] font-semibold';

/** Überschrift eines Abschnitts innerhalb einer Seite („Nur in .env änderbar“, „Follow-up 1“). */
export const HEADING = 'text-[15px] font-bold tracking-[-0.01em] text-ink';

/** Abstand zwischen Abschnitten bzw. Zeilen. */
export const SECTION_GAP = 'space-y-12';
export const ROW_GAP = 'space-y-7';

/** Kleiner Textknopf (Zurücksetzen, Löschen, Abbrechen). */
export const TEXT_BUTTON = 'text-[12px] font-medium text-ink-3 transition-colors hover:text-ink';
