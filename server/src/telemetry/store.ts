import {
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_KEEP_DAYS,
  TELEMETRY_MAX_EVENTS,
  TELEMETRY_SLOW_MS,
  type TelemetryBatch,
  type TelemetryEventName,
} from '../../../shared/telemetry.js';
import type { Database } from '../db/database.js';
import { dateTimeFormatter, dayFormatter, table } from '../learning/insights.js';

/**
 * Nutzungsdaten (Vertrag `shared/telemetry.ts`, Migration 51): Ereignisse der Oberfläche, jede API-Anfrage (je Tag und
 * Route zusammengefasst) und Hintergrund-Jobs – Grundlage für den Nutzungs-Bericht. Ohne Inhalte: keine Texte, keine
 * Namen von Leads. Alles älter als `TELEMETRY_KEEP_DAYS` fliegt raus.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const short = (value: unknown, max: number): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};

type JobSink = (name: string, ms: number, ok: boolean, detail?: string | null) => void;
let jobSink: JobSink | null = null;

export function setJobSink(next: JobSink | null): void {
  jobSink = next;
}

/** Ergebnis eines Jobs direkt melden (z. B. aus einem Rückruf ohne Promise). Wirft nie. */
export function noteJob(name: string, ms: number, ok: boolean, detail?: string | null): void {
  try {
    jobSink?.(name, ms, ok, detail ?? null);
  } catch {
    // Messen ist Beiwerk.
  }
}

/**
 * Hintergrund-Job messen (Abgleich, Übernahme neuer Kontakte, Sicherung …). Wirft wie `work`, misst trotzdem.
 * `failure`: Viele Jobs fangen ihre Fehler selbst (ein kaputter Account soll den Rest nicht aufhalten) und enden ohne
 * Ausnahme – dann zählten sie immer als gelungen (10.11.: Übernahme scheiterte den ganzen Abend, Bericht „0
 * gescheitert“). Liefert die Prüfung nach dem Lauf einen Satz, zählt der Lauf als gescheitert, mit diesem Grund.
 */
export async function trackJob<T>(name: string, work: () => Promise<T>, failure?: (result: T) => string | null | undefined): Promise<T> {
  const started = Date.now();
  try {
    const result = await work();
    try {
      const failed = failure?.(result) || null;
      jobSink?.(name, Date.now() - started, !failed, failed);
    } catch {
      // Messen ist Beiwerk.
    }
    return result;
  } catch (error) {
    try {
      jobSink?.(name, Date.now() - started, false, error instanceof Error ? error.message : String(error));
    } catch {
      // Messen ist Beiwerk.
    }
    throw error;
  }
}

export class TelemetryStore {
  private lastCleanup = 0;

  constructor(
    private readonly db: Database,
    private readonly dayOf: (at: number) => string,
  ) {}

