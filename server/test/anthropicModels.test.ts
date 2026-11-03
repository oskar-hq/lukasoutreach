import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ANTHROPIC_BUILTIN_MODELS } from '../../shared/settings.js';
import { AnthropicModels, MODELS_CACHE_MS } from '../src/ai/models.js';

/** Nachgebaute Models-API: zwei Seiten, damit das Weiterblättern geprüft ist. */
async function fakeModels() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.headers['x-api-key'] !== 'ant-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const second = url.searchParams.get('after_id') === 'claude-opus-5-5';
    const data = second
      ? [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-05-01T00:00:00Z' }]
      : [
          { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-08-01T00:00:00Z' },
          { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z' },
        ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data, has_more: !second, first_id: data[0].id, last_id: data[data.length - 1].id }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => server.close() };
}

test('Modelle live von Anthropic: alle Seiten, neueste zuerst, eine Stunde zwischengespeichert', async (t) => {
  const fake = await fakeModels();
  t.after(fake.close);
  let now = 1_000_000;
  const models = new AnthropicModels({ baseURL: fake.url, now: () => now });
  const first = await models.list('ant-key', 'live');
  assert.equal(first.source, 'anthropic');
  assert.deepEqual(first.models.map((model) => model.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.equal(first.models[0].label, 'Claude Opus 5.5');
  assert.equal(fake.requests.length, 2);
  await models.list('ant-key', 'live');
  assert.equal(fake.requests.length, 2, 'aus dem Zwischenspeicher');
  now += MODELS_CACHE_MS + 1;
  await models.list('ant-key', 'live');
  assert.equal(fake.requests.length, 4, 'nach einer Stunde neu');
});

test('Ohne Schlüssel, in der Simulation oder bei abgelehntem Schlüssel: eingebaute Liste mit Hinweis, Schlüssel nie in der Meldung', async (t) => {
  const fake = await fakeModels();
  t.after(fake.close);
  const models = new AnthropicModels({ baseURL: fake.url });
  for (const result of [await models.list(null, 'live'), await models.list('ant-key', 'mock'), await models.list('geheim-falsch', 'live')]) {
    assert.equal(result.source, 'builtin');
    assert.deepEqual(result.models, [...ANTHROPIC_BUILTIN_MODELS]);
    assert.ok(result.notice);
    assert.doesNotMatch(result.notice!, /geheim/);
  }
  assert.match((await models.list('geheim-falsch', 'live')).notice!, /lehnt den API-Schlüssel ab/);
});
