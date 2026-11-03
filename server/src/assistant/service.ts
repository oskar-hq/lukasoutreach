import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AssistantMessage, AssistantStreamEvent, AssistantToolName, AssistantToolUse } from '../../../shared/assistant.js';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import { LEAD_CATEGORIES } from '../../../shared/leadSearch.js';
import { LEAD_STAGES } from '../../../shared/leads.js';
import { isCreditExhausted } from '../ai/errors.js';
import { costUsd, recordAiUsage, type AiTokenUsage } from '../ai/usage.js';
import type { Config } from '../config.js';
import { CONVERSATIONS_MAX_LIMIT, type AssistantData, type ConversationOutcome } from './data.js';
import type { AssistantStore } from './store.js';

/**
 * KI-Assistent (Vertrag `shared/assistant.ts`): Claude mit Lese-Werkzeugen über alle Outreach-Daten. Eine Antwort ist
 * eine Schleife – Claude ruft Werkzeuge auf, das Backend führt sie aus und gibt die Ergebnisse zurück, bis Claude fertig
 * ist. Der Verlauf für die API wird unverändert gespeichert und beim nächsten Mal genau so wieder mitgeschickt (nur
 * angehängt, nie umgeschrieben – Voraussetzung für Denkblöcke und den Prompt-Cache). Nur lesend: kein Werkzeug ändert
 * etwas. Simulation: dieselben Werkzeuge, aber eine feste Antwort ohne Netz.
 */

/** Unveränderlich – ändert sich der Systemtext, gelten die Denkblöcke alter Chats nicht mehr (und der Cache ist kalt). */
const SYSTEM_PROMPT = `Du bist der Analyse-Assistent im Outreach-Cockpit eines kleinen Teams, das über LinkedIn Kapitalanlage-Vertriebe und Finanzdienstleister anschreibt (früher auch Bauträger/Projektentwickler). Ablauf je Lead: Vernetzungsanfrage (optional mit Notiz) → Erstnachricht → Follow-ups → Antwort → Termin. Die Gründer heißen Nick und Johannes.

Du hast Lesezugriff auf alle Daten über Werkzeuge: Gesprächsverläufe in beiden Richtungen, eine vorab gerechnete Sequenz-Auswertung, Volltextsuche über alle Nachrichten, Lead-Suche und Lead-Details. Du änderst und sendest nichts.

Deine wichtigste Aufgabe ist, zwischen den Zeilen zu lesen. Zahlen allein sieht das Team im Dashboard. Du liest die Gespräche selbst und findest heraus, warum etwas wirkt:
- Vergleiche Gespräche mit Antwort gegen solche ohne Antwort (read_conversations mit outcome "replied" bzw. "no_reply"), interessierte gegen nicht interessierte, Termine gegen eingeschlafene Gespräche.
- Achte auf die Position in der Sequenz (Erstnachricht, zweite, dritte … Nachricht), auf Länge, Ton, Personalisierung, Fragen, Angebote, Bezug auf vorherige Nachrichten, Timing und Abstände, Einwände und deren Behandlung.
- Lies für Analysen viele Gespräche, nicht nur ein paar – blättere mit offset weiter, bis du ein belastbares Bild hast. Nenne, auf wie vielen Gesprächen deine Aussage beruht.
- Belege Aussagen mit konkreten Beispielen (kurze Zitate) und verlinke die Leads.
- Leite konkrete, umsetzbare Empfehlungen ab: welche Nachricht an welcher Stelle wie ändern, was weglassen, was testen. Wo die Datenlage dünn ist, sag das ehrlich.
Für einfache Fragen (einen Lead finden, wer hat was geschrieben) reicht die Suche – lies dann nicht alles.

Antworte auf Deutsch, per du, klar gegliedert in Markdown (kurze Überschriften, Listen). Nennst du einen Lead, verlinke ihn genau so, wie er in den Werkzeug-Ergebnissen steht: [Vorname Nachname](lead:<id>) – erfinde keine IDs.`;

/** Höchstens so viele Runden (Werkzeugaufrufe) je Antwort – Schutz vor Endlosschleifen und Kosten. */
const MAX_ROUNDS = 30;
/** Ein Werkzeug-Ergebnis höchstens so lang (Zeichen) – sonst kürzen mit Hinweis aufs Weiterblättern. */
const TOOL_RESULT_MAX_CHARS = 400_000;
const MAX_TOKENS = 64_000;
/**
 * Bisheriger Verlauf höchstens so lang (Zeichen, grob 700.000 Token) – darüber passt eine weitere Runde nicht mehr sicher
 * ins Kontextfenster. Kürzen hieße den Verlauf umschreiben (Denkblöcke ungültig); stattdessen: neuer Chat.
 */
