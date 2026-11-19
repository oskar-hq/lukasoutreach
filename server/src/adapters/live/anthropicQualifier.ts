import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { isQualifyingCategory, type EnrichedProfile, type PrescreenVerdict, type SearchHit } from '../../../../shared/leadSearch.js';
import { CREDIT_EXHAUSTED_TEXT, CREDIT_EXHAUSTED_TITLE, isCreditExhausted } from '../../ai/errors.js';
import { lowEffort } from '../../ai/model.js';
import { recordShadow, shouldShadow } from '../../ai/shadow.js';
import { recordAiUsage } from '../../ai/usage.js';
import { AdapterError, CancelledError } from '../../pipeline/adapter.js';
import { describeLead, qualificationSystemPrompt } from '../../qualify/prompt.js';
import { QualificationOutputSchema, type QualificationOutput } from '../../qualify/schema.js';
import { PrescreenOutputSchema, prescreenSystemPrompt, describeHits, parsePrescreen } from '../../qualify/prescreen.js';

export interface AnthropicQualifierOptions {
  apiKey: string;
  /** Einstufung der Profile. */
  model: string;
  /** Vorprüfung der Suchtreffer (Standard: `model`). */
  prescreenModel?: string;
  /**
   * Modellvergleich (09.11.): `shadowPercent` % der Einstufungen zusätzlich mit `shadowModel`, der Vorprüfungen
   * zusätzlich mit `model`. Nur zum Vergleich (`ai/shadow.ts`), das Ergebnis zählt nie.
   */
  shadowModel?: string;
  shadowPercent?: number;
  /** Würfel (Tests). */
  random?: () => number;
  /** Nur für Tests (Fake-Server). Sonst die offizielle API. */
  baseURL?: string;
}

/**
 * KI-Qualifizierung über die Anthropic-API mit strukturierter JSON-Ausgabe (Zod-Schema).
 * Gibt die Rohausgabe zurück – Wertebereiche und die strenge Regel prüft danach der Runner.
 */
export class AnthropicQualifier {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicQualifierOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 2, timeout: 60_000 });
  }

  async qualify(hit: SearchHit, profile: EnrichedProfile, signal: AbortSignal, runId?: string, examples?: string | null): Promise<unknown> {
    const { model, shadowModel, shadowPercent = 0, random } = this.options;
    const output = await this.qualifyWith(model, 'qualify', hit, profile, signal, runId, examples);
    if (shadowModel && shadowModel !== model && shouldShadow(shadowPercent, random)) {
      await this.shadowQualify(shadowModel, output, hit, profile, signal, runId, examples);
    }
    return output;
  }

  private async qualifyWith(
    model: string,
    purpose: 'qualify' | 'shadow',
    hit: SearchHit,
    profile: EnrichedProfile,
    signal: AbortSignal,
    runId?: string,
    examples?: string | null,
  ): Promise<QualificationOutput> {
    try {
      const response = await this.client.messages.parse(
        {
          model,
          max_tokens: 2048,
          system: systemBlocks(qualificationSystemPrompt(), examples),
          messages: [{ role: 'user', content: describeLead(hit, profile) }],
          output_config: {
            format: zodOutputFormat(QualificationOutputSchema),
            // Einordnen ist eine einfache Aufgabe – wenig Denkaufwand reicht. Haiku kennt den Parameter nicht.
            ...lowEffort(model),
          },
        },
        { signal },
      );
      recordAiUsage(purpose, model, response.usage, runId);
      if (response.stop_reason === 'refusal') {
        throw new AdapterError('provider', 'KI-Einschätzung abgelehnt', 'Die KI hat die Einschätzung abgelehnt', false);
      }
      if (!response.parsed_output) {
        throw new AdapterError('provider', 'KI-Ausgabe unvollständig', 'KI-Ausgabe ungültig – Lead nicht bewertet', false);
      }
      return response.parsed_output;
    } catch (error) {
      throw toAdapterError(error, model, signal);
    }
  }

  /** Gleiche Einstufung mit dem Vergleichsmodell – Fehler und Abbruch schlucken, der Lead ist längst bewertet. */
  private async shadowQualify(
    shadowModel: string,
    main: QualificationOutput,
    hit: SearchHit,
    profile: EnrichedProfile,
    signal: AbortSignal,
    runId?: string,
    examples?: string | null,
  ): Promise<void> {
    try {
      const shadow = await this.qualifyWith(shadowModel, 'shadow', hit, profile, signal, runId, examples);
      recordShadow({
        purpose: 'qualify',
        providerId: hit.providerId,
        runId: runId ?? null,
        headline: hit.headline || null,
        mainModel: this.options.model,
        mainVerdict: qualifyVerdict(main),
        mainCategory: main.category,
        mainConfidence: main.confidence,
        shadowModel,
        shadowVerdict: qualifyVerdict(shadow),
        shadowCategory: shadow.category,
        shadowConfidence: shadow.confidence,
      });
    } catch {
      // Vergleich ist Beiwerk.
    }
  }

  /** KI-Vorprüfung eines Pakets von Suchtreffern (siehe `qualify/prescreen.ts`). */
  async prescreen(
    hits: readonly SearchHit[],
    region: string,
    signal: AbortSignal,
    runId?: string,
    examples?: string | null,
  ): Promise<Map<string, PrescreenVerdict>> {
    const { model, prescreenModel = model, shadowPercent = 0, random } = this.options;
    const verdicts = await this.prescreenWith(prescreenModel, 'prescreen', hits, region, signal, runId, examples);
    // Gegenprobe mit dem Modell der Einstufung: sortiert das kleine Modell gute Leads aus?
    if (prescreenModel !== model && shouldShadow(shadowPercent, random)) {
      try {
        const shadow = await this.prescreenWith(model, 'shadow', hits, region, signal, runId, examples);
        for (const hit of hits) {
          const main = verdicts.get(hit.providerId);
          const other = shadow.get(hit.providerId);
          if (!main || !other) continue;
          recordShadow({
            purpose: 'prescreen',
            providerId: hit.providerId,
            runId: runId ?? null,
            headline: hit.headline || null,
            mainModel: prescreenModel,
            mainVerdict: main.fit,
            mainCategory: null,
            mainConfidence: null,
            shadowModel: model,
            shadowVerdict: other.fit,
            shadowCategory: null,
            shadowConfidence: null,
          });
        }
      } catch {
        // Vergleich ist Beiwerk.
      }
    }
    return verdicts;
  }

  private async prescreenWith(
    model: string,
    purpose: 'prescreen' | 'shadow',
    hits: readonly SearchHit[],
    region: string,
    signal: AbortSignal,
    runId?: string,
    examples?: string | null,
  ): Promise<Map<string, PrescreenVerdict>> {
    try {
      const response = await this.client.messages.parse(
        {
          model,
          // Etwa 30 Token je Treffer plus Reserve.
          max_tokens: Math.min(16_000, 1_024 + hits.length * 80),
          system: systemBlocks(prescreenSystemPrompt(), examples),
          messages: [{ role: 'user', content: describeHits(hits, region) }],
          output_config: { format: zodOutputFormat(PrescreenOutputSchema), ...lowEffort(model) },
        },
        { signal },
      );
      recordAiUsage(purpose, model, response.usage, runId);
      if (response.stop_reason === 'refusal' || !response.parsed_output) {
        throw new AdapterError('provider', 'KI-Vorprüfung unvollständig', 'KI-Vorprüfung ohne Ergebnis', false);
      }
      return parsePrescreen(response.parsed_output, hits);
    } catch (error) {
      throw toAdapterError(error, model, signal);
    }
  }
}

