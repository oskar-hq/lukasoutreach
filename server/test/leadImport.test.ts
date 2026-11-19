import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LeadDetailResponse } from '../../shared/leads.js';
import type { LeadAddResponse, LeadCompanySearchResponse, LeadImportResponse, LeadImportStatusResponse } from '../../shared/leadImport.js';
import { startFakeUnipile } from './fakeServers.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { tempDataDir } from './helpers.js';

/** Listen-Import (Lukas-Instanz 19.11., `shared/leadImport.ts`) – Simulation: Profil aus der Kennung erfunden, 1. Grad. */

function app(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', ...env });
  return buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
}

test('Import: einreihen mit Dubletten und Fehlern, abarbeiten mit Feldern, Kategorie und Notiz – ohne KI', async (t) => {
  const server = app();
  t.after(() => server.close());

  const imported = await server.inject({
    method: 'POST',
    url: '/api/leads/import',
    payload: {
      items: [
        { profile: 'https://www.linkedin.com/in/anna-gruenderin/', owner: 'nick', category: 'startup_gruender', note: 'Welle 1', fields: { welle: '1', aufhaenger: 'euer Launch' } },
        { profile: 'https://www.linkedin.com/in/ben-marketing', owner: 'nick', fields: { welle: '1' } },
        { profile: 'https://www.linkedin.com/in/ANNA-GRUENDERIN', owner: 'nick' },
        { profile: 'https://example.com/kein-profil', owner: 'nick' },
      ],
    },
  });
  assert.equal(imported.statusCode, 202, imported.body);
  const body = imported.json() as LeadImportResponse;
  assert.deepEqual(body.results.map((result) => result.status), ['queued', 'queued', 'duplicate', 'invalid']);
  assert.deepEqual([body.queued, body.duplicates, body.invalid], [2, 1, 1]);

  // Die Warteschlange läuft gleich nach dem Einreihen an – eine Runde abwarten.
  await server.leadImports.tick();
  const status = (await server.inject({ method: 'GET', url: '/api/leads/import/status?owner=nick' })).json() as LeadImportStatusResponse;
  assert.deepEqual(status.counts, { queued: 0, created: 2, duplicate: 0, failed: 0 });
  assert.equal(status.profilesToday.nick?.used, 2, 'zählt zum Tageslimit des Accounts');

  const annaId = status.recent.find((entry) => entry.profile.includes('anna'))!.leadId!;
  const anna = (await server.inject({ method: 'GET', url: `/api/leads/${annaId}` })).json() as LeadDetailResponse;
  assert.equal(anna.lead.assessment, null, 'keine KI-Einstufung');
  assert.equal(anna.lead.metaAds, null, 'kein Meta-Check');
  assert.deepEqual(anna.lead.fields, { welle: '1', aufhaenger: 'euer Launch', kategorie: 'startup_gruender' });
  assert.ok(anna.events.some((event) => event.kind === 'note' && event.text === 'Welle 1'), 'Notiz im Verlauf');

  // Noch einmal derselbe Link: jetzt Dublette mit Lead.
  const again = (await server.inject({ method: 'POST', url: '/api/leads/import', payload: { items: [{ profile: 'anna-gruenderin', owner: 'nick' }] } })).json() as LeadImportResponse;
  assert.equal(again.results[0].status, 'duplicate');
  assert.equal(again.results[0].leadId, annaId);

  // Felder ändern: mischen, leerer Wert löscht.
  const changed = await server.inject({ method: 'PUT', url: `/api/leads/${annaId}/fields`, payload: { fields: { welle: '2', aufhaenger: '' } } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual((changed.json() as LeadDetailResponse).lead.fields, { welle: '2', kategorie: 'startup_gruender' });
  const bad = await server.inject({ method: 'PUT', url: `/api/leads/${annaId}/fields`, payload: { fields: { 'Welle Eins': 'x' } } });
  assert.equal(bad.statusCode, 400);
});

test('Import hält das Tageslimit für Profilabrufe ein; add_lead sofort, danach 429', async (t) => {
  const server = app();
  t.after(() => server.close());
  const limits = await server.inject({ method: 'PUT', url: '/api/linkedin/accounts/mock-nick/limits', payload: { profilesPerDay: 2 } });
  assert.equal(limits.statusCode, 200, limits.body);

  const added = await server.inject({ method: 'POST', url: '/api/leads/add', payload: { profile: 'https://www.linkedin.com/in/clara-vc', owner: 'nick', category: 'vc_partner' } });
  assert.equal(added.statusCode, 201, added.body);
  assert.equal((added.json() as LeadAddResponse).status, 'created');
  const twice = await server.inject({ method: 'POST', url: '/api/leads/add', payload: { profile: 'clara-vc', owner: 'nick' } });
  assert.equal(twice.statusCode, 200);
  assert.equal((twice.json() as LeadAddResponse).status, 'duplicate');

  await server.inject({ method: 'POST', url: '/api/leads/import', payload: { items: ['d-eins', 'd-zwei', 'd-drei'].map((profile) => ({ profile, owner: 'nick' })) } });
  await server.leadImports.tick();
  const status = (await server.inject({ method: 'GET', url: '/api/leads/import/status' })).json() as LeadImportStatusResponse;
  assert.deepEqual([status.counts.created, status.counts.queued], [1, 2], 'nur ein Abruf frei (Limit 2, einer durch add_lead)');
  assert.match(status.message, /Tageslimit für Profilabrufe erreicht – es geht morgen weiter/);

  const full = await server.inject({ method: 'POST', url: '/api/leads/add', payload: { profile: 'e-voll', owner: 'nick' } });
  assert.equal(full.statusCode, 429);
});

test('Mehrere Personen derselben Firma: jede wird angelegt', async (t) => {
  const server = app();
  t.after(() => server.close());
  for (const profile of ['firma-eins-a', 'firma-eins-b', 'firma-eins-c']) {
    const response = await server.inject({ method: 'POST', url: '/api/leads/add', payload: { profile, owner: 'nick' } });
    assert.equal(response.statusCode, 201, response.body);
  }
});

test('Personen bei Firmen (Simulation): Liste ohne Import, mit import in die Warteschlange (Feld firma_suche)', async (t) => {
  const server = app();
  t.after(() => server.close());
  const look = (await server.inject({ method: 'POST', url: '/api/leads/company-search', payload: { companies: ['Acme GmbH'], owner: 'nick' } })).json() as LeadCompanySearchResponse;
  assert.equal(look.companies[0].people.length, 3);
  assert.equal(look.queued, 0);
  const take = (await server.inject({ method: 'POST', url: '/api/leads/company-search', payload: { companies: ['Acme GmbH', 'Beta AG'], owner: 'nick', import: true, title: 'Marketing' } })).json() as LeadCompanySearchResponse;
  assert.equal(take.queued, 6);
  assert.match(take.message, /6 Treffer bei 2 von 2 Firmen, 6 in die Warteschlange/);
  await server.leadImports.tick();
  const status = (await server.inject({ method: 'GET', url: '/api/leads/import/status?owner=nick&limit=1' })).json() as LeadImportStatusResponse;
  assert.equal(status.counts.created, 6);
  const lead = (await server.inject({ method: 'GET', url: `/api/leads/${status.recent[0].leadId}` })).json() as LeadDetailResponse;
  assert.match(lead.lead.fields?.firma_suche ?? '', /^(Acme GmbH|Beta AG)$/);
});

test('Personen bei Firmen (live gegen Fake-Unipile): advanced_keywords mit Firma und Position, zählt Suchtreffer', async (t) => {
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key', UNIPILE_DSN: unipile.baseUrl, UNIPILE_ACCOUNT_NICK: 'acc_nick', LINKEDIN_ACTIONS: 'off' });
  t.after(() => server.close());
  const response = await server.inject({ method: 'POST', url: '/api/leads/company-search', payload: { companies: ['Acme GmbH'], owner: 'nick', limit: 5 } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as LeadCompanySearchResponse;
  assert.equal(body.companies[0].people.length, 5);
  assert.equal(body.companies[0].people[0].profile, 'https://www.linkedin.com/in/person-1');
  const searches = unipile.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/linkedin/search'));
  assert.equal(searches.length, 1);
  assert.deepEqual((searches[0].body as { advanced_keywords: unknown }).advanced_keywords, { title: 'Marketing', company: 'Acme GmbH' });
  assert.equal(searches[0].query.get('account_id'), 'acc_nick');
  assert.equal(server.leadImports.searchRoom('nick').used, 5, 'angefragte Seite zählt zum Tageslimit für Suchtreffer');
  assert.equal(unipile.requests.filter((request) => request.method === 'POST' && !request.path.endsWith('/linkedin/search')).length, 0, 'nichts gesendet');
});