const HISTORY_MAX_CHARS = 2_800_000;

const OUTCOMES = ['all', 'replied', 'no_reply', 'interested', 'not_interested', 'meeting', 'lost'] as const satisfies readonly ConversationOutcome[];

const ConversationsInput = z.object({
  outcome: z.enum(OUTCOMES).optional(),
  category: z.enum(LEAD_CATEGORIES).nullable().optional(),
  owner: z.enum(AUTH_FOUNDER_IDS).nullable().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(CONVERSATIONS_MAX_LIMIT).optional(),
});
const SearchInput = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).optional() });
const FindInput = z.object({
  query: z.string().trim().max(200).optional(),
  stage: z.enum(LEAD_STAGES).nullable().optional(),
  category: z.enum(LEAD_CATEGORIES).nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const DetailInput = z.object({ lead_id: z.string().trim().min(1).max(64) });

/** Werkzeuge – Reihenfolge und Text fest (Cache). `eager_input_streaming`: Eingaben werden selbst geprüft (zod). */
const TOOLS = [
  {
    name: 'outreach_analysis',
    description:
      'Vorab gerechnete Auswertung über alle Leads: Trichter, erste Antwort je Position in der Sequenz (Erstnachricht, 2., 3. Nachricht …), je Vorlage/Variante, nach Länge, Frage am Ende, Wochentag, Uhrzeit, Kategorie, Gründer, Notiz zur Anfrage. Guter Startpunkt für Analysen – das Warum steht aber in den Gesprächen (read_conversations).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_conversations',
    description:
      'Ganze Gesprächsverläufe vieler Leads auf einmal (beide Richtungen, mit Position in der Sequenz, Vorlage, Zeitpunkt, Anfrage-Notiz, Ergebnis), neueste zuerst. Filter nach Ergebnis, Kategorie, Gründer; blättern mit offset. Bis 150 je Aufruf.',
    input_schema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: [...OUTCOMES], description: 'replied = hat geantwortet, no_reply = angeschrieben ohne Antwort, interested / not_interested = letzte Antwort laut Einschätzung, meeting = Termin, lost = verloren, all = alle (Standard)' },
        category: { type: ['string', 'null'], enum: [...LEAD_CATEGORIES, null], description: 'KI-Kategorie des Leads' },
        owner: { type: ['string', 'null'], enum: [...AUTH_FOUNDER_IDS, null], description: 'Gründer (Besitzer des Leads)' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: CONVERSATIONS_MAX_LIMIT, description: 'Standard 50' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description: 'Volltextsuche über alle Nachrichten (beide Richtungen) und Anfrage-Notizen. Alle Wörter müssen vorkommen. Liefert Leads mit Link und Ausschnitt.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Suchwörter, z. B. „Neubau Köln“' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_leads',
    description: 'Leads nach Name, Firma oder Position suchen, optional nach Stufe und Kategorie. Liefert Leads mit Link.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, Firma oder Position (Teilwörter)' },
        stage: { type: ['string', 'null'], enum: [...LEAD_STAGES, null] },
        category: { type: ['string', 'null'], enum: [...LEAD_CATEGORIES, null] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lead_detail',
    description: 'Ein Lead komplett: Profil, KI-Einstufung, Zusammenfassung, ganzer Verlauf ungekürzt.',
    input_schema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'], additionalProperties: false },
  },
].map((tool) => ({ ...tool, eager_input_streaming: true })) as unknown as Anthropic.Tool[];

const OUTCOME_LABELS: Record<ConversationOutcome, string> = {
  all: 'alle',
  replied: 'mit Antwort',
  no_reply: 'ohne Antwort',
  interested: 'interessiert',
  not_interested: 'nicht interessiert',
  meeting: 'Termin',
  lost: 'verloren',
};

/** Modelle mit Effort-Steuerung (älteren Modellen würde `effort` einen Fehler eintragen). */
const supportsEffort = (model: string) => /claude-(opus-4-[5-9]|opus-5|fable|mythos|sonnet-4-6|sonnet-5|haiku-5)/.test(model);
/** Server-seitige Ausweichmodelle bei einer Ablehnung (`fallbacks: "default"`) – nur diese Modelle kennen es. */
const supportsFallback = (model: string) => ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'].includes(model);

export class AssistantBusyError extends Error {
  constructor() {
    super('Dieser Chat antwortet gerade noch – warte, bis die Antwort fertig ist.');
    this.name = 'AssistantBusyError';
  }
}

export interface AssistantDeps {
  config: Config;
  data: AssistantData;
  store: AssistantStore;
  anthropicBaseURL?: string;
  now?: () => number;
}

interface ToolRun {
  text: string;
  use: AssistantToolUse;
}

export class AssistantService {
  /** Chats, die gerade antworten – mit dem Schalter zum Abbrechen. */
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: AssistantDeps) {}

  isBusy(chatId: string): boolean {
    return this.running.has(chatId);
  }

  /** „Stopp“: laufende Antwort abbrechen. false = lief nichts. */
  stop(chatId: string): boolean {
    const controller = this.running.get(chatId);
    controller?.abort();
    return !!controller;
  }

  stopAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  /** Werkzeug ausführen; ungültige Eingaben werden als Fehler zurückgegeben, nie geworfen. */
  runTool(name: string, input: unknown, scope: AuthFounderId[] | null): ToolRun & { error?: boolean } {
    const { data } = this.deps;
    const fail = (text: string): ToolRun & { error: true } => ({ text, use: { tool: name as AssistantToolName, label: 'Werkzeug-Aufruf ungültig' }, error: true });
    switch (name as AssistantToolName) {
      case 'outreach_analysis':
        return { text: data.analysis(scope), use: { tool: 'outreach_analysis', label: 'Sequenz-Auswertung gelesen' } };
      case 'read_conversations': {
        const parsed = ConversationsInput.safeParse(input ?? {});
        if (!parsed.success) return fail(`Ungültige Eingabe: ${parsed.error.issues.map((issue) => issue.message).join(' ')}`);
        const result = data.conversations(scope, parsed.data);
        const outcome = OUTCOME_LABELS[parsed.data.outcome ?? 'all'];
        return { text: result.text, use: { tool: 'read_conversations', label: `${result.count} von ${result.total} Gesprächen gelesen (${outcome})` } };
      }
      case 'search_messages': {
        const parsed = SearchInput.safeParse(input ?? {});
        if (!parsed.success) return fail('Ungültige Eingabe: query fehlt.');
        return { text: data.searchMessages(scope, parsed.data.query, parsed.data.limit), use: { tool: 'search_messages', label: `Nachrichten durchsucht: „${parsed.data.query}“` } };
      }
      case 'find_leads': {
        const parsed = FindInput.safeParse(input ?? {});
        if (!parsed.success) return fail(`Ungültige Eingabe: ${parsed.error.issues.map((issue) => issue.message).join(' ')}`);
        const label = parsed.data.query ? `Leads gesucht: „${parsed.data.query}“` : 'Leads gesucht';
        return { text: data.findLeads(scope, parsed.data), use: { tool: 'find_leads', label } };
      }
      case 'lead_detail': {
        const parsed = DetailInput.safeParse(input ?? {});
        if (!parsed.success) return fail('Ungültige Eingabe: lead_id fehlt.');
        const detail = data.leadDetail(scope, parsed.data.lead_id);
        return detail
          ? { text: detail, use: { tool: 'lead_detail', label: 'Lead im Detail gelesen' } }
          : { text: 'Diesen Lead gibt es nicht (oder er gehört nicht zu deinen Gründern).', use: { tool: 'lead_detail', label: 'Lead nicht gefunden' }, error: true };
      }
      default:
        return fail(`Unbekanntes Werkzeug „${name}“.`);
    }
  }

  /**
   * Eine Frage beantworten. `emit` bekommt die Ereignisse für den Stream; gibt die gespeicherte Antwort zurück. Wirft
   * `AssistantBusyError`, wenn der Chat gerade antwortet. Alle anderen Fehler (auch „Stopp“) enden als Antwort mit
   * `failed`. Läuft weiter, wenn der Browser die Verbindung schließt – die Antwort steht dann beim nächsten Öffnen da.
   */
  async ask(
    username: string,
    chatId: string,
    question: string,
    model: string,
    scope: AuthFounderId[] | null,
    emit: (event: AssistantStreamEvent) => void,
  ): Promise<AssistantMessage> {
    if (this.running.has(chatId)) throw new AssistantBusyError();
    const controller = new AbortController();
    const signal = controller.signal;
    this.running.set(chatId, controller);
    try {
      const { store } = this.deps;
      const asked = store.addQuestion(chatId, question, model, this.now());
      emit({ type: 'start', questionId: asked.id });
      const outcome = this.deps.config.mode === 'mock' ? this.mockAnswer(question, scope, emit) : await this.liveAnswer(chatId, question, model, scope, emit, signal);
      const answer = store.addAnswer(chatId, { text: outcome.text, at: this.now(), model, tools: outcome.tools, costEur: outcome.costEur, ...(outcome.failed ? { failed: true } : {}) });
      const chat = store.summary(username, chatId)!;
      emit(outcome.failed ? { type: 'error', message: outcome.text, answer } : { type: 'done', message: answer, chat });
      return answer;
    } finally {
      this.running.delete(chatId);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Simulation: die echten Werkzeuge, eine feste Antwort ohne KI – gestückelt wie ein Stream. */
  private mockAnswer(question: string, scope: AuthFounderId[] | null, emit: (event: AssistantStreamEvent) => void): Answer {
    const tools: AssistantToolUse[] = [];
    const use = (name: AssistantToolName, input: unknown) => {
      const run = this.runTool(name, input, scope);
      tools.push(run.use);
      emit({ type: 'tool', tool: run.use });
      return run.text;
    };
    const analysis = use('outreach_analysis', {});
    const funnel = analysis.split('\n')[1] ?? '';
    // Längstes Wort der Frage als Suchbegriff – genug, um Links und Suche in der Oberfläche zu zeigen.
    const word = question.split(/[^\p{L}\p{N}-]+/u).sort((a, b) => b.length - a.length)[0] ?? '';
    const found = word.length >= 3 ? use('search_messages', { query: word, limit: 5 }) : null;
    const text = [
      '**Simulation** – hier antwortet keine KI, sondern ein fester Text mit echten Daten aus der Simulation.',
      '',
      `Gelesen: die Sequenz-Auswertung (${funnel.replace(/^Leads im Sichtbereich: /, 'Leads: ')}).`,
      found ? `\nGesucht nach „${word}“:\n${found}` : '',
      '',
      'Im echten Betrieb liest Claude hier die Gespräche selbst und leitet daraus Tipps ab.',
    ]
      .filter((line) => line !== '')
      .join('\n');
    for (const chunk of text.match(/[\s\S]{1,40}/g) ?? []) emit({ type: 'text', text: chunk });
    return { text, tools, costEur: 0 };
  }

  private async liveAnswer(
    chatId: string,
    question: string,
    model: string,
    scope: AuthFounderId[] | null,
    emit: (event: AssistantStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<Answer> {
    const { config, store } = this.deps;
    const tools: AssistantToolUse[] = [];
    if (!config.anthropic.apiKey) {
      return { text: 'Ohne Anthropic-API-Schlüssel kann der Assistent nicht antworten. Trag ihn unter Einstellungen → KI-Bewertung (Anthropic) ein.', tools, costEur: 0, failed: true };
    }
    const client = new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: this.deps.anthropicBaseURL, maxRetries: 2, timeout: 10 * 60_000 });
    // Das Datum gehört in die Frage, nicht in den Systemtext (der muss gleich bleiben).
    const today = new Date(this.now()).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const history = store.apiMessages(chatId);
    if (JSON.stringify(history).length > HISTORY_MAX_CHARS) {
      return { text: 'Dieser Chat hat schon sehr viele Gespräche gelesen und ist zu lang geworden – starte für die nächste Frage bitte einen neuen Chat.', tools, costEur: 0, failed: true };
    }
    const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: `${question}\n\n(Heute ist ${today}.)` }];
    const texts: string[] = [];
    let costEur = 0;
    let jsonRetries = 0;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const params = {
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          messages,
          // Verlauf und Werkzeug-Ergebnisse aus dem Cache – Folgefragen kosten nur einen Bruchteil.
          cache_control: { type: 'ephemeral' },
          ...(supportsEffort(model) ? { output_config: { effort: 'high' } } : {}),
          ...(supportsFallback(model) ? { fallbacks: 'default' } : {}),
        } as unknown as Anthropic.MessageStreamParams;
        const stream = client.messages.stream(params, {
          signal,
          ...(supportsFallback(model) ? { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } } : {}),
        });
        let roundText = '';
        stream.on('text', (delta) => {
          // Neue Runde nach Werkzeugen: Absatz, damit Texte nicht aneinanderkleben.
          if (!roundText && texts.length) emit({ type: 'text', text: '\n\n' });
          roundText += delta;
          emit({ type: 'text', text: delta });
        });
        let message: Anthropic.Message;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (error) {
          // Nur eine nicht lesbare Werkzeug-Eingabe (eager streaming) wird wiederholt – API-Fehler nicht.
          if (error instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw error;
          continue;
        }
        recordAiUsage('assistant', message.model, message.usage as AiTokenUsage);
        costEur += costUsd(message.model, message.usage as AiTokenUsage) * config.anthropic.usdToEur;
        if (roundText.trim()) texts.push(roundText.trim());
        messages.push({ role: 'assistant', content: message.content as Anthropic.ContentBlockParam[] });

        if (message.stop_reason === 'refusal') {
          texts.push('_Die KI hat diese Frage abgelehnt. Formulier sie bitte anders._');
          return { text: texts.join('\n\n'), tools, costEur, failed: true };
        }
        if (message.stop_reason === 'pause_turn') continue;
        const uses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
        if (message.stop_reason !== 'tool_use' || !uses.length) {
          if (message.stop_reason === 'max_tokens') texts.push('_(Antwort wegen ihrer Länge abgeschnitten.)_');
          store.setApiMessages(chatId, messages);
          return { text: texts.join('\n\n') || '(keine Antwort)', tools, costEur };
        }
        // Schon sehr viel gelesen: nichts mehr nachladen, Claude soll mit dem Gelesenen antworten.
        const full = JSON.stringify(messages).length > HISTORY_MAX_CHARS;
        const results: Anthropic.ToolResultBlockParam[] = uses.map((block) => {
          if (full) {
            return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'Leselimit für diese Antwort erreicht – antworte jetzt mit dem, was du gelesen hast, und sag, auf wie vielen Gesprächen es beruht.' };
          }
          const run = this.runTool(block.name, block.input, scope);
          tools.push(run.use);
          emit({ type: 'tool', tool: run.use });
          const content =
            run.text.length > TOOL_RESULT_MAX_CHARS
              ? `${run.text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… [gekürzt – für den Rest mit offset bzw. kleinerem limit weiterlesen]`
              : run.text;
          return { type: 'tool_result', tool_use_id: block.id, content, ...(run.error ? { is_error: true } : {}) };
        });
        messages.push({ role: 'user', content: results });
      }
      texts.push('_(Zu viele Leseschritte für eine Antwort – frag gezielter nach, dann geht es weiter.)_');
      store.setApiMessages(chatId, messages);
      return { text: texts.join('\n\n'), tools, costEur };
    } catch (error) {
      // Nicht gespeichert: Die nächste Frage setzt auf dem letzten vollständigen Verlauf auf.
      return { text: [...texts, `_${errorText(error, model, signal)}_`].join('\n\n'), tools, costEur, failed: true };
    }
  }
}