/** „ja“ = die KI hält den Lead für qualifiziert (Kategorie passt und eigenes Urteil) – ohne Mindestsicherheit. */
function qualifyVerdict(output: QualificationOutput): string {
  return output.qualified && isQualifyingCategory(output.category) ? 'ja' : 'nein';
}

/**
 * Systemprompt: feste Regeln, danach die Beispiele aus Rückmeldungen zur Lead-Qualität (`shared/learning.ts`). Beide
 * ändern sich innerhalb eines Laufs nicht – mit dem Cache-Punkt am Ende zahlt jeder weitere Lead nur einen Bruchteil
 * für sie (greift erst ab der Mindestlänge des Modells; darunter wirkt er nicht, schadet aber auch nicht).
 */
export function systemBlocks(rules: string, examples?: string | null): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: rules }];
  if (examples) blocks.push({ type: 'text', text: examples });
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
  return blocks;
}

function toAdapterError(error: unknown, model: string, signal: AbortSignal): Error {
  if (error instanceof AdapterError) return error;
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return new CancelledError();
  if (isCreditExhausted(error)) return new AdapterError('auth', CREDIT_EXHAUSTED_TITLE, CREDIT_EXHAUSTED_TEXT, true);
  if (error instanceof Anthropic.AuthenticationError) {
    return new AdapterError(
      'auth',
      'Anthropic-Zugang abgelehnt',
      'Der ANTHROPIC_API_KEY ist ungültig oder abgelaufen. Trag einen gültigen Schlüssel unter Einstellungen → KI-Bewertung (Anthropic) ein.',
      true,
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new AdapterError('auth', 'Keine Berechtigung', `Der API-Key darf das Modell „${model}“ nicht verwenden.`, true);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new AdapterError('config', 'Modell nicht gefunden', `Das Modell „${model}“ gibt es nicht – prüfe das Modell unter Einstellungen → KI-Bewertung (Anthropic).`, true);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AdapterError(
      'rate_limit',
      'Anthropic-Limit erreicht',
      'Die Anthropic-API meldet zu viele Anfragen. Der Lauf wurde abgebrochen – versuch es in ein paar Minuten erneut.',
      true,
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AdapterError('config', 'Anfrage an die KI ungültig', `Anthropic lehnt die Anfrage ab: ${error.message}`, true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AdapterError('network', 'Anthropic-API nicht erreichbar', 'Keine Verbindung zur Anthropic-API. Prüfe die Internetverbindung des Servers.', true);
  }
  if (error instanceof Anthropic.APIError) {
    // 5xx/Überlastung nach automatischen Wiederholungen: nur dieser Lead bleibt unbewertet.
    return new AdapterError('provider', 'KI vorübergehend nicht erreichbar', 'KI vorübergehend nicht erreichbar – Lead nicht bewertet', false);
  }
  // JSON passt nicht zum Schema o. Ä.
  return new AdapterError('provider', 'KI-Ausgabe ungültig', 'KI-Ausgabe ungültig – Lead nicht bewertet', false);
}
