import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mockApp, tempDataDir } from './helpers.js';

/** Schutz der Antworten und des Protokolls: keine internen Details, kein Browser-Cache, keine Suchbegriffe im Log. */

test('Unerwarteter Fehler: allgemeine Meldung statt interner Details', async () => {
  const app = mockApp();
  app.get('/api/test/kaputt', async () => {
    throw new Error('SQLITE_ERROR: no such column x in /app/server/data/cockpit.db');
  });
  const response = await app.inject({ method: 'GET', url: '/api/test/kaputt' });
  assert.equal(response.statusCode, 500);
  const body = response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'internal');
  assert.doesNotMatch(response.body, /SQLITE|cockpit\.db|\/app\//);
  await app.close();
});

test('Fehler der Anfrage (4xx) bleiben verständlich', async () => {
  const app = mockApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/leads',
    headers: { 'content-type': 'application/json' },
    payload: '{kaputt',
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as { code: string }).code, 'FST_ERR_CTP_INVALID_JSON_BODY');
  await app.close();
});

test('API-Antworten: nie im Browser-Cache, kein MIME-Raten', async () => {
  const app = mockApp();
  for (const url of ['/api/health', '/api/leads', '/api/gibt-es-nicht']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.headers['cache-control'], 'no-store', url);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', url);
  }
  await app.close();
});

test('Protokoll: Anfragen ohne Query (keine gesuchten Namen)', async () => {
  const lines: string[] = [];
  const app = buildApp({
    config: loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir() }),
    adapter: new MockAdapter(0),
    logger: { level: 'info', stream: { write: (line: string) => lines.push(line) } },
    requireSession: false,
  });
  const response = await app.inject({ method: 'GET', url: '/api/leads?q=Max%20Mustermann' });
  assert.equal(response.statusCode, 200);
  const logged = lines.map((line) => JSON.parse(line) as { req?: { url: string } }).filter((line) => line.req);
  assert.ok(logged.some((line) => line.req?.url === '/api/leads'), 'Anfrage steht mit Pfad im Protokoll');
  assert.ok(!lines.some((line) => line.includes('Mustermann')), 'Suchbegriff steht nicht im Protokoll');
  await app.close();
});
