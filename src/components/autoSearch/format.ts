import { AUTO_SEARCH_FOCUS_LABELS, AUTO_SEARCH_TIME_ZONE, type AutoSearchLastRun, type Weekday } from '../../../shared/autoSearch';

/** Wochentage 1 = Montag … 7 = Sonntag – Kurzform für die Auswahl, Langform für Screenreader. */
export const WEEKDAYS: { day: Weekday; short: string; long: string }[] = [
  { day: 1, short: 'Mo', long: 'Montag' },
  { day: 2, short: 'Di', long: 'Dienstag' },
  { day: 3, short: 'Mi', long: 'Mittwoch' },
  { day: 4, short: 'Do', long: 'Donnerstag' },
  { day: 5, short: 'Fr', long: 'Freitag' },
  { day: 6, short: 'Sa', long: 'Samstag' },
  { day: 7, short: 'So', long: 'Sonntag' },
];

// Alles in der Zeitzone des Zeitplans – der Server plant in deutscher Zeit, egal wo der Browser steht.
const zone = { timeZone: AUTO_SEARCH_TIME_ZONE } as const;
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { ...zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('de-DE', { ...zone, hour: '2-digit', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat('de-DE', { ...zone, weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat('de-DE', { ...zone, weekday: 'short', day: 'numeric', month: 'short' });

/** Kalendertage zwischen zwei Zeitpunkten in deutscher Zeit (morgen = 1, gestern = −1). */
function dayOffset(ts: number, now: number): number {
  const utc = (value: number) => Date.parse(`${dayKeyFormat.format(value)}T00:00:00Z`);
  return Math.round((utc(ts) - utc(now)) / 86_400_000);
}

const shortWeekday = (ts: number) => WEEKDAYS.find((entry) => entry.long === weekdayFormat.format(ts))?.short ?? '';

/**
 * Nächster Lauf: „heute, 07:00“ · „morgen, 07:00“ · „Mittwoch, 07:00“ · weiter weg „Mo., 19. Okt., 07:00“.
 * `short` für die Startseite: „heute 07:00“ · „Mi 07:00“.
 */
export function formatNextRun(ts: number, { short = false, now = Date.now() } = {}): string {
  const days = dayOffset(ts, now);
  const time = timeFormat.format(ts);
  const sep = short ? ' ' : ', ';
  if (days === 0) return `heute${sep}${time}`;
  if (days === 1) return `morgen${sep}${time}`;
  if (days > 1 && days < 7) return `${short ? shortWeekday(ts) : weekdayFormat.format(ts)}${sep}${time}`;
  return `${dateFormat.format(ts)}, ${time}`;
}

/** Letzter Lauf: „heute 07:00“ · „gestern 07:00“ · „Mo., 5. Okt., 07:00“. */
export function formatPastRun(ts: number, now = Date.now()): string {
  const days = dayOffset(ts, now);
  const time = timeFormat.format(ts);
  if (days === 0) return `heute ${time}`;
  if (days === -1) return `gestern ${time}`;
  return `${dateFormat.format(ts)}, ${time}`;
}

export function createdText(created: number): string {
  if (created === 0) return 'keine neuen Leads';
  return created === 1 ? '1 neuer Lead im Tagesstapel' : `${created} neue Leads im Tagesstapel`;
}

/**
 * Stand des Tages über alle Läufe: „8 Läufe · 43 von 40 Leads“. Wunsch des Nutzers 15.10.: „Letzter Lauf … 7 neue
 * Leads“ las sich wie das ganze Tagesergebnis, obwohl es nur der letzte von acht Läufen war.
 */
export function todayText(today: { created: number; rounds: number }, target: number | null): string {
  const rounds = today.rounds === 1 ? '1 Lauf' : `${today.rounds} Läufe`;
  const leads = target ? `${today.created} von ${target} Leads` : today.created === 1 ? '1 neuer Lead' : `${today.created} neue Leads`;
  return `${rounds} · ${leads}`;
}

/** Satz zum letzten Lauf (ohne „läuft gerade“ – das zeigt die Oberfläche eigens). */
export function lastRunText(run: AutoSearchLastRun, now = Date.now()): string {
  const when = formatPastRun(run.startedAt, now);
  const how = run.manual ? ' (von Hand)' : '';
  const focus = run.focus ? ` · Suche: ${AUTO_SEARCH_FOCUS_LABELS[run.focus]}` : '';
  if (run.status === 'done') return `${when}${how} · ${createdText(run.created)}${focus}`;
  const fallback =
    run.status === 'failed' ? 'Fehlgeschlagen.' : run.status === 'skipped' ? 'Ausgelassen – es lief gerade eine andere Suche.' : 'Abgebrochen.';
  const created = run.created > 0 ? ` ${createdText(run.created)}.` : '';
  return `${when}${how} · ${run.message ?? fallback}${created}${focus}`;
}
