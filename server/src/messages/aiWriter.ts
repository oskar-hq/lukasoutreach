import { isCreditExhausted } from '../ai/errors.js';
import { lowEffort } from '../ai/model.js';
import { recordAiUsage } from '../ai/usage.js';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { TEMPLATE_MAX_LENGTH } from '../../../shared/messages.js';

/** Ausgabe der KI. Länge prüft der Dienst danach (das Schema-Format kennt keine Höchstlänge). */
export const SuggestionOutputSchema = z.object({
  text: z.string(),
  intent: z.enum(['interested', 'question', 'not_now', 'not_interested', 'unclear']).nullable(),
  summary: z.string().nullable(),
});
export type SuggestionOutput = z.infer<typeof SuggestionOutputSchema>;

/** Erkennungszeichen im System-Prompt (für die nachgebauten Server in den Tests). */
export const SUGGEST_MARKER = '[cockpit:vorschlag]';

export const SUGGEST_SYSTEM_PROMPT = `${SUGGEST_MARKER}
Du schreibst LinkedIn-Nachrichten für die Gründer einer kleinen Agentur. Die Agentur gewinnt für Kapitalanlage-Vertriebe
und Finanzdienstleister vorqualifizierte Kunden- bzw. Käuferanfragen über Werbung auf Facebook und Instagram.
Zielgruppe sind Firmen, die dort noch keine Werbung schalten oder früher geschaltet und aufgehört haben.
Sucht eine Firma gerade Mitarbeiter, bietet die Agentur auch Recruiting über Facebook und Instagram an – dann geht es
in der Nachricht um Bewerber, nicht um Käuferanfragen (die Vorlage zeigt, worum es geht).

Regeln:
- Deutsch, Ansprache „du“, locker und respektvoll, wie eine echte Person schreibt. Keine Floskeln, keine Emojis.
- Höchstens 600 Zeichen. Eine klare Frage am Ende vor der Grußformel.
- Erfinde nichts: keine Zahlen, Ergebnisse, Kundennamen, Fallstudien oder Fakten über die Firma, die nicht in den
  Daten stehen. Steht etwas nicht fest, lass es weg.
- Die Vorlage gibt Ton und Inhalt vor. Passe sie an Person und Firma an, statt sie neu zu erfinden.
- Ende genau mit der angegebenen Grußformel.
- Bei einer Antwort auf eine Nachricht des Leads: gehe konkret auf seine Nachricht ein. Bei „kein Interesse“ höflich
  bedanken und nicht weiter drängen.

Ausgabe: \`text\` = die fertige Nachricht. Nur bei einer Antwort auf den Lead zusätzlich \`intent\` (Einschätzung seiner
letzten Nachricht) und \`summary\` (ein Satz, was er will); sonst beide null.`;

export class AiWriterError extends Error {
  constructor(
    message: string,
    /** true = Zugang/Modell falsch eingerichtet (nicht nur vorübergehend). */
    readonly config: boolean,
  ) {
    super(message);
  }
}

export interface AiWriterOptions {
  apiKey: string;
  model: string;
  /** Nur für Tests (Fake-Server). */
  baseURL?: string;
}

export class AiWriter {
  private readonly client: Anthropic;

  constructor(private readonly options: AiWriterOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 1, timeout: 45_000 });
  }

  async write(prompt: string, signal?: AbortSignal): Promise<SuggestionOutput> {
    const { model } = this.options;
    try {
      const response = await this.client.messages.parse(
        {
          model,
          max_tokens: 2048,
          system: SUGGEST_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          output_config: {
            format: zodOutputFormat(SuggestionOutputSchema),
            ...lowEffort(model),
          },
        },
        { signal },
      );
      recordAiUsage('suggest', model, response.usage);
      if (response.stop_reason === 'refusal') throw new AiWriterError('Die KI hat den Vorschlag abgelehnt.', false);
      const output = response.parsed_output;
      if (!output || !output.text.trim()) throw new AiWriterError('Die KI hat keinen brauchbaren Text geliefert.', false);
      if (output.text.length > TEMPLATE_MAX_LENGTH) throw new AiWriterError('Der KI-Text war zu lang.', false);
      return { ...output, text: output.text.trim() };
    } catch (error) {
      throw toWriterError(error, model);
    }
  }
}

function toWriterError(error: unknown, model: string): AiWriterError {
  if (error instanceof AiWriterError) return error;
  if (isCreditExhausted(error)) return new AiWriterError('Das Anthropic-Guthaben ist aufgebraucht – lade es unter console.anthropic.com → Plans & Billing auf.', true);
  if (error instanceof Anthropic.AuthenticationError) return new AiWriterError('Der Anthropic-Schlüssel ist ungültig oder abgelaufen.', true);
  if (error instanceof Anthropic.PermissionDeniedError) return new AiWriterError(`Der Anthropic-Schlüssel darf das Modell „${model}“ nicht verwenden.`, true);
  if (error instanceof Anthropic.NotFoundError) return new AiWriterError(`Das Modell „${model}“ gibt es nicht.`, true);
  if (error instanceof Anthropic.RateLimitError) return new AiWriterError('Die Anthropic-API meldet zu viele Anfragen.', false);
  if (error instanceof Anthropic.APIConnectionError) return new AiWriterError('Die Anthropic-API ist nicht erreichbar.', false);
  if (error instanceof Anthropic.APIError) return new AiWriterError('Die KI ist vorübergehend nicht erreichbar.', false);
  return new AiWriterError('Die KI-Ausgabe war ungültig.', false);
}
