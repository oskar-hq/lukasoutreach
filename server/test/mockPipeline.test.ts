import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  DEFAULT_SEARCH_PROFILE,
  QUALIFYING_CATEGORIES,
  funnelOf,
  type NewLeadCard,
  type RunEvent,
  type RunSnapshot,
} from '../../shared/leadSearch.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { MOCK_LEADS } from '../src/adapters/mock/mockData.js';
import { countBy, mockApp, startBody, waitForEnd } from './helpers.js';

async function startRun(app: ReturnType<typeof mockApp>, body = startBody()) {
  const response = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: body });
  assert.equal(response.statusCode, 202, response.body);
  return (response.json() as { run: RunSnapshot }).run;
}

test('Mock-Datensatz: 40 Treffer, ca. 30 % qualifiziert, Rest verteilt', () => {
  assert.equal(MOCK_LEADS.length, 40);
  const qualified = MOCK_LEADS.filter((lead) => QUALIFYING_CATEGORIES.includes(lead.ai.category) && lead.ai.qualified && !lead.openInvitation);
  assert.equal(new Set(MOCK_LEADS.map((lead) => lead.hit.providerId)).size, 40, 'Provider-IDs eindeutig');
  assert.ok(qualified.length >= 12, `qualifiziert: ${qualified.length}`);
  assert.equal(MOCK_LEADS.filter((lead) => lead.openInvitation).length, 3);
});

test('Konfiguration meldet den Modus und das Limit', async () => {
  const app = mockApp();
  const response = await app.inject({ method: 'GET', url: '/api/lead-search/config' });
  const config = response.json();
  assert.equal(config.mode, 'mock');
  assert.equal(config.ready, true);
  assert.equal(config.maxResultsLimit, 1000);
  assert.equal(config.searchHits, 400);
  assert.equal(config.backlog, 0);
  assert.equal(config.defaults.maxResults, 15);
  assert.equal(config.live, null);
  assert.equal(config.metaAds, true);
});

