import type { Weekday } from '../../../shared/autoSearch.js';
import { localTime } from '../linkedin/guard.js';

/**
 * Zeitrechnung der automatischen Lead-Suche in einer festen Zeitzone (`AUTO_SEARCH_TIME_ZONE`) – ohne Zusatzpaket,
 * nur mit `Intl.DateTimeFormat` (über `localTime`). Sommer-/Winterzeit:
 *   - Uhrzeit fällt in die übersprungene Stunde (Ende März, z. B. 02:30) → an diesem Tag kein Lauf.
 *   - Uhrzeit gibt es doppelt (Ende Oktober, 02:00–02:59) → nur ein Lauf, beim ersten Mal (Kennung je Tag + Uhrzeit).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const pad = (value: number) => String(value).padStart(2, '0');

/** Wandzeit „HH:MM“ der Zeitzone zum Zeitpunkt `now`. */
export function localClock(now: number, timeZone: string): { day: string; weekday: number; time: string } {
  const local = localTime(now, timeZone);
  return { day: local.day, weekday: local.weekday, time: `${pad(local.hour)}:${pad(local.minute)}` };
}

/**
 * Kennung eines fälligen Laufs („2026-10-05 07:00“), wenn `now` in der geplanten Minute liegt – sonst null.
 * Dieselbe Kennung verhindert doppeltes Auslösen (auch nach einem Neustart in derselben Minute).
 */
export function dueSlot(now: number, days: readonly Weekday[], time: string, timeZone: string): string | null {
  const local = localClock(now, timeZone);
  if (local.time !== time || !days.includes(local.weekday as Weekday)) return null;
  return `${local.day} ${time}`;
}

/** Wie `dueSlot`, für mehrere Uhrzeiten am Tag (`time` und `secondTime`) – die erste passende. */
export function dueSlotAny(now: number, days: readonly Weekday[], times: readonly string[], timeZone: string): string | null {
  for (const time of times) {
    const key = dueSlot(now, days, time, timeZone);
    if (key) return key;
  }
  return null;
}

/** Nächster Termin über mehrere Uhrzeiten (der früheste) – null ohne Tage. */
export function nextRunAtAny(now: number, days: readonly Weekday[], times: readonly string[], timeZone: string): number | null {
  const next = times.map((time) => nextRunAt(now, days, time, timeZone)).filter((at): at is number => at !== null);
  return next.length ? Math.min(...next) : null;
}

/** Abstand der Zeitzone zu UTC in ms zum Zeitpunkt `at` (Berlin: +1 h oder +2 h). */
function offsetAt(at: number, timeZone: string): number {
  const local = localTime(at, timeZone);
  const [y, m, d] = local.day.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, local.hour, local.minute, local.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Erster Zeitpunkt, an dem in der Zeitzone `date` (Y, M, D) um `time` ist – null, wenn es die Uhrzeit nicht gibt. */
function instantOf(year: number, month: number, day: number, time: string, timeZone: string): number | null {
  const [hour, minute] = time.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Beide möglichen Abstände (vor und nach einer Umstellung) probieren, den frühesten passenden nehmen.
  const candidates = [...new Set([naive - offsetAt(naive - DAY_MS / 2, timeZone), naive - offsetAt(naive + DAY_MS / 2, timeZone)])].sort(
    (a, b) => a - b,
  );
  const wanted = `${year}-${pad(month)}-${pad(day)}`;
  for (const at of candidates) {
    const local = localClock(at, timeZone);
    if (local.day === wanted && local.time === time) return at;
  }
  return null;
}

/** Nächster geplanter Lauf strikt nach `now` (ms) – null ohne Tage. */
export function nextRunAt(now: number, days: readonly Weekday[], time: string, timeZone: string): number | null {
  if (days.length === 0) return null;
  const today = localTime(now, timeZone).day.split('-').map(Number);
  // 8 Tage reichen für jeden Wochentag; einer mehr für einen ausgefallenen Termin (Zeitumstellung).
  for (let offset = 0; offset <= 15; offset++) {
    const date = new Date(Date.UTC(today[0], today[1] - 1, today[2] + offset));
    const weekday = ((date.getUTCDay() + 6) % 7) + 1;
    if (!days.includes(weekday as Weekday)) continue;
    const at = instantOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), time, timeZone);
    if (at !== null && at > now) return at;
  }
  return null;
}
