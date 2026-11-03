import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_BUILTIN_MODELS, type AnthropicModelOption, type AnthropicModelsResponse } from '../../../shared/settings.js';

/** So lange gilt die Liste von Anthropic – neue Modelle erscheinen spätestens danach. */
export const MODELS_CACHE_MS = 60 * 60 * 1000;

/**
 * Claude-Modelle zur Auswahl (Wunsch des Nutzers 12.10.: Dropdown statt Modell-Code abtippen, „immer aktuell“).
 * Live über die Models-API (`GET /v1/models`, das SDK blättert selbst weiter), neueste zuerst. Ohne Schlüssel oder bei
 * einem Fehler die eingebaute Liste mit Hinweis – der Schlüssel taucht nie in Meldungen auf.
 */
export class AnthropicModels {
  private cache: { key: string; at: number; response: AnthropicModelsResponse } | null = null;

  constructor(private readonly options: { baseURL?: string; fetch?: typeof fetch; now?: () => number } = {}) {}

  async list(apiKey: string | null, mode: 'mock' | 'live'): Promise<AnthropicModelsResponse> {
    if (mode === 'mock') return builtin('Eingebaute Liste der aktuellen Modelle.');
    if (!apiKey) return builtin('Ohne Anthropic-API-Schlüssel nur die eingebaute Liste – mit Schlüssel kommt sie live von Anthropic.');
    const now = (this.options.now ?? Date.now)();
    // Gleicher Schlüssel, frische Liste: nicht erneut fragen. Der Schlüssel selbst wird nicht gespeichert.
    const key = apiKey.slice(-6);
    if (this.cache && this.cache.key === key && now - this.cache.at < MODELS_CACHE_MS) return this.cache.response;
    try {
      const client = new Anthropic({ apiKey, baseURL: this.options.baseURL, fetch: this.options.fetch, maxRetries: 1, timeout: 15_000 });
      const models: AnthropicModelOption[] = [];
      for await (const model of client.models.list({ limit: 100 })) {
        models.push({ id: model.id, label: model.display_name || model.id, createdAt: model.created_at || null });
        if (models.length >= 200) break;
      }
      if (!models.length) return builtin('Anthropic hat keine Modelle geliefert – eingebaute Liste.');
      models.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      const response: AnthropicModelsResponse = { models, source: 'anthropic' };
      this.cache = { key, at: now, response };
      return response;
    } catch (error) {
      const reason =
        error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError
          ? 'Anthropic lehnt den API-Schlüssel ab'
          : error instanceof Anthropic.APIConnectionError
            ? 'Anthropic ist gerade nicht erreichbar'
            : 'Die Liste von Anthropic kam nicht an';
      return builtin(`${reason} – eingebaute Liste der aktuellen Modelle.`);
    }
  }
}

function builtin(notice: string): AnthropicModelsResponse {
  return { models: [...ANTHROPIC_BUILTIN_MODELS], source: 'builtin', notice };
}