test('kompletter Lauf: Trichter 40 → 33 → 15 → 7 → 5, Übergabe auch der Firmen mit aktiven Meta-Ads (markiert)', async () => {
  const app = mockApp();
  const started = await startRun(app);
  assert.equal(started.status, 'running');
  const run = await waitForEnd(app, started.id);

  assert.equal(run.status, 'done');
  assert.equal(run.phase, 'done');
  assert.equal(run.error, null);
  assert.deepEqual(run.searchPlan, { hits: 400, backlog: 0, newHits: 400 });
  assert.deepEqual(funnelOf(run.leads), { found: 40, unique: 33, screened: 31, enriched: 15, fit: 7, qualified: 5 });
  assert.deepEqual(countBy(run.leads, (lead) => lead.status), {
    qualified: 5,
    ads_active: 2,
    rejected: 8,
    duplicate: 4,
    invited: 3,
    deferred: 16,
    screened_out: 2,
  });

  const duplicates = run.leads.filter((lead) => lead.status === 'duplicate');
  assert.ok(duplicates.every((lead) => lead.note?.startsWith('Bereits im Cockpit')));
  assert.equal(duplicates.filter((lead) => lead.note === 'Bereits im Cockpit · Johannes').length, 1);

  const rejected = run.leads.filter((lead) => lead.status === 'rejected');
  assert.ok(rejected.every((lead) => lead.qualification && !lead.qualification.qualified));
  assert.ok(rejected.some((lead) => lead.note === 'Falsche Branche'));
  assert.ok(!rejected.some((lead) => /Makler|Sonstige/.test(lead.note ?? '')), 'keine Kategorie als Grund');

  // Meta-Werbebibliothek: wer gerade Anzeigen schaltet, fliegt raus – beendete oder keine Anzeigen bleiben.
  const adsActive = run.leads.filter((lead) => lead.status === 'ads_active');
  assert.deepEqual(adsActive.map((lead) => lead.profile?.companyName).sort(), ['Achterberg Wohnbau GmbH & Co. KG', 'Kettler Invest & Immobilien']);
  assert.ok(adsActive.every((lead) => lead.metaAds?.state === 'active'));
  assert.deepEqual(adsActive.map((lead) => lead.note).sort(), ['Aktive Meta-Ads (2) – von Hand prüfen', 'Aktive Meta-Ads (3) – von Hand prüfen']);
  const byCompany = new Map(run.leads.map((lead) => [lead.profile?.companyName, lead]));
  const freiberger = byCompany.get('Freiberger Capital Estates GmbH')!;
  assert.equal(freiberger.status, 'qualified');
  assert.equal(freiberger.metaAds?.state, 'stopped');
  assert.equal(freiberger.metaAds?.lastStop, new Date(Date.now() - 19 * 86_400_000).toISOString().slice(0, 10));
  assert.equal(freiberger.metaAds?.advertiser, 'Freiberger Capital Estates');
  assert.match(freiberger.metaAds?.libraryUrl ?? '', /^https:\/\/www\.facebook\.com\/ads\/library\/\?.*view_all_page_id=\d+/);
  const weller = byCompany.get('Weller Quartiersentwicklung GmbH')!;
  assert.equal(weller.metaAds?.state, 'none');
  assert.equal(weller.metaAds?.foreignAds, 3);
  assert.equal(weller.metaAds?.note, 'Nur Fremdtreffer (3 Anzeigen anderer Werbetreibender)');
  assert.ok(run.leads.filter((lead) => lead.status === 'rejected').every((lead) => lead.metaAds === null), 'Aussortierte kosten keine Abfrage');

  const deferred = run.leads.filter((lead) => lead.status === 'deferred');
  assert.ok(deferred.every((lead) => lead.profile === null && lead.note?.includes('Limit von 15')));

  const handoff = await app.inject({ method: 'POST', url: `/api/lead-search/runs/${run.id}/handoff` });
  assert.equal(handoff.statusCode, 200);
  const { leads } = handoff.json() as { leads: NewLeadCard[] };
  assert.equal(leads.length, 7);
  assert.equal(leads.filter((lead) => lead.metaAds?.state === 'active').length, 2, 'aktive Meta-Ads gehen markiert mit');
  for (const lead of leads) {
    assert.ok(QUALIFYING_CATEGORIES.includes(lead.category));
    assert.ok(lead.metaAds && ['none', 'stopped', 'active'].includes(lead.metaAds.state), lead.company);
    assert.ok(lead.summary.length > 20 && lead.reason.length > 10 && lead.company.length > 2);
    assert.equal(lead.mode, 'mock');
  }
  // Hiring-Signal (13.10.): Vossberg per Stichwort in der Firmenbeschreibung, Freiberger von der KI, sonst keins.
  const hiring = Object.fromEntries(leads.filter((lead) => lead.hiring).map((lead) => [lead.company, lead.hiring]));
  assert.deepEqual(Object.keys(hiring).sort(), ['Freiberger Capital Estates GmbH', 'Vossberg Anlageimmobilien GmbH']);
  assert.equal(hiring['Vossberg Anlageimmobilien GmbH']?.role, 'Vertriebsmitarbeiter (m/w/d)');
  assert.equal(hiring['Vossberg Anlageimmobilien GmbH']?.source, 'profile');
  assert.match(hiring['Vossberg Anlageimmobilien GmbH']?.evidence ?? '', /^Firmenbeschreibung: „.*Wir suchen Vertriebsmitarbeiter \(m\/w\/d\)/);
  assert.deepEqual(hiring['Freiberger Capital Estates GmbH'], { role: 'Immobilienberater (m/w/d)', source: 'ai', evidence: null });
});

test('zweiter Lauf überspringt bereits Geprüftes und arbeitet den Rest ab', async () => {
  const app = mockApp();
  const first = await waitForEnd(app, (await startRun(app)).id);
  const checked = first.leads.filter((lead) => lead.profile).map((lead) => lead.id);
  const second = await waitForEnd(app, (await startRun(app, startBody({ checked }))).id);

  assert.deepEqual(funnelOf(second.leads), { found: 40, unique: 18, screened: 16, enriched: 15, fit: 5, qualified: 3 });
  const rejected = second.leads.filter((lead) => lead.status === 'rejected');
  assert.ok(rejected.some((lead) => lead.note === 'Einschätzung zu unsicher (52 %)'), 'strenge Regel greift');
  assert.equal(second.leads.filter((lead) => lead.note === 'In einem früheren Lauf bereits geprüft').length, 15);
});

