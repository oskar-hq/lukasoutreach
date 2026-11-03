import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { AssistantChatDetail, AssistantChatSummary, AssistantMessage, AssistantToolUse } from '../../../shared/assistant.js';
import type { Database } from '../db/database.js';

/** Chats des KI-Assistenten (Migration 40) – je Konto (`username`), nur das Konto selbst sieht sie. */

const NEW_CHAT_TITLE = 'Neuer Chat';
const TITLE_MAX = 80;

interface ChatRow {
  id: string;
  username: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  cost: number | null;
}

interface MessageRow {
  id: string;
  role: string;
  text: string;
  at: number;
  model: string | null;
  tools: string | null;
  cost_eur: number | null;
  failed: number;
}

const toSummary = (row: ChatRow): AssistantChatSummary => ({
  id: row.id,
  title: row.title,
  model: row.model,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  costEur: Math.round((row.cost ?? 0) * 10_000) / 10_000,
});

const toMessage = (row: MessageRow): AssistantMessage => ({
  id: row.id,
  role: row.role === 'assistant' ? 'assistant' : 'user',
  text: row.text,
  at: row.at,
  ...(row.model ? { model: row.model } : {}),
  ...(row.tools ? { tools: JSON.parse(row.tools) as AssistantToolUse[] } : {}),
  ...(row.cost_eur !== null ? { costEur: row.cost_eur } : {}),
  ...(row.failed ? { failed: true } : {}),
});

const SUMMARY_SELECT =
  'SELECT c.id, c.username, c.title, c.model, c.created_at, c.updated_at, (SELECT SUM(cost_eur) FROM assistant_messages m WHERE m.chat_id = c.id) AS cost FROM assistant_chats c';

export class AssistantStore {
  constructor(private readonly db: Database) {}

  list(username: string): AssistantChatSummary[] {
    const rows = this.db.prepare(`${SUMMARY_SELECT} WHERE c.username = ? ORDER BY c.updated_at DESC LIMIT 200`).all(username) as unknown as ChatRow[];
    return rows.map(toSummary);
  }

  create(username: string, model: string, now = Date.now()): AssistantChatDetail {
    const id = randomUUID();
    this.db.prepare('INSERT INTO assistant_chats (id, username, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, NEW_CHAT_TITLE, model, now, now);
    return this.get(username, id)!;
  }

  summary(username: string, id: string): AssistantChatSummary | null {
    const row = this.db.prepare(`${SUMMARY_SELECT} WHERE c.id = ? AND c.username = ?`).get(id, username) as ChatRow | undefined;
    return row ? toSummary(row) : null;
  }

  get(username: string, id: string): AssistantChatDetail | null {
    const summary = this.summary(username, id);
    if (!summary) return null;
    const rows = this.db.prepare('SELECT * FROM assistant_messages WHERE chat_id = ? ORDER BY at ASC, rowid ASC').all(id) as unknown as MessageRow[];
    return { ...summary, messages: rows.map(toMessage) };
  }

  delete(username: string, id: string): boolean {
    return this.db.prepare('DELETE FROM assistant_chats WHERE id = ? AND username = ?').run(id, username).changes > 0;
  }

  /** Verlauf für die Anthropic-API – unverändert, wie er gesendet und empfangen wurde. */
  apiMessages(id: string): Anthropic.MessageParam[] {
    const row = this.db.prepare('SELECT api_messages FROM assistant_chats WHERE id = ?').get(id) as { api_messages: string } | undefined;
    return row ? (JSON.parse(row.api_messages) as Anthropic.MessageParam[]) : [];
  }

  setApiMessages(id: string, messages: Anthropic.MessageParam[]): void {
    this.db.prepare('UPDATE assistant_chats SET api_messages = ? WHERE id = ?').run(JSON.stringify(messages), id);
  }

  /** Frage speichern; die erste Frage gibt dem Chat seinen Titel. */
  addQuestion(id: string, text: string, model: string, now = Date.now()): AssistantMessage {
    const message: AssistantMessage = { id: randomUUID(), role: 'user', text, at: now };
    this.db.prepare('INSERT INTO assistant_messages (id, chat_id, role, text, at) VALUES (?, ?, ?, ?, ?)').run(message.id, id, 'user', text, now);
    const title = text.replace(/\s+/g, ' ').trim();
    this.db
      .prepare(`UPDATE assistant_chats SET updated_at = ?, model = ?, title = CASE WHEN title = ? THEN ? ELSE title END WHERE id = ?`)
      .run(now, model, NEW_CHAT_TITLE, title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title, id);
    return message;
  }

  addAnswer(id: string, answer: Omit<AssistantMessage, 'id' | 'role'>): AssistantMessage {
    const message: AssistantMessage = { id: randomUUID(), role: 'assistant', ...answer };
    this.db
      .prepare('INSERT INTO assistant_messages (id, chat_id, role, text, at, model, tools, cost_eur, failed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(message.id, id, 'assistant', message.text, message.at, message.model ?? null, message.tools?.length ? JSON.stringify(message.tools) : null, message.costEur ?? null, message.failed ? 1 : 0);
    this.db.prepare('UPDATE assistant_chats SET updated_at = ? WHERE id = ?').run(message.at, id);
    return message;
  }
}