  /** Ereignisse der Oberfläche. Unbekanntes wird still verworfen; Zeit vom Server, wenn die des Browsers spinnt. */
  recordEvents(batch: TelemetryBatch, user: { username: string; role: string } | null, now: number): number {
    const sessionId = short(batch.sessionId, 64) ?? 'unbekannt';
    const client = batch.client;
    const device = client ? `${client.standalone ? 'app' : client.width < 768 ? 'mobil' : 'desktop'}${client.touch ? '·touch' : ''}` : null;
    const insert = this.db.prepare(
      'INSERT INTO ui_events (at, username, role, session_id, name, view, target, ms, props, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let saved = 0;
    this.db.exec('BEGIN');
    try {
      for (const event of (batch.events ?? []).slice(0, TELEMETRY_MAX_EVENTS)) {
        if (!event || !(TELEMETRY_EVENT_NAMES as readonly string[]).includes(event.name)) continue;
        const at = Number.isFinite(event.at) && Math.abs(event.at - now) < DAY_MS ? event.at : now;
        const ms = Number.isFinite(event.ms) ? Math.max(0, Math.min(Math.round(event.ms as number), 24 * 60 * 60 * 1000)) : null;
        const props = event.props && typeof event.props === 'object' ? JSON.stringify(event.props).slice(0, 500) : null;
        insert.run(at, user?.username ?? null, user?.role ?? null, sessionId, event.name, short(event.view, 40), short(event.target, 160), ms, props, device);
        saved++;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.cleanup(now);
    return saved;
  }

  /** Eine API-Anfrage (Route als Muster, z. B. `/api/leads/:id`). */
  recordApi(method: string, route: string, status: number, ms: number, now: number): void {
    const statusClass = status >= 500 ? '5xx' : status >= 400 ? String(status) : status >= 300 ? '3xx' : '2xx';
    this.db
      .prepare(
        `INSERT INTO api_metrics (day, method, route, status_class, count, total_ms, max_ms, slow) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (day, method, route, status_class) DO UPDATE SET count = count + 1, total_ms = total_ms + excluded.total_ms,
           max_ms = MAX(max_ms, excluded.max_ms), slow = slow + excluded.slow`,
      )
      .run(this.dayOf(now), method, route.slice(0, 160), statusClass, ms, ms, ms >= TELEMETRY_SLOW_MS ? 1 : 0);
  }

  recordJob(name: string, ms: number, ok: boolean, detail: string | null, now: number): void {
    this.db.prepare('INSERT INTO job_runs (at, name, ms, ok, detail) VALUES (?, ?, ?, ?, ?)').run(now, name.slice(0, 60), Math.round(ms), ok ? 1 : 0, short(detail, 300));
    this.cleanup(now);
  }

  /** Höchstens einmal pro Stunde aufräumen. */
  private cleanup(now: number): void {
    if (now - this.lastCleanup < 60 * 60 * 1000) return;
    this.lastCleanup = now;
    const before = now - TELEMETRY_KEEP_DAYS * DAY_MS;
    this.db.prepare('DELETE FROM ui_events WHERE at < ?').run(before);
    this.db.prepare('DELETE FROM job_runs WHERE at < ?').run(before);
    this.db.prepare('DELETE FROM api_metrics WHERE day < ?').run(this.dayOf(before));
  }
}

// ── Bericht ──────────────────────────────────────────────────────────────────

const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;
const seconds = (ms: number | null) => (ms === null ? '–' : `${Math.round(ms / 100) / 10} s`);
const pct = (part: number, whole: number) => (whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toLocaleString('de-DE')} %` : '–');

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildUsageReport(db: Database, options: { now: number; days: number; timeZone: string }): string {
  const { now, days } = options;
  const day = dayFormatter(options.timeZone);
  const dateTime = dateTimeFormatter(options.timeZone);
  const from = now - days * DAY_MS;
  const fromDay = day(now - (days - 1) * DAY_MS);
  const all = <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).all(...params) as unknown as T[];
  type EventRow = { at: number; username: string | null; role: string | null; session_id: string; name: TelemetryEventName; view: string | null; target: string | null; ms: number | null; props: string | null; device: string | null };
  const events = all<EventRow>('SELECT at, username, role, session_id, name, view, target, ms, props, device FROM ui_events WHERE at >= ? ORDER BY at', from);
  const out: string[] = [];
  const section = (title: string, ...lines: string[]) => out.push(`\n## ${title}\n`, ...lines);

  out.push(
    '# Nutzungs-Bericht Outreach-Cockpit',
    '',
    `Erstellt: ${dateTime(now)} (${options.timeZone}) · Zeitraum: letzte ${days} Tage (ab ${fromDay}) · ${events.length.toLocaleString('de-DE')} Ereignisse`,
    '',
    '> Für Claude: Wie das Team das Cockpit benutzt – Ansichten, Klicks (`data-testid`), Tastaturkürzel, Zeit je Karte im',
    '> Tagesstapel, Fehler in der Oberfläche, Geschwindigkeit der API und Hintergrund-Jobs. Ohne Inhalte und ohne',
    '> Namen von Leads. Daraus: Was wird kaum benutzt, wo hakt es, was ist langsam, was scheitert.',
  );

  // ── Personen ──
  const people = new Map<string, { role: string; sessions: Set<string>; days: Set<string>; viewMs: number; clicks: number; hotkeys: number; cards: number }>();
  for (const event of events) {
    const key = event.username ?? 'unbekannt';
    const entry = people.get(key) ?? { role: event.role ?? '–', sessions: new Set(), days: new Set(), viewMs: 0, clicks: 0, hotkeys: 0, cards: 0 };
    entry.sessions.add(event.session_id);
    entry.days.add(day(event.at));
    if (event.name === 'view') entry.viewMs += event.ms ?? 0;
    if (event.name === 'click') entry.clicks++;
    if (event.name === 'hotkey') entry.hotkeys++;
    if (event.name === 'card') entry.cards++;
    people.set(key, entry);
  }
  section(
    'Wer das Cockpit wie nutzt',
    table(
      ['Konto', 'Rolle', 'aktive Tage', 'Sitzungen', 'Minuten in Ansichten', 'Klicks', 'Tastaturkürzel', 'Anteil Tastatur', 'Karten im Stapel'],
      [...people].map(([name, entry]) => [
        name,
        entry.role,
        entry.days.size,
        entry.sessions.size,
        minutes(entry.viewMs),
        entry.clicks,
        entry.hotkeys,
        pct(entry.hotkeys, entry.clicks + entry.hotkeys),
        entry.cards,
      ]),
    ),
  );

  // ── Geräte ──
  const devices = new Map<string, Set<string>>();
  for (const event of events) {
    const key = event.device ?? 'unbekannt';
    const set = devices.get(key) ?? new Set<string>();
    set.add(event.session_id);
    devices.set(key, set);
  }
  section('Geräte (Sitzungen)', table(['Gerät', 'Sitzungen'], [...devices].sort((a, b) => b[1].size - a[1].size).map(([key, set]) => [key, set.size])));

  // ── Ansichten ──
  const views = new Map<string, { visits: number; ms: number[] }>();
  for (const event of events) {
    if (event.name !== 'view' || !event.target) continue;
    const entry = views.get(event.target) ?? { visits: 0, ms: [] };
    entry.visits++;
    if (event.ms !== null) entry.ms.push(event.ms);
    views.set(event.target, entry);
  }
  section(
    'Ansichten',
    'Je Besuch einer Ansicht (Startseite, Fokus, Leads, Chats, Dashboard, Einstellungen …) die Verweildauer.',
    '',
    table(
      ['Ansicht', 'Besuche', 'Minuten gesamt', 'Median je Besuch'],
      [...views]
        .sort((a, b) => b[1].ms.reduce((x, y) => x + y, 0) - a[1].ms.reduce((x, y) => x + y, 0))
        .map(([name, entry]) => [name, entry.visits, minutes(entry.ms.reduce((x, y) => x + y, 0)), seconds(median(entry.ms))]),
    ),
  );

  // ── Klicks ──
  const clicks = new Map<string, number>();
  for (const event of events) {
    if (event.name !== 'click' || !event.target) continue;
    const key = `${event.view ?? '–'}|${event.target}`;
    clicks.set(key, (clicks.get(key) ?? 0) + 1);
  }
  const sortedClicks = [...clicks].sort((a, b) => b[1] - a[1]);
  section(
    'Klicks je Element',
    'Element = `data-testid` des angeklickten Knopfs/Links. Was hier fehlt, wurde im Zeitraum nie angeklickt.',
    '',
    table(['Ansicht', 'Element', 'Klicks'], sortedClicks.slice(0, 120).map(([key, count]) => [...key.split('|'), count])),
  );

  // ── Tastatur ──
  const hotkeys = new Map<string, number>();
  for (const event of events) {
    if (event.name !== 'hotkey' || !event.target) continue;
    const key = `${event.view ?? '–'}|${event.target}`;
    hotkeys.set(key, (hotkeys.get(key) ?? 0) + 1);
  }
  section('Tastaturkürzel', table(['Ansicht', 'Taste', 'Anzahl'], [...hotkeys].sort((a, b) => b[1] - a[1]).map(([key, count]) => [...key.split('|'), count])));

  // ── Tagesstapel ──
  const cards = new Map<string, { ms: number[]; outcomes: Map<string, number> }>();
  for (const event of events) {
    if (event.name !== 'card' || !event.target) continue;
    const entry = cards.get(event.target) ?? { ms: [], outcomes: new Map<string, number>() };
    if (event.ms !== null) entry.ms.push(event.ms);
    let outcome = 'ohne Aktion';
    try {
      const props = event.props ? (JSON.parse(event.props) as { outcome?: string }) : {};
      if (props.outcome) outcome = props.outcome;
    } catch {
      // egal
    }
    entry.outcomes.set(outcome, (entry.outcomes.get(outcome) ?? 0) + 1);
    cards.set(event.target, entry);
  }
  section(
    'Tagesstapel – Zeit je Karte',
    '„Ausgang“ = letzter Klick bzw. letzte Taste, bevor die Karte wechselte. Viel „ohne Aktion“ heißt: weggewischt, übersprungen oder abgebrochen.',
    '',
    table(
      ['Kartentyp', 'Karten', 'Median', 'Ausgänge (häufigste)'],
      [...cards].map(([type, entry]) => [
        type,
        entry.ms.length,
        seconds(median(entry.ms)),
        [...entry.outcomes]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([key, count]) => `${key}: ${count}`)
          .join(' · '),
      ]),
    ),
  );

  // ── Fehler der Oberfläche ──
  const errors = new Map<string, { count: number; views: Set<string>; last: number }>();
  for (const event of events) {
    if (event.name !== 'error') continue;
    const key = event.target ?? 'ohne Meldung';
    const entry = errors.get(key) ?? { count: 0, views: new Set<string>(), last: 0 };
    entry.count++;
    entry.views.add(event.view ?? '–');
    entry.last = Math.max(entry.last, event.at);
    errors.set(key, entry);
  }
  section(
    'Fehler in der Oberfläche',
    table(['Meldung', 'Anzahl', 'Ansichten', 'zuletzt'], [...errors].sort((a, b) => b[1].count - a[1].count).slice(0, 40).map(([key, entry]) => [key, entry.count, [...entry.views].join(', '), dateTime(entry.last)])),
  );

  // ── API aus Sicht der Oberfläche ──
  const apiSeen = new Map<string, { count: number; statuses: Map<string, number>; ms: number[] }>();
  for (const event of events) {
    if (event.name !== 'api' || !event.target) continue;
    const entry = apiSeen.get(event.target) ?? { count: 0, statuses: new Map<string, number>(), ms: [] };
    entry.count++;
    let status = '–';
    try {
      status = String((event.props ? (JSON.parse(event.props) as { status?: number }) : {}).status ?? '–');
    } catch {
      // egal
    }
    entry.statuses.set(status, (entry.statuses.get(status) ?? 0) + 1);
    if (event.ms !== null) entry.ms.push(event.ms);
    apiSeen.set(event.target, entry);
  }
  section(
    'Gescheiterte und langsame Anfragen (aus Sicht der Oberfläche)',
    `Gemeldet bei Fehler oder ab ${TELEMETRY_SLOW_MS / 1000} s. Status 0 = keine Verbindung.`,
    '',
    table(
      ['Pfad', 'Anzahl', 'Status', 'Median Dauer'],
      [...apiSeen].sort((a, b) => b[1].count - a[1].count).slice(0, 40).map(([path, entry]) => [path, entry.count, [...entry.statuses].map(([key, count]) => `${key}: ${count}`).join(' · '), seconds(median(entry.ms))]),
    ),
  );

  // ── API aus Sicht des Servers ──
  type ApiRow = { method: string; route: string; count: number; errors4: number; errors5: number; total_ms: number; max_ms: number; slow: number };
  const api = all<ApiRow>(
    `SELECT method, route, SUM(count) AS count,
       SUM(CASE WHEN status_class LIKE '4%' THEN count ELSE 0 END) AS errors4, SUM(CASE WHEN status_class = '5xx' THEN count ELSE 0 END) AS errors5,
       SUM(total_ms) AS total_ms, MAX(max_ms) AS max_ms, SUM(slow) AS slow
     FROM api_metrics WHERE day >= ? GROUP BY method, route ORDER BY count DESC LIMIT 80`,
    fromDay,
  );
  const statusRows = all<{ route: string; method: string; status_class: string; count: number }>(
    "SELECT route, method, status_class, SUM(count) AS count FROM api_metrics WHERE day >= ? AND status_class NOT IN ('2xx', '3xx') GROUP BY route, method, status_class ORDER BY count DESC LIMIT 40",
    fromDay,
  );
  section(
    'API (Server)',
    'Jede Anfrage an `/api/*`, je Route. Langsam = ab 1,5 s.',
    '',
    table(
      ['Methode', 'Route', 'Anfragen', '4xx', '5xx', 'Ø Dauer', 'max.', 'langsam'],
      api.map((row) => [row.method, row.route, row.count, row.errors4, row.errors5, `${Math.round(row.total_ms / Math.max(1, row.count))} ms`, `${Math.round(row.max_ms)} ms`, row.slow]),
    ),
    '',
    '### Fehler-Antworten nach Status',
    '',
    table(['Methode', 'Route', 'Status', 'Anzahl'], statusRows.map((row) => [row.method, row.route, row.status_class, row.count])),
  );

  // ── Jobs ──
  type JobRow = { name: string; runs: number; failed: number; avg: number; max: number; last_error: string | null; last_at: number };
  const jobs = all<JobRow>(
    `SELECT name, COUNT(*) AS runs, SUM(1 - ok) AS failed, AVG(ms) AS avg, MAX(ms) AS max, MAX(at) AS last_at,
       (SELECT detail FROM job_runs j2 WHERE j2.name = job_runs.name AND j2.ok = 0 AND j2.at >= ? ORDER BY at DESC LIMIT 1) AS last_error
     FROM job_runs WHERE at >= ? GROUP BY name ORDER BY runs DESC`,
    from,
    from,
  );
  const failedByDay = all<{ name: string; at: number; detail: string | null }>('SELECT name, at, detail FROM job_runs WHERE at >= ? AND ok = 0 ORDER BY at DESC LIMIT 30', from);
  section(
    'Hintergrund-Jobs',
    'LinkedIn-Abgleich, eingeplante Anfragen, Übernahme neuer Kontakte, Aufwärmen, Sicherungen … – wie oft, wie lange, wie oft gescheitert.',
    '',
    table(
      ['Job', 'Läufe', 'gescheitert', 'Ø Dauer', 'max.', 'zuletzt', 'letzter Fehler'],
      jobs.map((row) => [row.name, row.runs, row.failed, seconds(row.avg), seconds(row.max), dateTime(row.last_at), row.last_error]),
    ),
    '',
    '### Letzte Fehlschläge',
    '',
    table(['Zeit', 'Job', 'Fehler'], failedByDay.map((row) => [dateTime(row.at), row.name, row.detail])),
  );

  section(
    'Fragen an Claude',
    '1. Welche Ansichten und Knöpfe werden kaum benutzt – vereinfachen oder entfernen?',
    '2. Wo verbringt das Team viel Zeit je Karte, und was würde das beschleunigen (Kürzel, Vorschläge, weniger Klicks)?',
    '3. Welche Fehler und langsamen Anfragen treffen das Team am häufigsten?',
    '4. Welche Hintergrund-Jobs scheitern regelmäßig, und warum?',
  );
  return `${out.join('\n')}\n`;
}