test('ohne bekannte Leads aus dem Browser erkennt die Datenbank die Demo-Leads; offene Anfragen aus der Demo zählen mit', async () => {
  const app = mockApp();
  const run = await waitForEnd(
    app,
    (await startRun(app, startBody({ known: [], pendingInvitations: [MOCK_LEADS[0].hit.providerId] }))).id,
  );
  const duplicates = run.leads.filter((lead) => lead.status === 'duplicate');
  assert.equal(duplicates.length, 4, 'dieselben 4 Demo-Leads wie mit „known“ – jetzt aus der Datenbank');
  assert.ok(duplicates.some((lead) => lead.note === 'Bereits im Cockpit · Johannes · Neu'), duplicates.map((lead) => lead.note).join(' | '));
  assert.equal(run.leads.find((lead) => lead.id === MOCK_LEADS[0].hit.providerId)?.status, 'invited');
  assert.equal(run.leads.filter((lead) => lead.status === 'invited').length, 4);
});

test('Max. Anzahl über 1000 wird abgelehnt, 25 wird eingehalten, 200 liest alle Vorgeprüften', async () => {
  const app = mockApp();
  const tooMany = await app.inject({
    method: 'POST',
    url: '/api/lead-search/runs',
    payload: startBody({ profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 1001 } }),
  });
  assert.equal(tooMany.statusCode, 400);

  const run = await waitForEnd(app, (await startRun(app, startBody({ profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 25 } }))).id);
  assert.equal(funnelOf(run.leads).enriched, 25);
  assert.equal(funnelOf(run.leads).fit, 10);
  assert.equal(funnelOf(run.leads).qualified, 7);

  // Ohne praktische Grenze (Wunsch des Nutzers 11.10.): alle 31 Vorgeprüften werden gelesen, keiner zurückgestellt.
  const all = await waitForEnd(app, (await startRun(app, startBody({ profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 200 } }))).id);
  assert.equal(all.profile.maxResults, 200);
  assert.equal(funnelOf(all.leads).enriched, 31);
  assert.equal(all.leads.filter((lead) => lead.status === 'deferred').length, 0);
});

test('nur ein Lauf gleichzeitig; Abbrechen beendet den Lauf sauber', async () => {
  const app = mockApp(new MockAdapter(0.2));
  const run = await startRun(app);
  const busy = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  assert.equal(busy.statusCode, 409);

  await new Promise((resolve) => setTimeout(resolve, 900));
  const cancel = await app.inject({ method: 'POST', url: `/api/lead-search/runs/${run.id}/cancel` });
  assert.equal(cancel.statusCode, 200);
  const done = await waitForEnd(app, run.id);
  assert.equal(done.status, 'cancelled');
  assert.ok(done.leads.every((lead) => !['found', 'unique', 'enriching', 'enriched', 'qualifying', 'checking_ads'].includes(lead.status)));

  // Danach ist wieder Platz für einen neuen Lauf.
  const next = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  assert.equal(next.statusCode, 202);
  await app.close();
});

test('Server-Sent Events: erst Snapshot, dann Änderungen, am Ende der fertige Lauf', async () => {
  const app = mockApp(new MockAdapter(0.02));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  try {
    const run = await startRun(app);
    const response = await fetch(`http://127.0.0.1:${port}/api/lead-search/runs/${run.id}/events`);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const text = await response.text();
    const events = text
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)) as RunEvent);

    assert.equal(events[0].type, 'run');
    const last = events.at(-1)!;
    assert.equal(last.type, 'end');
    assert.ok(events.filter((event) => event.type === 'leads').length > 40);
    assert.deepEqual(
      events.filter((event) => event.type === 'phase').map((event) => (event.type === 'phase' ? event.phase : '')),
      ['dedupe', 'screen', 'enrich', 'done'],
    );
    if (last.type === 'end') assert.equal(funnelOf(last.run.leads).qualified, 5);
  } finally {
    await app.close();
  }
});

test('unbekannter Lauf → 404', async () => {
  const app = mockApp();
  const response = await app.inject({ method: 'GET', url: '/api/lead-search/runs/00000000-0000-4000-8000-000000000000' });
  assert.equal(response.statusCode, 404);
});
