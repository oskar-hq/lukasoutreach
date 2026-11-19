import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LeadSearchConfig } from '../../../shared/leadSearch.js';
import type { LinkedInAccountsResponse, LinkedInLimit, LinkedInStatusResponse } from '../../../shared/linkedin.js';
import type { NotificationListResponse } from '../../../shared/notifications.js';
import type { SettingsTestResponse } from '../../../shared/settings.js';
import type { BackupListResponse, UpdateStatusResponse } from '../../../shared/system.js';
import { USAGE_SOURCE_LABELS, type UsageSource } from '../linkedin/accountUsage.js';
import type { CockpitCall } from './settingsTools.js';

/**
 * Systemzustand per Claude-App (Nutzer 09.11.: „damit es nicht daran scheitert, dass ich dir etwas geben muss“):
 * Neuigkeiten aus der Glocke, Zustand jetzt (Dienste, Accounts und ihr Verbrauch heute, Update, Speicher, KI,
 * Hintergrund-Jobs, Läufe) und die Server-Logs (Warnungen/Fehler, geschwärzt). Nur Gründer und Admin (`roleDenial`).
 */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const READ = { readOnlyHint: true, openWorldHint: false } as const;

const time = (at: number | null | undefined) =>
  at ? new Date(at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024).toLocaleString('de-DE')} MB`;

interface Health {
  today: string;
  usage: Array<{ accountId: string; kind: 'profile' | 'search'; count: number }>;
  usageBySource: Array<{ accountId: string; source: UsageSource; count: number }>;
  ai: { calls: number; costUsd: number; lastAt: number | null; lastEverAt: number | null };
  jobs: Array<{ name: string; runs: number; failed: number; lastAt: number }>;
  jobFailures: Array<{ at: number; name: string; detail: string | null }>;
  runs: Array<{ startedAt: number; status: string; auto: number; founder: string | null; profiles: number; qualified: number; error: string | null }>;
  uiErrors: number;
  logErrors: number;
}

export function registerSystemTools(server: McpServer, call: CockpitCall): void {
  server.registerTool(
    'notifications',
    {
      title: 'Neuigkeiten (Glocke)',
      description:
        'Die Meldungen aus der Glocke oben rechts: z. B. KI-Guthaben aufgebraucht, LinkedIn-Account gesperrt/pausiert, Unipile nicht erreichbar, Lead-Suche abgebrochen, Speicher knapp, Update fehlgeschlagen – mit Zeit, Häufigkeit und was zu tun ist.',
      annotations: READ,
    },
    async () => {
      const list = await call<NotificationListResponse>('GET', '/api/notifications');
      if (!list.ok) return fail(list.message);
      if (!list.body.notifications.length) return ok('Keine Neuigkeiten.');
      return ok(
        [
          `# Neuigkeiten (${list.body.notifications.length}, ungelesen ${list.body.unread})`,
          ...list.body.notifications.map(
            (item) =>
              `- **${item.title}** (${item.severity}, ${item.kind}${item.count > 1 ? `, ${item.count}×` : ''}) · zuerst ${time(item.createdAt)}, zuletzt ${time(item.updatedAt)}\n  ${item.text}`,
          ),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'system_status',
    {
      title: 'Systemzustand jetzt',
      description:
        'Wie es gerade aussieht: Lead-Suche bereit/Probleme, LinkedIn-Accounts (verbunden, deaktiviert, Verbrauch heute gegen das Limit, wofür), Senden-Status, KI-Aufrufe der letzten 24 h und wann zuletzt erfolgreich, Hintergrund-Jobs und ihre Fehler, Läufe der letzten 24 h, Update-Stand, Speicher, Fehlerzähler. Mit test: true zusätzlich ein Live-Verbindungstest zu Anthropic und Unipile (höchstens einmal pro Minute je Dienst).',
      inputSchema: { test: z.boolean().optional().describe('Anthropic und Unipile jetzt live testen') },
      annotations: READ,
    },
    async ({ test }) => {
      const lines: string[] = ['# Systemzustand'];
      const [config, accounts, health, update, backups, notifications] = await Promise.all([
        call<LeadSearchConfig>('GET', '/api/lead-search/config'),
        call<LinkedInAccountsResponse>('GET', '/api/linkedin/accounts'),
        call<Health>('GET', '/api/telemetry/health'),
        call<UpdateStatusResponse>('GET', '/api/system/update'),
        call<BackupListResponse>('GET', '/api/system/backups'),
        call<NotificationListResponse>('GET', '/api/notifications'),
      ]);

      if (test) {
        lines.push('', '## Verbindungstest jetzt');
        for (const service of ['anthropic', 'unipile'] as const) {
          const result = await call<SettingsTestResponse>('POST', '/api/settings/test', { service });
          lines.push(`- ${service}: ${result.ok ? `${result.body.ok ? 'OK' : 'FEHLER'} – ${result.body.message}` : `nicht getestet – ${result.message}`}`);
        }
      }

      lines.push('', '## Lead-Suche');
      if (config.ok) {
        lines.push(`- Modus ${config.body.mode} · bereit: ${config.body.ready ? 'ja' : 'nein'} · Modell ${config.body.live?.model ?? '–'} · Warteliste ${config.body.backlog ?? 0}`);
        for (const problem of config.body.problems) lines.push(`- Problem: ${problem}`);
        for (const warning of config.body.warnings) lines.push(`- Hinweis: ${warning}`);
      } else lines.push(`- nicht lesbar: ${config.message}`);

      lines.push('', '## LinkedIn-Accounts heute');
      if (accounts.ok && health.ok) {
        const used = (id: string, kind: 'profile' | 'search') => health.body.usage.find((row) => row.accountId === id && row.kind === kind)?.count ?? 0;
        for (const account of accounts.body.accounts) {
          const limits = { ...account.limitDefaults, ...Object.fromEntries(Object.entries(account.limits ?? {}).filter(([, value]) => value !== null)) } as {
            profilesPerDay?: number;
            searchResultsPerDay?: number;
          };
          const sources = health.body.usageBySource
            .filter((row) => row.accountId === account.id)
            .map((row) => `${USAGE_SOURCE_LABELS[row.source] ?? row.source} ${row.count}`)
            .join(', ');
          lines.push(
            `- **${account.name}** (${account.assignedTo ? `Gründer ${account.assignedTo}` : account.warmup ? 'Aufwärmen' : 'Suche'}${account.disabled ? ', DEAKTIVIERT' : ''}) · Profile ${used(account.id, 'profile')}/${limits.profilesPerDay ?? '–'} · Suchtreffer ${used(account.id, 'search')}/${limits.searchResultsPerDay ?? '–'}${sources ? ` · wofür: ${sources}` : ''}`,
          );
        }
      } else lines.push(`- nicht lesbar: ${accounts.ok ? '' : accounts.message} ${health.ok ? '' : health.message}`.trim());

      const status = await call<LinkedInStatusResponse>('GET', '/api/linkedin/status');
      if (status.ok && status.body.accounts.length) {
        const limit = (value: LinkedInLimit) => `${value.used}/${value.limit}`;
        lines.push('', `## Senden über LinkedIn (Modus ${status.body.mode}, letzter Abgleich ${time(status.body.lastSyncAt)})`);
        for (const account of status.body.accounts) {
          lines.push(
            `- ${account.founder}: ${account.connected ? 'verbunden' : 'NICHT verbunden'}${account.pausedUntil ? ` · PAUSIERT bis ${time(account.pausedUntil)}${account.pauseReason ? ` (${account.pauseReason})` : ''}` : ''} · Anfragen heute ${limit(account.invitesToday)}, Woche ${limit(account.invitesWeek)} · Nachrichten heute ${limit(account.messagesToday)}${account.queuedInvites ? ` · eingeplant ${account.queuedInvites}` : ''}`,
          );
        }
      }

      if (health.ok) {
        const h = health.body;
        lines.push(
          '',
          '## KI (Anthropic)',
          `- letzte 24 h: ${h.ai.calls} Aufrufe, ${(h.ai.costUsd * 0.86).toLocaleString('de-DE', { maximumFractionDigits: 3 })} € · zuletzt erfolgreich ${time(h.ai.lastEverAt)}`,
          h.ai.calls === 0 ? '- Achtung: in 24 h kein erfolgreicher KI-Aufruf – Guthaben/Schlüssel prüfen (notifications, server_logs).' : '',
          '',
          '## Hintergrund-Jobs (24 h)',
          ...(h.jobs.length ? h.jobs.map((job) => `- ${job.name}: ${job.runs} Läufe, ${job.failed} gescheitert, zuletzt ${time(job.lastAt)}`) : ['- keine gemessen']),
          ...h.jobFailures.map((row) => `  - ${time(row.at)} ${row.name}: ${row.detail ?? 'ohne Text'}`),
          '',
          '## Läufe der Lead-Suche (24 h)',
          ...(h.runs.length
            ? h.runs.map((run) => `- ${time(run.startedAt)} ${run.auto ? 'automatisch' : 'von Hand'}${run.founder ? ` (${run.founder})` : ''}: ${run.status}, ${run.profiles} Profile, ${run.qualified} qualifiziert${run.error ? ` – ${run.error}` : ''}`)
            : ['- keine']),
          '',
          `## Fehlerzähler (24 h): Oberfläche ${h.uiErrors} · Server-Logs ${h.logErrors} (Details: usage_report, server_logs)`,
        );
      }

      lines.push('', '## Update und Speicher');
      if (update.ok) {
        const u = update.body;
        lines.push(
          `- Update-Dienst ${u.available ? 'bereit' : `nicht bereit (${u.reason ?? '–'})`} · läuft: ${u.current ? `${u.current.commit} ${u.current.title}` : '–'} · ${u.behind} neue Änderungen · Zustand ${u.state}${u.lastRun ? ` · letzter Lauf ${time(u.lastRun.startedAt)} ${u.lastRun.ok === false ? `FEHLGESCHLAGEN: ${u.lastRun.message}` : u.lastRun.ok ? 'ok' : 'läuft'}` : ''}`,
        );
      } else lines.push(`- Update: ${update.message}`);
      if (backups.ok) {
        const disk = backups.body.disk;
        lines.push(`- Speicher: ${disk ? `${mb(disk.freeBytes)} frei von ${mb(disk.totalBytes)}${disk.low ? ' – KNAPP' : ''}` : '–'} · Sicherungen ${backups.body.backups.length}, neueste ${time(backups.body.backups[0]?.createdAt)}`);
      }
      if (notifications.ok && notifications.body.notifications.length) {
        lines.push('', `## Neuigkeiten: ${notifications.body.notifications.length} (Details: notifications)`, ...notifications.body.notifications.slice(0, 5).map((item) => `- ${item.title} · ${time(item.updatedAt)}`));
      }
      return ok(lines.filter((line) => line !== '').join('\n').replace(/\n## /g, '\n\n## '));
    },
  );

  server.registerTool(
    'server_logs',
    {
      title: 'Server-Logs',
      description: 'Warnungen und Fehler des Backends (Geheimnisse geschwärzt), neueste zuerst. Mit contains nach einem Wort filtern (z. B. „Anthropic“, „Unipile“, „Kontakt“).',
      inputSchema: {
        hours: z.number().int().min(1).max(336).optional().describe('Zeitraum in Stunden (Standard 24, höchstens 14 Tage)'),
        level: z.enum(['warn', 'error']).optional().describe('warn = Warnungen und Fehler (Standard), error = nur Fehler'),
        contains: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: READ,
    },
    async ({ hours, level, contains, limit }) => {
      const params = new URLSearchParams({ hours: String(hours ?? 24), level: level ?? 'warn', limit: String(limit ?? 100) });
      if (contains) params.set('contains', contains);
      const result = await call<{ logs: Array<{ at: number; level: string; msg: string; detail: string | null }> }>('GET', `/api/telemetry/logs?${params}`);
      if (!result.ok) return fail(result.message);
      if (!result.body.logs.length) return ok('Keine Einträge im Zeitraum.');
      return ok(result.body.logs.map((row) => `- ${time(row.at)} [${row.level}] ${row.msg}${row.detail && row.detail !== '{}' ? `\n  ${row.detail.slice(0, 600)}` : ''}`).join('\n'));
    },
  );
}
