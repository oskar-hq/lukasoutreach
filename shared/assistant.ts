/**
 * Vertrag für den KI-Assistenten (Wunsch des Nutzers 22.10.): ein Chat wie ChatGPT im Cockpit, mit Zugriff auf alle
 * Outreach-Daten – Leads, alle Nachrichten in beiden Richtungen, Vorlagen, Verlauf. Er soll nicht Zahlen vom Dashboard
 * ablesen, sondern „zwischen den Zeilen lesen“: ganze Gesprächsverläufe auswerten (welche Nachricht an welcher Stelle der
 * Sequenz wirkt, welche Formulierungen Antworten bringen, warum Leute abspringen) und daraus Tipps ableiten. Nur lesend –
 * der Assistent sendet, ändert und löscht nichts. Wird von Frontend (Vite) und Backend (Node) importiert.
 *
 * Wie er an die Daten kommt: Das Backend gibt Claude Werkzeuge (Tool Use), die Claude selbst aufruft – eine vorab
 * gerechnete Sequenz-Auswertung, ganze Gesprächsverläufe in Stapeln, Volltextsuche, Lead-Suche, Lead im Detail. Rechte
 * wie im Cockpit: Mitarbeiter sehen nur die Leads ihrer Gründer, Gründer und Admin alle.
 *
 * Links: Nennt der Assistent einen Lead, schreibt er ihn als Markdown-Link `[Vorname Nachname](lead:<id>)` – die
 * Oberfläche öffnet damit das Lead-Panel (`ASSISTANT_LEAD_LINK`).
 *
 * Routen (mit Sitzung; jedes Konto sieht nur seine eigenen Chats):
 *   GET    /api/assistant/models              → 200 AssistantModelsResponse (Claude-Modelle laut Anthropic, Standard)
 *   GET    /api/assistant/chats               → 200 AssistantChatListResponse (neueste zuerst)
 *   POST   /api/assistant/chats               { model? } → 201 AssistantChatDetail (leerer Chat)
 *   GET    /api/assistant/chats/:id           → 200 AssistantChatDetail · 404 not_found
 *   DELETE /api/assistant/chats/:id           → 200 { ok: true } · 404 not_found
 *   POST   /api/assistant/chats/:id/messages  AssistantAskRequest → 200 text/event-stream mit AssistantStreamEvent
 *          (je Ereignis `data: <JSON>\n\n`, zuletzt `done` oder `error`) · 404 not_found · 409 busy (Chat antwortet
 *          gerade) · 400 invalid_request. Ohne Anthropic-Schlüssel im echten Betrieb: Ereignis `error` mit Satz.
 *
 * Simulation (`LEAD_SEARCH_MODE=mock`): kein Netz – der Assistent benutzt dieselben Werkzeuge (Suche über die
 * Nachrichten) und antwortet mit einem festen Satz plus Treffern als Links, gestückelt wie ein Stream.
 */

export interface AssistantModel {
  id: string;
  label: string;
}

export interface AssistantModelsResponse {
  models: AssistantModel[];
  /** Vorgewählt (`ANTHROPIC_MODEL`, Standard Claude Opus 5.5). */
  defaultModel: string;
  /** anthropic = live abgefragt, builtin = eingebaute Liste (ohne Schlüssel, Fehler oder Simulation). */
  source: 'anthropic' | 'builtin';
  notice?: string;
}

/** Ein Werkzeugaufruf des Assistenten, zur Anzeige („Liest 120 Gespräche …“). */
export interface AssistantToolUse {
  /** Werkzeugname (`ASSISTANT_TOOLS`). */
  tool: AssistantToolName;
  /** Kurzer Satz, was gelesen wurde – z. B. „120 Gespräche gelesen (Antwort erhalten)“. */
  label: string;
}

export const ASSISTANT_TOOLS = ['outreach_analysis', 'read_conversations', 'search_messages', 'find_leads', 'lead_detail'] as const;
export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number];

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Text der Frage bzw. Antwort (Antwort als Markdown, Leads als `[Name](lead:<id>)`). */
  text: string;
  at: number;
  /** Nur Antworten: mit welchem Modell. */
  model?: string;
  /** Nur Antworten: was der Assistent dafür gelesen hat. */
  tools?: AssistantToolUse[];
  /** Nur Antworten: geschätzte KI-Kosten in Euro (Listenpreise, wie im Dashboard). */
  costEur?: number;
  /** Nur Antworten: abgebrochen oder fehlgeschlagen – der Satz steht in `text`. */
  failed?: boolean;
}

export interface AssistantChatSummary {
  id: string;
  /** Aus der ersten Frage (gekürzt); „Neuer Chat“, solange leer. */
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Summe der Kosten aller Antworten in Euro. */
  costEur: number;
}

export interface AssistantChatDetail extends AssistantChatSummary {
  messages: AssistantMessage[];
}

export interface AssistantChatListResponse {
  chats: AssistantChatSummary[];
}

export interface AssistantAskRequest {
  /** Die Frage, 1–8000 Zeichen. */
  text: string;
  /** Modell für diese Antwort (Claude-Modell-ID); fehlt = das des Chats. Wechselt das Modell des Chats. */
  model?: string;
}

export const ASSISTANT_QUESTION_MAX_LENGTH = 8000;

/**
 * Ereignisse im Stream einer Antwort:
 *   start  – Antwort beginnt (ID der gespeicherten Frage)
 *   tool   – der Assistent liest gerade etwas (Anzeige „Liest …“)
 *   text   – nächstes Stück des Antworttexts (aneinanderhängen)
 *   done   – fertig, mit der gespeicherten Antwort (Text, Werkzeuge, Kosten)
 *   error  – fehlgeschlagen; `message` ist ein Satz für die Oberfläche, die gespeicherte Antwort trägt `failed`
 */
export type AssistantStreamEvent =
  | { type: 'start'; questionId: string }
  | { type: 'tool'; tool: AssistantToolUse }
  | { type: 'text'; text: string }
  | { type: 'done'; message: AssistantMessage; chat: AssistantChatSummary }
  | { type: 'error'; message: string; answer?: AssistantMessage };

/** Präfix der Lead-Links in Antworten: `[Erika Muster](lead:abc123)`. */
export const ASSISTANT_LEAD_LINK = 'lead:';

/** Vorschläge für einen leeren Chat – zeigen, was der Assistent kann. */
export const ASSISTANT_SUGGESTIONS: readonly string[] = [
  'Lies alle Gespräche und sag mir, was in unserem Outreach funktioniert und was nicht – mit Beispielen.',
  'An welcher Stelle der Sequenz (Erstnachricht, Follow-up 1, 2, 3 …) kommen die meisten Antworten – und warum?',
  'Welche Formulierungen in unseren Nachrichten bringen Antworten, welche werden ignoriert?',
  'Wer hat Interesse gezeigt, und das Gespräch ist dann eingeschlafen?',
];
