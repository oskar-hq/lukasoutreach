import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telemetryPath, type TelemetryBatch } from '../../shared/telemetry.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { noteJob, trackJob } from '../src/telemetry/store.js';
import { tempDataDir } from './helpers.js';

/** Nutzungsdaten (09.11., shared/telemetry.ts): Ereignisse der Oberfläche, API je Route, Jobs → Nutzungs-Bericht. */

function app() {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0' });
  return buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false });
}

test('Pfad ohne IDs', () => {
  assert.equal(telemetryPath('/api/leads/3f2a1b4c-1111-4111-8111-111111111111/events?x=1'), '/api/leads/:id/events');
  assert.equal(telemetryPath('/api/system/backups/12345'), '/api/system/backups/:id');
  assert.equal(telemetryPath('/api/settings'), '/api/settings');
});

test('Ereignisse, API und Jobs landen im Nutzungs-Bericht – ohne Inhalte', async () => {
  const server = app();
  const now = Date.now();
  const batch: TelemetryBatch = {
    sessionId: 'tab-1',
    client: { width: 1440, height: 900, standalone: false, touch: false },
    events: [
      { name: 'view', at: now - 5000, view: 'home', target: 'home', ms: 42_000 },
      { name: 'click', at: now - 4000, view: 'home', target: 'start-lead' },
      { name: 'hotkey', at: now - 3500, view: 'focus', target: 'enter' },
      { name: 'card', at: now - 3000, view: 'focus', target: 'followup', ms: 18_000, props: { outcome: 'followup-send' } },
      { name: 'error', at: now - 2000, view: 'leads', target: 'Cannot read properties of undefined' },
      { name: 'api', at: now - 1000, view: 'chats', target: '/api/conversations', ms: 2400, props: { status: 200 } },
      // Unbekanntes wird verworfen (Schema).
      { name: 'unbekannt' as 'view', at: now, view: null, target: null },
    ],
  };
  const posted = await server.inject({ method: 'POST', url: '/api/telemetry/events', payload: batch });
  assert.equal(posted.statusCode, 204);
  // Kaputt → trotzdem 204, nichts gespeichert.
  assert.equal((await server.inject({ method: 'POST', url: '/api/telemetry/events', payload: { nix: true } })).statusCode, 204);
  await server.inject({ method: 'GET', url: '/api/settings' });
  await server.inject({ method: 'GET', url: '/api/leads/gibt-es-nicht' });
  await trackJob('linkedin_abgleich', async () => undefined);
  await assert.rejects(trackJob('neue_kontakte', async () => Promise.reject(new Error('KI weg'))));
  noteJob('sicherung', 120, true);
  // Job fängt seinen Fehler selbst (10.11.): die Prüfung nach dem Lauf macht daraus „gescheitert“ – ohne Ausnahme.
  assert.equal(await trackJob('aufwaermen', async () => 3, () => 'Account pausiert'), 3);
  await trackJob('aufwaermen', async () => 0, () => null);
  // Die Dauerverbindung des Laufs (SSE) wird nicht mitgemessen.
  await server.inject({ method: 'GET', url: '/api/lead-search/runs/gibt-es-nicht/events' });

  const report = await server.inject({ method: 'GET', url: '/api/telemetry/report?days=7' });
  assert.equal(report.statusCode, 200);
  assert.match(String(report.headers['content-type']), /text\/markdown/);
  const text = report.body;
  assert.match(text, /^# Nutzungs-Bericht/);
  assert.match(text, /\| home \| 1 \| 0\.7 \| 42 s \|/);
  assert.match(text, /\| home \| start-lead \| 1 \|/);
  assert.match(text, /\| focus \| enter \| 1 \|/);
  assert.match(text, /\| followup \| 1 \| 18 s \| followup-send: 1 \|/);
  assert.match(text, /Cannot read properties of undefined/);
  assert.match(text, /\| \/api\/conversations \| 1 \| 200: 1 \| 2\.4 s \|/);
  assert.match(text, /\| GET \| \/api\/settings \| 1 \|/);
  assert.match(text, /\| GET \| \/api\/leads\/:id \| 1 \| 1 \| 0 \|/);
  assert.match(text, /\| neue_kontakte \| 1 \| 1 \|[^\n]*KI weg \|/);
  assert.match(text, /\| linkedin_abgleich \| 1 \| 0 \|/);
  assert.match(text, /\| aufwaermen \| 2 \| 1 \|[^\n]*Account pausiert \|/);
  assert.doesNotMatch(text, /runs\/:id\/events/);
  assert.match(text, /\| desktop \| 1 \|/);
  await server.close();
});

test('Rechte: Mitarbeiter senden Nutzungsdaten, lesen aber keine Berichte, Zustände oder Logs', async () => {
  const { roleDenial } = await import('../src/auth/roles.js');
  const assistant = { founder: null, role: 'assistant' as const };
  const founder = { founder: 'nick' as const, role: 'founder' as const };
  assert.equal(roleDenial(assistant, 'POST', '/api/telemetry/events'), null);
  for (const path of ['/api/telemetry/report', '/api/telemetry/health', '/api/telemetry/logs']) {
    assert.match(roleDenial(assistant, 'GET', path) ?? '', /Mitarbeiter/);
    assert.equal(roleDenial(founder, 'GET', path), null);
  }
});

test('Logs: Geheimnisse geschwärzt', async () => {
  const { redact } = await import('../src/telemetry/logs.js');
  assert.ok(!redact('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'));
  assert.equal(redact('key sk-ant-api03-ABCDEFGHIJKL done'), 'key [geschwärzt] done');
  assert.match(redact('{"apiKey":"geheim123"}'), /\[geschwärzt\]/);
  assert.equal(redact('Lead 3f2a1b4c-1111-4111-8111-111111111111 nicht übernommen'), 'Lead 3f2a1b4c-1111-4111-8111-111111111111 nicht übernommen');
});
