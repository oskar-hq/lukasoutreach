import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  FEEDBACK_ANSWER_MAX,
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_TEXT_MAX,
  type FeedbackItem,
  type FeedbackListResponse,
} from '../../../shared/feedback.js';
import type { CockpitCall } from './settingsTools.js';

/**
 * Feedback per Claude-App (Nutzer 09.11.): Kunden melden Fehler und Wünsche auch einfach im Chat (`submit_feedback`),
 * Entwickler lesen alles samt Bildschirmfoto und Zusammenhang (`list_feedback`, `feedback_detail`) und setzen den Stand
 * mit Antwort (`update_feedback`) – der Melder sieht es in der Glocke.
 */
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export type RawCall = (url: string) => Promise<{ status: number; body: Buffer; type: string }>;

const time = (at: number) => new Date(at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

function line(item: FeedbackItem): string {
  return `- **#${item.number}** (id ${item.id}) · ${FEEDBACK_KIND_LABELS[item.kind]} · ${FEEDBACK_STATUS_LABELS[item.status]} · ${item.by} · ${time(item.createdAt)}${item.imageCount ? ` · ${item.imageCount} Bild(er)` : ''}${item.context?.view ? ` · Ansicht ${item.context.view}` : ''}\n  ${item.text.length > 300 ? `${item.text.slice(0, 300)}…` : item.text}${item.answer ? `\n  Antwort: ${item.answer}` : ''}`;
}

export function registerFeedbackTools(server: McpServer, call: CockpitCall, raw: RawCall): void {
  server.registerTool(
    'submit_feedback',
    {
      title: 'Feedback senden',
      description:
        'Einen Fehler, Wunsch oder eine Frage zum Cockpit an die Entwickler schicken – z. B. wenn der Nutzer im Chat sagt, dass etwas nicht geht oder anders sein soll. Schreib es so, dass ein Entwickler es versteht: was der Nutzer getan hat, was passiert ist, was er erwartet hat bzw. was er sich wünscht, betroffener Lead (Link) falls bekannt. Vorher kurz mit dem Nutzer abstimmen, außer er hat es ausdrücklich verlangt.',
      inputSchema: {
        text: z.string().trim().min(3).max(FEEDBACK_TEXT_MAX),
        kind: z.enum(FEEDBACK_KINDS).optional().describe('bug = etwas geht nicht, wish = Idee/Wunsch, question = Frage'),
        lead_id: z.string().trim().max(64).optional().describe('Betroffener Lead, falls es um einen geht'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ text, kind, lead_id }) => {
      const created = await call<FeedbackItem>('POST', '/api/feedback', { text, kind: kind ?? null, context: { view: 'claude-app', leadId: lead_id ?? null, trail: [], errors: [] } });
      if (!created.ok) return fail(created.message);
      return ok(`Gemeldet als #${created.body.number} (${FEEDBACK_KIND_LABELS[created.body.kind]}). Die Entwickler sehen es sofort; ändert sich der Stand, steht es in der Glocke im Cockpit.`);
    },
  );

  server.registerTool(
    'list_feedback',
    {
      title: 'Feedback lesen',
      description: 'Gemeldete Fehler, Wünsche und Fragen, neueste zuerst. Standard: alle offenen (eingegangen, eingeplant, in Arbeit). Details mit Bildschirmfoto und Zusammenhang: feedback_detail.',
      inputSchema: {
        status: z.enum([...FEEDBACK_STATUSES, 'open', 'all'] as const).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, limit }) => {
      const params = new URLSearchParams({ limit: String(limit ?? 50) });
      if ((status ?? 'open') !== 'all') params.set('status', status ?? 'open');
      const list = await call<FeedbackListResponse>('GET', `/api/feedback?${params}`);
      if (!list.ok) return fail(list.message);
      if (!list.body.items.length) return ok('Kein Feedback in dieser Auswahl.');
      return ok([`# Feedback (${list.body.items.length})`, ...list.body.items.map(line)].join('\n'));
    },
  );

  server.registerTool(
    'feedback_detail',
    {
      title: 'Feedback im Detail',
      description:
        'Eine Meldung komplett (id oder Nummer wie „12“): Text, Stand, Antwort, Ansicht, offener Lead, die letzten Schritte des Nutzers (Klicks, Tasten, Ansichten), Fehler und gescheiterte Anfragen kurz davor, Gerät, Version – und die Bilder (automatisches Bildschirmfoto + eigene).',
      inputSchema: { id: z.string().trim().min(1).max(64), images: z.boolean().optional().describe('Bilder mitsenden (Standard ja)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, images }) => {
      const item = await call<FeedbackItem>('GET', `/api/feedback/${encodeURIComponent(id.replace(/^#/, ''))}`);
      if (!item.ok) return fail(item.message);
      const f = item.body;
      const c = f.context;
      const text = [
        `# Feedback #${f.number} – ${FEEDBACK_KIND_LABELS[f.kind]} · ${FEEDBACK_STATUS_LABELS[f.status]}`,
        `Von ${f.by} (${f.username}) · ${time(f.createdAt)} · zuletzt geändert ${time(f.updatedAt)} · id ${f.id}`,
        '',
        f.text,
        f.answer ? `\nAntwort an den Melder: ${f.answer}` : '',
        '',
        '## Zusammenhang (automatisch)',
        `- Ansicht: ${c?.view ?? '–'}${c?.leadId ? ` · offener Lead: ${c.leadId} (lead_detail)` : ''}${c?.path ? ` · Adresse: ${c.path}` : ''}`,
        `- Version: ${c?.version ?? '–'} · Gerät: ${c?.device ? `${c.device.width}×${c.device.height}${c.device.standalone ? ', als App' : ''}${c.device.touch ? ', Touch' : ''} · ${c.device.userAgent}` : '–'}`,
        '',
        '### Letzte Schritte (älteste zuerst)',
        ...(c?.trail?.length ? c.trail.map((step) => `- ${step}`) : ['- keine']),
        '',
        '### Fehler und gescheiterte Anfragen kurz davor',
        ...(c?.errors?.length ? c.errors.map((error) => `- ${error}`) : ['- keine']),
        '',
        `Weiter: Stand setzen mit update_feedback (z. B. in_progress, done + Antwort). Mehr Daten: usage_report, server_logs, system_status.`,
      ]
        .filter((part) => part !== '')
        .join('\n');
      const content: Content[] = [{ type: 'text', text }];
      if (images !== false) {
        for (let n = 1; n <= f.imageCount; n++) {
          const image = await raw(`/api/feedback/${f.id}/images/${n}`);
          if (image.status === 200) content.push({ type: 'image', data: image.body.toString('base64'), mimeType: image.type });
        }
      }
      return { content };
    },
  );

  server.registerTool(
    'update_feedback',
    {
      title: 'Feedback-Stand setzen',
      description: `Stand einer Meldung setzen und dem Melder antworten – er sieht es in der Glocke. Stände: ${FEEDBACK_STATUSES.map((status) => `${status} = ${FEEDBACK_STATUS_LABELS[status]}`).join(', ')}. Antwort kurz und per du, z. B. „Ist behoben, ab dem nächsten Update da.“`,
      inputSchema: {
        id: z.string().trim().min(1).max(64),
        status: z.enum(FEEDBACK_STATUSES).optional(),
        answer: z.string().trim().max(FEEDBACK_ANSWER_MAX).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, status, answer }) => {
      if (!status && answer === undefined) return fail('Nichts zu ändern angegeben.');
      const found = await call<FeedbackItem>('GET', `/api/feedback/${encodeURIComponent(id.replace(/^#/, ''))}`);
      if (!found.ok) return fail(found.message);
      const updated = await call<FeedbackItem>('PATCH', `/api/feedback/${found.body.id}`, { ...(status ? { status } : {}), ...(answer !== undefined ? { answer } : {}) });
      if (!updated.ok) return fail(updated.message);
      return ok(`#${updated.body.number}: ${FEEDBACK_STATUS_LABELS[updated.body.status]}${updated.body.answer ? ` – Antwort: ${updated.body.answer}` : ''}. Der Melder sieht es in der Glocke.`);
    },
  );
}
