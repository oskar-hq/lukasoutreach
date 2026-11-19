import type { Database } from '../db/database.js';

/**
 * Eigene KI-Prompts je Instanz (Lukas-Instanz 19.11.): Die Standardtexte sind auf Kapitalanlage-Vertriebe und
 * Finanzdienstleister geschrieben. Jeder Prompt lässt sich hier ersetzen – die technischen Ausgabe-Regeln (Felder,
 * Kategorien, Schutz vor Anweisungen in den Daten, Test-Marker) hängen die Aufrufer immer selbst an, damit die
 * Ausgabe gültig bleibt. Tabelle `instance_prompts` legt `ensureInstanceSchema` an.
 *
 * Wie der KI-Kosten-Sink ein Modul-Zustand: Der Server setzt die Quelle beim Start (`setPromptSource`), die
 * KI-Aufrufer fragen `customPrompt(key)` – ohne Quelle (Tests, Server-Befehle) gilt immer der Standard.
 */

export const PROMPT_KEYS = ['qualify', 'prescreen', 'writer', 'conversation', 'assistant'] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

export const PROMPT_LABELS: Record<PromptKey, { label: string; help: string }> = {
  qualify: {
    label: 'Einstufung (Lead-Suche)',
    help: 'Wen die KI nach dem Profilabruf als qualifiziert einstuft. Kategorie-Liste, Ausgabefelder und Datenschutz-Regel hängt das Cockpit selbst an.',
  },
  prescreen: {
    label: 'Vorprüfung (Lead-Suche)',
    help: 'Grobe Vorauswahl nur anhand von Name, Headline und Ort (likely/maybe/no). Ausgabe-Regeln hängt das Cockpit an.',
  },
  writer: {
    label: 'Texter (Vorschläge)',
    help: 'Wie die KI Erstnachrichten, Follow-ups und Antworten schreibt (Ton, Angebot, Länge). Ausgabeformat hängt das Cockpit an.',
  },
  conversation: {
    label: 'Gesprächseinschätzung',
    help: 'Kontext für die Einschätzung eingehender Antworten (interessiert, Frage, später, kein Interesse). Ausgabefelder hängt das Cockpit an.',
  },
  assistant: {
    label: 'KI-Assistent (Einleitung)',
    help: 'Erster Absatz des Analyse-Assistenten: wer ihr seid, wen ihr anschreibt, wie der Ablauf ist. Der Rest (Werkzeuge, Arbeitsweise) bleibt.',
  },
};

export const PROMPT_MAX_LENGTH = 20_000;

export interface StoredPrompt {
  key: PromptKey;
  text: string;
  updatedAt: number;
  updatedBy: string | null;
}

export class PromptStore {
  constructor(private readonly db: Database) {}

  get(key: PromptKey): StoredPrompt | null {
    const row = this.db.prepare('SELECT key, text, updated_at, updated_by FROM instance_prompts WHERE key = ?').get(key) as
      | { key: PromptKey; text: string; updated_at: number; updated_by: string | null }
      | undefined;
    return row ? { key: row.key, text: row.text, updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
  }

  set(key: PromptKey, text: string, by: string | null, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO instance_prompts (key, text, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
      .run(key, text, now, by);
  }

  reset(key: PromptKey): void {
    this.db.prepare('DELETE FROM instance_prompts WHERE key = ?').run(key);
  }
}

let source: PromptStore | null = null;

/** Der Server setzt beim Start die Quelle (Datenbank). Tests: eigene oder null. */
export function setPromptSource(next: PromptStore | null): void {
  source = next;
}

/** Beim Schließen eines Servers: nur die eigene Quelle zurücksetzen (mehrere Server in einem Testlauf). */
export function clearPromptSource(store: PromptStore): void {
  if (source === store) source = null;
}

/** Eigener Text für diesen Prompt – null = Standard. Wirft nie. */
export function customPrompt(key: PromptKey): string | null {
  try {
    return source?.get(key)?.text ?? null;
  } catch {
    return null;
  }
}
