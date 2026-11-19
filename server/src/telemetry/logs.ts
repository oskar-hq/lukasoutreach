import type { Database } from '../db/database.js';

/**
 * Server-Logs zum Nachlesen per Claude-App (Nutzer 09.11.): Warnungen und Fehler des Backends landen zusätzlich in
 * der Datenbank (`server_logs`, Migration 52). Geheimnisse werden vorher geschwärzt – auch wenn sie laut Regel nie in
 * Logs stehen dürfen, gilt das hier doppelt. 14 Tage bzw. höchstens `LOG_MAX_ROWS` Zeilen.
 */
export const LOG_KEEP_DAYS = 14;
export const LOG_MAX_ROWS = 20_000;
const LEVELS: Record<number, 'warn' | 'error' | 'fatal'> = { 40: 'warn', 50: 'error', 60: 'fatal' };

/** Schlüssel, Tokens, Bearer-Werte und Passwörter schwärzen. */
export function redact(text: string): string {
  return text
    .replace(/(sk-[a-z]{2,6}-|sk-)[A-Za-z0-9_-]{8,}/g, '[geschwärzt]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[geschwärzt]')
    .replace(/("?(?:api[_-]?key|token|secret|password|passwort|authorization|cookie|x-api-key)"?\s*[:=]\s*)"?[^"\s,}]{4,}"?/gi, '$1[geschwärzt]')
    .replace(/\b[A-Za-z0-9]{40,}\b/g, '[geschwärzt]');
}

type Sink = (level: string, msg: string, detail: string | null) => void;
let sink: Sink | null = null;

export function setLogSink(next: Sink | null): void {
  sink = next;
}

/**
 * Für `pino`-Optionen `hooks.logMethod`: ab Stufe „warn“ eine Kopie an die Datenbank. Wirft nie und ändert die
 * normale Ausgabe nicht.
 */
export function captureLog(args: unknown[], level: number): void {
  const name = LEVELS[level];
  if (!name || !sink) return;
  try {
    const [first, second] = args;
    let msg = '';
    let detail: string | null = null;
    if (typeof first === 'string') msg = first;
    else if (first && typeof first === 'object') {
      msg = typeof second === 'string' ? second : first instanceof Error ? first.message : ((first as { msg?: string }).msg ?? '');
      const { req: _req, res: _res, ...rest } = first as Record<string, unknown>;
      const plain = first instanceof Error ? { err: first.stack ?? first.message } : rest;
      detail = JSON.stringify(plain, (_key, value) => (value instanceof Error ? (value.stack ?? value.message) : value)).slice(0, 2000);
    }
    sink(name, redact(msg || '(ohne Text)').slice(0, 500), detail ? redact(detail) : null);
  } catch {
    // Logs mitschreiben ist Beiwerk.
  }
}

export class LogStore {
  private written = 0;

  constructor(private readonly db: Database) {}

  write(level: string, msg: string, detail: string | null, now: number): void {
    this.db.prepare('INSERT INTO server_logs (at, level, msg, detail) VALUES (?, ?, ?, ?)').run(now, level, msg, detail);
    if (++this.written % 200 === 0) {
      this.db.prepare('DELETE FROM server_logs WHERE at < ?').run(now - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000);
      this.db.prepare('DELETE FROM server_logs WHERE id <= (SELECT MAX(id) FROM server_logs) - ?').run(LOG_MAX_ROWS);
    }
  }

  list(options: { since: number; levels: readonly string[]; contains?: string | null; limit: number }): Array<{ at: number; level: string; msg: string; detail: string | null }> {
    const placeholders = options.levels.map(() => '?').join(', ');
    const like = options.contains ? `%${options.contains}%` : null;
    return this.db
      .prepare(
        `SELECT at, level, msg, detail FROM server_logs WHERE at >= ? AND level IN (${placeholders})
         ${like ? 'AND (msg LIKE ? OR detail LIKE ?)' : ''} ORDER BY at DESC LIMIT ?`,
      )
      .all(options.since, ...options.levels, ...(like ? [like, like] : []), options.limit) as Array<{ at: number; level: string; msg: string; detail: string | null }>;
  }
}
