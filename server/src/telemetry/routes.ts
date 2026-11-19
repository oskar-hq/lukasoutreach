import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authRole } from '../../../shared/auth.js';
import { TELEMETRY_EVENT_NAMES, TELEMETRY_MAX_EVENTS, USAGE_REPORT_DAYS_DEFAULT, USAGE_REPORT_DAYS_MAX, type TelemetryBatch } from '../../../shared/telemetry.js';
import type { Database } from '../db/database.js';
import { dayFormatter } from '../learning/insights.js';
import { TelemetryStore, buildUsageReport, setJobSink } from './store.js';
import { LogStore, setLogSink } from './logs.js';

/**
 * Nutzungsdaten (Vertrag `shared/telemetry.ts`): misst jede `/api/*`-Anfrage (Route als Muster, Dauer, Status),
 * nimmt Ereignisse der Oberfläche an und liefert den Nutzungs-Bericht als Markdown.
 */
const EventSchema = z.object({
  name: z.enum(TELEMETRY_EVENT_NAMES),
  at: z.number(),
  view: z.string().max(80).nullable(),
  target: z.string().max(400).nullable(),
  ms: z.number().nullable().optional(),
  props: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
});
/** Das Paket als Ganzes; jedes Ereignis wird einzeln geprüft – ein kaputtes verwirft nicht die anderen. */
const BatchSchema = z.object({
  sessionId: z.string().min(1).max(64),
  events: z.array(z.unknown()).max(TELEMETRY_MAX_EVENTS),
  client: z.object({ width: z.number(), height: z.number(), standalone: z.boolean(), touch: z.boolean() }).optional(),
});

/**
 * Dauerverbindungen (Server-Sent Events): Die Antwort bleibt offen, solange der Lauf läuft – ihre „Dauer“ sagt nichts
 * über die Geschwindigkeit (10.11.: Ø 260 s, jede Anfrage „langsam“). Nicht mitmessen.
 */
const STREAM_ROUTES = new Set(['/api/lead-search/runs/:id/events']);

export function registerTelemetry(app: FastifyInstance, deps: { db: Database; timeZone: () => string }): TelemetryStore {
  const store = new TelemetryStore(deps.db, (at) => dayFormatter(deps.timeZone())(at));
  setJobSink((name, ms, ok, detail) => store.recordJob(name, ms, ok, detail ?? null, Date.now()));

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route || !route.startsWith('/api/') || route === '/api/telemetry/events' || STREAM_ROUTES.has(route)) return;
    try {
      store.recordApi(request.method, route, reply.statusCode, reply.elapsedTime, Date.now());
    } catch {
      // Messen ist Beiwerk.
    }
  });

  app.post('/api/telemetry/events', async (request, reply) => {
    const parsed = BatchSchema.safeParse(request.body ?? {});
    // Kaputte Pakete still verwerfen – die Oberfläche soll deshalb nie einen Fehler zeigen.
    if (parsed.success) {
      const user = request.authUser ? { username: request.authUser.username, role: authRole(request.authUser) } : null;
      try {
        const events = parsed.data.events.flatMap((event) => {
          const checked = EventSchema.safeParse(event);
          return checked.success ? [checked.data] : [];
        });
        store.recordEvents({ ...parsed.data, events } as TelemetryBatch, user, Date.now());
      } catch (error) {
        request.log.warn({ err: String(error) }, 'Nutzungsdaten nicht gespeichert');
      }
    }
    return reply.status(204).send();
  });

  app.get('/api/telemetry/report', async (request, reply) => {
    const parsed = z.object({ days: z.coerce.number().int().min(1).max(USAGE_REPORT_DAYS_MAX).default(USAGE_REPORT_DAYS_DEFAULT) }).safeParse(request.query);
    const days = parsed.success ? parsed.data.days : USAGE_REPORT_DAYS_DEFAULT;
    const now = Date.now();
    const markdown = buildUsageReport(deps.db, { now, days, timeZone: deps.timeZone() });
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="nutzungs-bericht-${dayFormatter(deps.timeZone())(now)}.md"`)
      .header('cache-control', 'no-store')
      .send(markdown);
  });

  // Server-Logs (Warnungen/Fehler, geschwärzt) – nachlesen per Claude-App (`server_logs`).
  const logs = new LogStore(deps.db);
  setLogSink((level, msg, detail) => {
    try {
      logs.write(level, msg, detail, Date.now());
    } catch {
      // Logs mitschreiben ist Beiwerk.
    }
  });
  app.get('/api/telemetry/logs', async (request) => {
    const query = z
      .object({
        hours: z.coerce.number().int().min(1).max(14 * 24).default(24),
        level: z.enum(['warn', 'error']).default('warn'),
        contains: z.string().trim().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .safeParse(request.query);
    const options = query.success ? query.data : { hours: 24, level: 'warn' as const, contains: undefined, limit: 100 };
    const levels = options.level === 'error' ? ['error', 'fatal'] : ['warn', 'error', 'fatal'];
    return { logs: logs.list({ since: Date.now() - options.hours * 60 * 60 * 1000, levels, contains: options.contains ?? null, limit: options.limit }) };
  });

  // Zustand jetzt (Systemzustand per Claude-App): was heute verbraucht ist und was zuletzt gescheitert ist.
  app.get('/api/telemetry/health', async () => {
    const now = Date.now();
    const today = dayFormatter(deps.timeZone())(now);
    const dayStart = now - 24 * 60 * 60 * 1000;
    const db = deps.db;
    const usage = db.prepare('SELECT account_id AS accountId, kind, count FROM linkedin_account_usage WHERE day = ? ORDER BY account_id').all(today);
    const usageBySource = db.prepare('SELECT account_id AS accountId, source, count FROM linkedin_usage_log WHERE day = ? ORDER BY account_id').all(today);
    const ai = db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS costUsd, MAX(at) AS lastAt FROM ai_usage WHERE at >= ?')
      .get(dayStart) as { calls: number; costUsd: number; lastAt: number | null };
    const lastAiAt = (db.prepare('SELECT MAX(at) AS at FROM ai_usage').get() as { at: number | null }).at;
    const jobs = db
      .prepare('SELECT name, COUNT(*) AS runs, SUM(1 - ok) AS failed, MAX(at) AS lastAt FROM job_runs WHERE at >= ? GROUP BY name ORDER BY name')
      .all(dayStart);
    const jobFailures = db.prepare('SELECT at, name, detail FROM job_runs WHERE at >= ? AND ok = 0 ORDER BY at DESC LIMIT 10').all(dayStart);
    const runs = db
      .prepare('SELECT started_at AS startedAt, status, auto, founder, profiles, qualified, error_message AS error FROM search_runs WHERE started_at >= ? ORDER BY started_at DESC LIMIT 15')
      .all(dayStart);
    const uiErrors = (db.prepare("SELECT COUNT(*) AS n FROM ui_events WHERE at >= ? AND name = 'error'").get(dayStart) as { n: number }).n;
    const logErrors = (db.prepare("SELECT COUNT(*) AS n FROM server_logs WHERE at >= ? AND level IN ('error', 'fatal')").get(dayStart) as { n: number }).n;
    return { now, today, usage, usageBySource, ai: { ...ai, lastEverAt: lastAiAt }, jobs, jobFailures, runs, uiErrors, logErrors };
  });

  app.addHook('onClose', async () => {
    setJobSink(null);
    setLogSink(null);
  });
  return store;
}
