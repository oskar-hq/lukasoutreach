import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageSuggestion, MessageTemplate, TemplatesResponse } from '../../shared/messages.js';
import { renderTemplate, unknownPlaceholders } from '../../shared/messages.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { tempDataDir } from './helpers.js';

/** Freie Felder als Platzhalter in Vorlagen (Lukas-Instanz 19.11., Einstellung LEAD_FIELDS). */

function app(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', ...env });
  return buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
}

test('Platzhalter-Prüfung: freie Felder nur, wenn erlaubt; Unterstrich und Ziffern werden erkannt', () => {
  assert.deepEqual(unknownPlaceholders('Hi {{vorname}}, {{aufhaenger}} {{firma_stage}}'), ['aufhaenger', 'firma_stage']);
  assert.deepEqual(unknownPlaceholders('Hi {{vorname}}, {{aufhaenger}} {{firma_stage}}', ['aufhaenger', 'firma_stage']), []);
  assert.equal(renderTemplate('{{vorname}} – {{aufhaenger}} – {{fehlt}}', { vorname: 'Anna', aufhaenger: 'euer Launch' }), 'Anna – euer Launch – {{fehlt}}');
});

test('Vorlage mit {{aufhaenger}}: ohne LEAD_FIELDS abgelehnt, mit gespeichert und im Vorschlag gefüllt', async (t) => {
  const plain = app();
  t.after(() => plain.close());
  const rejected = await plain.inject({ method: 'POST', url: '/api/templates', payload: { category: 'first_greenfield', name: 'VC', text: 'Hi {{vorname}}, {{aufhaenger}}' } });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body, /Unbekannte Platzhalter: \{\{aufhaenger\}\}/);
  // „kategorie“ gibt es immer.
  const withCategory = await plain.inject({ method: 'POST', url: '/api/templates', payload: { category: 'first_greenfield', name: 'Kat', text: 'Hi {{vorname}} ({{kategorie}})' } });
  assert.equal(withCategory.statusCode, 201, withCategory.body);

  const server = app({ LEAD_FIELDS: 'welle, aufhaenger, firma_stage' });
  t.after(() => server.close());
  const list = (await server.inject({ method: 'GET', url: '/api/templates' })).json() as TemplatesResponse;
  assert.deepEqual(list.fieldPlaceholders, ['welle', 'aufhaenger', 'firma_stage', 'kategorie']);
  const created = await server.inject({ method: 'POST', url: '/api/templates', payload: { category: 'first_greenfield', name: 'VC · Funding', text: 'Hi {{vorname}}, {{aufhaenger}} – Stage {{firma_stage}}.' } });
  assert.equal(created.statusCode, 201, created.body);
  // Live ohne Anthropic-Schlüssel: der Vorschlag ist die ausgefüllte Vorlage (`source: 'template'`).
  const live = app({ LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key', LEAD_FIELDS: 'aufhaenger, firma_stage', DATA_DIR: tempDataDir() });
  t.after(() => live.close());
  const liveTemplate = (await live.inject({ method: 'POST', url: '/api/templates', payload: { category: 'first_greenfield', name: 'VC · Funding', text: 'Hi {{vorname}}, {{aufhaenger}} – Stage {{firma_stage}}.' } })).json() as MessageTemplate;
  const card = {
    runId: 'run-x', mode: 'live', providerId: 'ACoVC1', publicIdentifier: 'vc-anna', profileUrl: 'https://www.linkedin.com/in/vc-anna',
    firstName: 'Anna', lastName: 'Berg', headline: 'Partner', position: 'Partner', company: 'Berg Ventures', location: 'Berlin', website: null,
    networkDistance: 2, category: 'kapitalanlage_vertrieb', confidence: 0.9, reason: 'x', summary: 'x', metaAds: null,
  };
  const created2 = await live.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card], owner: 'nick' } });
  assert.equal(created2.statusCode, 200, created2.body);
  const leadId = (created2.json() as { created: Array<{ id: string }> }).created[0].id;
  const fields = await live.inject({ method: 'PUT', url: `/api/leads/${leadId}/fields`, payload: { fields: { aufhaenger: 'Glückwunsch zur Seed-Runde', firma_stage: 'Seed' } } });
  assert.equal(fields.statusCode, 200, fields.body);
  const suggestion = await live.inject({ method: 'POST', url: `/api/leads/${leadId}/suggest`, payload: { kind: 'first', templateId: liveTemplate.id } });
  assert.equal(suggestion.statusCode, 200, suggestion.body);
  const body = suggestion.json() as MessageSuggestion;
  assert.equal(body.source, 'template');
  assert.equal(body.text, 'Hi Anna, Glückwunsch zur Seed-Runde – Stage Seed.');
});
