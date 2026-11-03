import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DATABASE_FILE, migrate, openDatabase } from '../src/db/database.js';
import { tempDataDir } from './helpers.js';

/** Migration 16 (echter Betrieb, 07.10.): Erfundenes aus Demo und Simulation wird gelöscht, Echtes bleibt. */

test('Migration 16: Demo- und Simulations-Leads samt Verlauf weg, echte Leads und Einstellungen bleiben', () => {
  const dataDir = tempDataDir();
  const old = new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  old.exec('PRAGMA foreign_keys = ON;');
  migrate(old, 15);

  const lead = old.prepare(
    `INSERT INTO leads (id, provider_id, owner, stage, search_text, person, company, origin, created_at, updated_at, last_activity_at)
     VALUES (?, ?, 'nick', 'contacted', '', '{}', '{}', ?, 1, 1, 1)`,
  );
  lead.run('demo', 'p-demo', '{"kind":"demo"}');
  lead.run('sim', 'p-sim', '{"kind":"search","runId":"r1","mode":"mock"}');
  lead.run('live', 'p-live', '{"kind":"search","runId":"r2","mode":"live"}');
  lead.run('tracking', 'p-tracking', '{"kind":"tracking","sheet":"Nick","setter":null}');

  const event = old.prepare("INSERT INTO lead_events (id, lead_id, kind, at, title, text) VALUES (?, ?, 'message_sent', 1, 'Nachricht', 'Hallo')");
  for (const id of ['demo', 'sim', 'live', 'tracking']) event.run(`e-${id}`, id);

  old.prepare("INSERT INTO enrichment_requests (lead_id, source, requested_at) VALUES ('demo', 'mock', 1), ('live', 'treg', 1)").run();
  old.prepare("INSERT INTO linkedin_seen_messages (message_id, lead_id, at) VALUES ('m-sim', 'sim', 1), ('m-live', 'live', 1)").run();
  const action = old.prepare("INSERT INTO linkedin_actions (id, founder, account_id, lead_id, kind, status, day, at) VALUES (?, 'nick', ?, ?, 'invite', 'sent', '2026-10-01', 1)");
  action.run('a-demo', 'acc_nick', 'demo');
  action.run('a-mock', 'mock-nick', null);
  action.run('a-live', 'acc_nick', 'live');

  const setting = old.prepare('INSERT INTO settings_values (key, secret, value, updated_at) VALUES (?, 0, ?, 1)');
  setting.run('LEAD_SEARCH_MODE', '"mock"');
  setting.run('MOCK_SPEED', '1');
  setting.run('MAX_RESULTS', '10');
  const history = old.prepare("INSERT INTO settings_history (at, username, key, action) VALUES (1, 'nick', ?, 'set')");
  history.run('LEAD_SEARCH_MODE');
  history.run('MAX_RESULTS');
  old.close();

  const db = openDatabase(dataDir);
  const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((row) => row.id).sort();

  assert.deepEqual(ids('SELECT id FROM leads'), ['live', 'tracking']);
  assert.deepEqual(ids('SELECT lead_id AS id FROM lead_events'), ['live', 'tracking'], 'Nachrichten der erfundenen Leads sind weg');
  assert.deepEqual(ids('SELECT lead_id AS id FROM enrichment_requests'), ['live']);
  assert.deepEqual(ids('SELECT lead_id AS id FROM linkedin_seen_messages'), ['live']);
  assert.deepEqual(ids('SELECT id FROM linkedin_actions'), ['a-live']);
  assert.deepEqual(ids('SELECT key AS id FROM settings_values'), ['MAX_RESULTS']);
  assert.deepEqual(ids('SELECT key AS id FROM settings_history'), ['MAX_RESULTS']);
  db.close();

  // Läuft nur einmal: Später übernommene Leads bleiben beim nächsten Start unberührt.
  const again = openDatabase(dataDir);
  assert.deepEqual((again.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number }).n, 2);
  again.close();
});
