import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { DEFAULT_SEARCH_PROFILE, type RunSnapshot } from '../../shared/leadSearch.js';
import { MOCK_LEADS } from '../src/adapters/mock/mockData.js';
import { TrackingFileError, keyFromLinkedinUrl, keysForHit, parseTrackingWorkbook } from '../src/tracking/tracking.js';
import { mockApp, startBody, waitForEnd } from './helpers.js';

/** Kleine Nachbildung der Outreach-Tracking-Liste (gleicher Aufbau, erfundene Einträge). */
async function trackingWorkbook(extraUrls: string[] = []): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const overview = workbook.addWorksheet('Linkedin Outbound Tracking');
  overview.addRow([null, 'Kalenderwoche 33']);
  overview.addRow(['Anfragen ', 187]);

  const july = workbook.addWorksheet('July 2026');
  july.addRow(['Lead', 'Setter', 'Meta Ads', 'Vernertungsanfange', 'Anfrage Angebommen', 'Nachricht']);
  july.addRow([{ text: 'https://www.linkedin.com/in/max-beispiel-123/', hyperlink: 'https://www.linkedin.com/in/max-beispiel-123/' }, 'Nick', 'Keine Ads gefunden', 'Ja (ohne Nachricht)', 'Angenommen', 'FUP3']);
  july.addRow(['https://www.linkedin.com/in/j%C3%B6rg-muster-9/', 'Johannes', null, 'Ja (ohne Nachricht)', 'Ausstehend']);
  july.addRow([{ richText: [{ text: 'https://www.linkedin.com/in/' }, { text: 'Rich-Text-Person' }] }, 'Nick', null, 'Bereits vernetzt']);
  july.addRow(['https://www.linkedin.com/sales/lead/ACwAABo6TESTID,NAME_SEARCH,3uR8', 'Nick']);
  for (const url of extraUrls) july.addRow([url, 'Johannes', null, 'Ja (ohne Nachricht)', 'Abgelehnt']);
  july.addRow(['https://www.linkedin.com/in/max-beispiel-123/', 'Johannes']); // Doppelt → zählt einmal

  const costs = workbook.addWorksheet('Sheet2');
  costs.addRow([null, 'vanEliot', null, 'Avalon']);
  costs.addRow([-9.15, 30.04]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('LinkedIn-Links werden zu stabilen Schlüsseln', () => {
  assert.equal(keyFromLinkedinUrl('https://www.linkedin.com/in/Max-Beispiel-123/'), 'in:max-beispiel-123');
  assert.equal(keyFromLinkedinUrl('https://de.linkedin.com/in/j%C3%B6rg-muster-9?trk=x'), 'in:jörg-muster-9');
  assert.equal(keyFromLinkedinUrl('https://www.linkedin.com/sales/lead/ACwAABo6TESTID,NAME_SEARCH,3uR8'), 'id:ACwAABo6TESTID');
  assert.equal(keyFromLinkedinUrl('https://example.com'), null);
  assert.deepEqual(keysForHit({ providerId: 'ACoAA1', publicIdentifier: 'Max-Beispiel-123', profileUrl: null }), ['in:max-beispiel-123', 'id:ACoAA1']);
});

test('Tracking-Liste einlesen: alle Blätter, Links, Rich-Text, Setter und Status', async () => {
  const index = await parseTrackingWorkbook(await trackingWorkbook(), 'Outreach Tracking.xlsx');
  assert.equal(index.summary.count, 4);
  assert.deepEqual(index.summary.sheets, ['July 2026']);
  assert.deepEqual(index.summary.bySetter, { Nick: 3, Johannes: 1 });
  assert.deepEqual(index.entries['in:max-beispiel-123'], { setter: 'Nick', sheet: 'July 2026', status: 'Angenommen' });
  assert.deepEqual(index.entries['in:jörg-muster-9'], { setter: 'Johannes', sheet: 'July 2026', status: 'Ausstehend' });
  assert.equal(index.entries['in:rich-text-person'].status, 'Bereits vernetzt');
  assert.equal(index.entries['id:ACwAABo6TESTID'].status, null);
  // Andere Inhalte der Datei (z. B. Beträge aus „Sheet2“) landen nicht im Index.
  assert.doesNotMatch(JSON.stringify(index), /vanEliot|Avalon|9\.15/);
});

test('Ungültige Dateien werden verständlich abgelehnt', async () => {
  await assert.rejects(parseTrackingWorkbook(Buffer.from('kein excel'), 'x.xlsx'), TrackingFileError);
  const empty = new ExcelJS.Workbook();
  empty.addWorksheet('Leer').addRow(['nichts']);
  await assert.rejects(parseTrackingWorkbook(Buffer.from(await empty.xlsx.writeBuffer()), 'leer.xlsx'), /keine LinkedIn-Profil-Links/);
});

test('Upload über die API, danach landen Treffer aus der Liste im Dubletten-Filter', async () => {
  const app = mockApp();
  const tracked = MOCK_LEADS[0].hit; // Henrik Vossberg aus der Simulation
  const upload = await app.inject({
    method: 'PUT',
    url: '/api/lead-search/tracking',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Outreach Tracking – van Eliot.xlsx') },
    payload: await trackingWorkbook([tracked.profileUrl!]),
  });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.equal(upload.json().tracking.count, 5);
  assert.equal(upload.json().tracking.fileName, 'Outreach Tracking – van Eliot.xlsx');

  const config = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(config.tracking.count, 5);

  const started = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody({ profile: { ...DEFAULT_SEARCH_PROFILE } }) });
  const run: RunSnapshot = await waitForEnd(app, started.json().run.id);
  const lead = run.leads.find((entry) => entry.id === tracked.providerId);
  assert.equal(lead?.status, 'duplicate');
  assert.equal(lead?.note, 'Bereits im Tracking · Johannes · July 2026 · Abgelehnt');

  const bad = await app.inject({ method: 'PUT', url: '/api/lead-search/tracking', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('kaputt') });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error.message, /keine gültige Excel-Datei/);

  const removed = await app.inject({ method: 'DELETE', url: '/api/lead-search/tracking' });
  assert.equal(removed.json().tracking, null);
});

test('Tracking-Liste bleibt nach einem Neustart erhalten', async () => {
  const { tempDataDir } = await import('./helpers.js');
  const dir = tempDataDir();
  const first = mockApp(undefined, { DATA_DIR: dir });
  await first.inject({ method: 'PUT', url: '/api/lead-search/tracking', headers: { 'content-type': 'application/octet-stream' }, payload: await trackingWorkbook() });
  await first.close();
  const second = mockApp(undefined, { DATA_DIR: dir });
  const config = (await second.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(config.tracking.count, 4);
});

test('alte tracking.json aus dem Datenordner wird beim Start einmalig in die Datenbank übernommen', async () => {
  const { tempDataDir } = await import('./helpers.js');
  const { existsSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const dir = tempDataDir();
  const index = await parseTrackingWorkbook(await trackingWorkbook(), 'Alt.xlsx');
  writeFileSync(path.join(dir, 'tracking.json'), JSON.stringify(index));

  const app = mockApp(undefined, { DATA_DIR: dir });
  const config = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(config.tracking.count, 4);
  assert.equal(config.tracking.fileName, 'Alt.xlsx');
  assert.ok(!existsSync(path.join(dir, 'tracking.json')), 'alte Datei umbenannt');
  assert.ok(existsSync(path.join(dir, 'tracking.json.imported')));
});