interface Answer {
  text: string;
  tools: AssistantToolUse[];
  costEur: number;
  failed?: boolean;
}

function errorText(error: unknown, model: string, signal: AbortSignal): string {
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return 'Abgebrochen.';
  if (isCreditExhausted(error)) return 'Das Anthropic-Guthaben ist aufgebraucht – lade es unter console.anthropic.com → Plans & Billing auf.';
  if (error instanceof Anthropic.AuthenticationError) return 'Der Anthropic-Schlüssel ist ungültig oder abgelaufen.';
  if (error instanceof Anthropic.PermissionDeniedError) return `Der Anthropic-Schlüssel darf das Modell „${model}“ nicht verwenden.`;
  if (error instanceof Anthropic.NotFoundError) return `Das Modell „${model}“ gibt es nicht.`;
  if (error instanceof Anthropic.RateLimitError) return 'Die Anthropic-API meldet zu viele Anfragen – versuch es gleich noch einmal.';
  if (error instanceof Anthropic.APIConnectionError) return 'Die Anthropic-API ist nicht erreichbar.';
  if (error instanceof Anthropic.BadRequestError) return 'Die Anthropic-API hat die Anfrage abgelehnt – starte am besten einen neuen Chat.';
  if (error instanceof Anthropic.APIError) return 'Die KI ist vorübergehend nicht erreichbar – versuch es gleich noch einmal.';
  return 'Die Antwort ist fehlgeschlagen.';
}
