import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE } from '../../shared/leadSearch.js';
import { migrate, openDatabase } from '../src/db/database.js';
import { tempDataDir } from './helpers.js';

test('Migration 45 (28.10.): gespeicherte Zeitpläne mit Bauträger-Stichwörtern bekommen die neuen Standard-Stichwörter', () => {
  const db = openDatabase(tempDataDir());
  // Zurück auf Stand 44, zwei Zeitpläne anlegen, dann weiter migrieren.
  db.exec('PRAGMA user_version = 44');
  const insert = db.prepare('INSERT OR REPLACE INTO auto_search_schedules (founder, enabled, days, time, profile, updated_at, updated_by) VALUES (?, 1, ?, ?, ?, 0, NULL)');
  const old = { keywords: ['Kapitalanlage', 'Bauträger', 'Projektentwicklung', 'Immobilienvertrieb'], positions: ['Geschäftsführer'], region: 'Bayern', maxResults: 25 };
  const own = { keywords: ['Allfinanz', 'Kapitalanlage'], positions: ['CEO'], region: 'Deutschland', maxResults: 10 };
  insert.run('nick', '[1]', '07:00', JSON.stringify(old));
  insert.run('johannes', '[1]', '07:00', JSON.stringify(own));
  migrate(db);
  const profile = (founder: string) => JSON.parse((db.prepare('SELECT profile FROM auto_search_schedules WHERE founder = ?').get(founder) as { profile: string }).profile);
  assert.deepEqual(profile('nick'), { ...old, keywords: [...DEFAULT_SEARCH_PROFILE.keywords] }, 'nur die Stichwörter ändern sich');
  assert.deepEqual(profile('johannes'), own, 'ohne Bauträger-Begriffe bleibt alles');
  db.close();
});
