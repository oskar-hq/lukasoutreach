import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_OPEN_ROUTES } from '../../shared/auth.js';
import type { EnrichmentStatusResponse } from '../../shared/enrichment.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CreateLeadsResponse, LeadDetailResponse, LeadListResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mockValues, parseClayResult, parseEmployees, parseSocial, parseTregCompany } from '../src/enrichment/values.js';
import { startFakeClay, startFakeTreg } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

const SECRET = 'geheimer-rueckkanal-schluessel-123456';

function app(env: NodeJS.ProcessEnv = {}, requireSession = false) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({ config: loadConfig({ ...base, ...env }), adapter: new MockAdapter(0), logger: false, requireSession });
}

type App = ReturnType<typeof app>;

const card = (overrides: Partial<NewLeadCard> = {}): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: 'ACoCLAY001',
  publicIdentifier: 'erika-muster',
  profileUrl: 'https://www.linkedin.com/in/erika-muster',
  firstName: 'Erika',
  lastName: 'Muster',
  headline: 'Geschäftsführerin · Muster Wohnbau GmbH',
  position: 'Geschäftsführerin',
  company: 'Muster Wohnbau GmbH',
  location: 'Köln',
  website: 'https://www.muster-wohnbau.de',
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.88,
  reason: 'Entwickelt und verkauft selbst.',
  summary: 'Bauträger aus Köln.',
  metaAds: { state: 'none', advertiser: null, ads: 0, activeAds: 0, lastStop: null, foreignAds: 0, libraryUrl: null, note: null },
  ...overrides,
});

const get = async (server: App, url: string) => (await server.inject({ method: 'GET', url })).json();
const enrich = (server: App, id: string) => server.inject({ method: 'POST', url: `/api/leads/${id}/enrich` });
const callback = (server: App, payload: object, secret: string | null = SECRET) =>
  server.inject({ method: 'POST', url: '/api/enrichment/clay', payload, headers: secret ? { 'x-cockpit-secret': secret } : {} });

async function createLead(server: App, overrides: Partial<NewLeadCard> = {}) {
  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card(overrides)], owner: 'nick' } });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created[0];
}

// ── Werte lesen ────────────────────────────────────────────────────────────

test('Mitarbeiterzahl: Spannen, Tausendertrennzeichen, „+“, Unbrauchbares', () => {
  assert.deepEqual(parseEmployees('11-50'), { employees: 31, employeesRange: '11–50' });
  assert.deepEqual(parseEmployees('51 - 200 employees'), { employees: 126, employeesRange: '51–200' });
  assert.deepEqual(parseEmployees('1.234'), { employees: 1234, employeesRange: null });
  assert.deepEqual(parseEmployees('10,001+'), { employees: 10001, employeesRange: '10001+' });
  assert.deepEqual(parseEmployees(25), { employees: 25, employeesRange: null });
  for (const empty of ['', 'null', 'N/A', null, undefined, {}, 'keine Angabe', 0]) {
    assert.deepEqual(parseEmployees(empty), { employees: null, employeesRange: null }, String(empty));
  }
});

test('Social-Links: nur echte Profile des jeweiligen Netzwerks, immer https', () => {
  assert.equal(parseSocial('instagram', 'instagram.com/muster'), 'https://instagram.com/muster');
  assert.equal(parseSocial('instagram', 'http://www.instagram.com/muster/'), 'https://www.instagram.com/muster/');
  assert.equal(parseSocial('x', 'https://twitter.com/muster'), 'https://twitter.com/muster');
  assert.equal(parseSocial('facebook', 'https://de.facebook.com/muster'), 'https://de.facebook.com/muster');
  for (const bad of ['https://evil.example/instagram.com', 'javascript:alert(1)', 'https://instagram.com/', 'https://instagram.com.evil.de/x', 'a b']) {
    assert.equal(parseSocial('instagram', bad), null, bad);
  }
});

test('Clay-Rückmeldung: Text-Listen, Meta-Pixel/GTM aus dem Tech-Stack, leere Zellen', () => {
  const { values, usable } = parseClayResult({
    leadId: 'x',
    employees: '11-50',
    revenue: '1M-5M',
    techStack: 'WordPress, Facebook Pixel; Google Tag Manager, wordpress',
    instagram: 'instagram.com/muster',
    facebook: '',
    socials: { linkedin: 'https://www.linkedin.com/company/muster' },
    twitter: 'null',
  });
  assert.equal(usable, true);
  assert.deepEqual(values.techStack, ['WordPress', 'Facebook Pixel', 'Google Tag Manager']);
  assert.equal(values.metaPixel, true);
  assert.equal(values.googleTagManager, true);
  assert.equal(values.revenue, '1M-5M');
  assert.equal(values.socials.instagram, 'https://instagram.com/muster');
  assert.equal(values.socials.linkedin, 'https://www.linkedin.com/company/muster');
  assert.equal(values.socials.facebook, null);
  assert.equal(values.socials.x, null);

  const noPixel = parseClayResult({ techStack: ['Wix'] }).values;
  assert.equal(noPixel.metaPixel, false, 'Tech-Stack bekannt, kein Pixel → false');
  assert.equal(parseClayResult({ employees: 5 }).values.metaPixel, null, 'kein Tech-Stack → unbekannt');
  assert.equal(parseClayResult({ techStack: ['Wix'], metaPixel: 'true' }).values.metaPixel, true, 'ausdrückliche Angabe gewinnt');
  assert.equal(parseClayResult({ employees: '', revenue: 'null', techStack: '' }).usable, false);
});

test('Simulation: gleiche Firma, gleiche Werte; ohne Website kein Tech-Stack', () => {
  assert.deepEqual(mockValues({ name: 'Muster GmbH', website: 'https://muster.de' }), mockValues({ name: 'Muster GmbH', website: 'https://muster.de' }));
  const noSite = mockValues({ name: 'Muster GmbH', website: null });
  assert.deepEqual(noSite.techStack, []);
  assert.equal(noSite.metaPixel, null);
  assert.ok(noSite.employees! > 0);
});

// ── Simulation ─────────────────────────────────────────────────────────────

test('Simulation: Demo-Leads ab „Anfrage gesendet“ angereichert, „Neu“ nicht; Status', async () => {
  const server = app();
  const { leads } = (await get(server, '/api/leads?limit=100')) as LeadListResponse;
  for (const lead of leads) {
    if (lead.stage === 'new') assert.equal(lead.enrichment ?? null, null, lead.id);
    else {
      assert.equal(lead.enrichment?.status, 'done', lead.id);
      const size = lead.score!.icp.components.find((component) => component.key === 'company_size');
      assert.notEqual(size?.value, null, 'Firmengröße zählt jetzt mit');
    }
  }
  const status = (await get(server, '/api/enrichment/status')) as EnrichmentStatusResponse;
  assert.deepEqual(status, { mode: 'mock', provider: 'treg', autoEnrich: true, dailyLimit: 50, usedToday: 0 });
});

test('Simulation: anreichern → 202, Score neu, Ereignis im Verlauf, zählt fürs Tageslimit', async () => {
  const server = app();
  const { leads } = (await get(server, '/api/leads?stage=new&limit=1')) as LeadListResponse;
  const before = leads[0];
  const response = await enrich(server, before.id);
  assert.equal(response.statusCode, 202, response.body);
  const { lead, events } = response.json() as LeadDetailResponse;
  assert.equal(lead.enrichment?.status, 'done');
  assert.equal(lead.enrichment?.source, 'mock');
  assert.ok(lead.enrichment!.employees! > 0);
  assert.notEqual(lead.score!.icp.components.find((component) => component.key === 'company_size')!.value, null);
  assert.ok(lead.score!.completeness > before.score!.completeness);
  const event = events.at(-1)!;
  assert.equal(event.kind, 'enriched');
  assert.match(event.title, /^Firmendaten ergänzt \(Simulation\): .*Mitarbeiter/);
  assert.match(event.text!, /^Score \d,\d\d → \d,\d\d \((Hoch|Mittel|Niedrig)\)$/);
  assert.equal(((await get(server, '/api/enrichment/status')) as EnrichmentStatusResponse).usedToday, 1);

  assert.equal((await enrich(server, 'gibt-es-nicht')).statusCode, 404);
});

test('Simulation mit Verzögerung: erst pending, zweite Anfrage kostet nichts, dann done', async () => {
  const server = app({ MOCK_SPEED: '0.02' });
  const { leads } = (await get(server, '/api/leads?stage=new&limit=1')) as LeadListResponse;
  const first = (await enrich(server, leads[0].id)).json() as LeadDetailResponse;
  assert.equal(first.lead.enrichment?.status, 'pending');
  const second = (await enrich(server, leads[0].id)).json() as LeadDetailResponse;
  assert.equal(second.lead.enrichment?.requestedAt, first.lead.enrichment?.requestedAt);
  assert.equal(((await get(server, '/api/enrichment/status')) as EnrichmentStatusResponse).usedToday, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const done = (await get(server, `/api/leads/${leads[0].id}`)) as LeadDetailResponse;
  assert.equal(done.lead.enrichment?.status, 'done');
  await server.close();
});

test('Tageslimit: 429 mit Retry-After bis Mitternacht UTC', async () => {
  const server = app({ CLAY_MAX_PER_DAY: '1' });
  const { leads } = (await get(server, '/api/leads?stage=new&limit=2')) as LeadListResponse;
  assert.equal((await enrich(server, leads[0].id)).statusCode, 202);
  const blocked = await enrich(server, leads[1].id);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'enrichment_limit');
  const retry = Number(blocked.headers['retry-after']);
  assert.ok(retry > 0 && retry <= 24 * 60 * 60);
});

test('Übergabe in der Simulation: Score Hoch/Mittel automatisch angereichert, Niedrig nicht', async () => {
  const server = app();
  const response = await server.inject({
    method: 'POST',
    url: '/api/leads',
    payload: { owner: 'nick', cards: [card({ mode: 'mock' }), card({ mode: 'mock', providerId: 'ACoLOW', category: 'sonstiges', confidence: 0.3, position: 'Assistenz', headline: '', website: null, location: 'Paris' })] },
  });
  const { created } = response.json() as CreateLeadsResponse;
  assert.equal(created[0].enrichment?.status, 'done');
  assert.equal(created[1].score?.tier, 'low');
  assert.equal(created[1].enrichment ?? null, null);

  const off = app({ ENRICH_AUTO: 'false' });
  assert.equal((await createLead(off, { mode: 'mock' })).enrichment ?? null, null);

  // Die Simulation erfindet nie Firmendaten für echte Leads (aus Live-Läufen).
  const real = await createLead(off, { providerId: 'ACoECHT' });
  const refused = await enrich(off, real.id);
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error.message, /keine Firmendaten für echte Leads/);
});

// ── Live ───────────────────────────────────────────────────────────────────

test('Live ohne Zugang: Modus off, anreichern 409, Rückkanal 404', async () => {
  const server = app({ LEAD_SEARCH_MODE: 'live', ENRICHMENT_PROVIDER: 'clay' });
  assert.deepEqual(await get(server, '/api/enrichment/status'), { mode: 'off', provider: 'clay', autoEnrich: false, dailyLimit: 50, usedToday: 0 });
  const lead = await createLead(server);
  const response = await enrich(server, lead.id);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'enrichment_off');
  assert.equal((await callback(server, { leadId: lead.id, employees: 5 })).statusCode, 404);
});

test('Konfiguration: kurzer Schlüssel und http-Webhook werden abgelehnt', () => {
  assert.equal(loadConfig({}).treg.maxCostUsd, 0.05);
  assert.throws(() => loadConfig({ TREG_MAX_COST_USD: '5' }), /TREG_MAX_COST_USD/);
  assert.throws(() => loadConfig({ TREG_MAX_COST_USD: '0' }), /TREG_MAX_COST_USD/);
  assert.throws(() => loadConfig({ CLAY_CALLBACK_SECRET: 'zu-kurz' }), /mindestens 24 Zeichen/);
  assert.throws(() => loadConfig({ CLAY_WEBHOOK_URL: 'http://clay.example/webhook' }), /https:\/\//);
  assert.equal(loadConfig({ LEAD_SEARCH_MODE: 'live' }).clay.autoEnrich, false, 'live standardmäßig aus (Credits)');
});

test('Live: an den Clay-Webhook senden, Rückkanal mit Schlüssel → Score neu', async (t) => {
  const clay = await startFakeClay({ token: 'clay-token' });
  t.after(() => clay.close());
  const server = app({
    LEAD_SEARCH_MODE: 'live',
    ENRICHMENT_PROVIDER: 'clay',
    CLAY_WEBHOOK_URL: `${clay.baseUrl}/webhook`,
    CLAY_WEBHOOK_TOKEN: 'clay-token',
    CLAY_CALLBACK_SECRET: SECRET,
    PUBLIC_URL: 'https://crm.example.de',
  });
  const lead = await createLead(server);
  assert.equal(lead.enrichment ?? null, null, 'live ohne CLAY_AUTO_ENRICH keine automatische Anfrage');

  const sent = await enrich(server, lead.id);
  assert.equal(sent.statusCode, 202);
  assert.equal((sent.json() as LeadDetailResponse).lead.enrichment?.status, 'pending');
  assert.equal(clay.requests.length, 1);
  const request = clay.requests[0];
  assert.equal(request.headers['x-clay-webhook-auth'], 'clay-token');
  assert.deepEqual(request.body, {
    leadId: lead.id,
    firstName: 'Erika',
    lastName: 'Muster',
    fullName: 'Erika Muster',
    position: 'Geschäftsführerin',
    linkedinUrl: 'https://www.linkedin.com/in/erika-muster',
    location: 'Köln',
    company: 'Muster Wohnbau GmbH',
    website: 'https://www.muster-wohnbau.de',
    domain: 'muster-wohnbau.de',
    callbackUrl: 'https://crm.example.de/api/enrichment/clay',
  });

  assert.equal((await callback(server, { leadId: lead.id, employees: 20 }, null)).statusCode, 401);
  assert.equal((await callback(server, { leadId: lead.id, employees: 20 }, 'falsch')).statusCode, 401);
  assert.equal((await callback(server, { employees: 20 })).statusCode, 400);
  assert.equal((await callback(server, { leadId: 'unbekannt', employees: 20 })).statusCode, 404);

  const ok = await server.inject({
    method: 'POST',
    url: '/api/enrichment/clay',
    headers: { authorization: `Bearer ${SECRET}` },
    payload: { leadId: lead.id, employees: '11-50', techStack: 'WordPress, Meta Pixel', instagram: 'instagram.com/musterwohnbau' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { ok: true, status: 'done' });
  const { lead: after, events } = (await get(server, `/api/leads/${lead.id}`)) as LeadDetailResponse;
  assert.equal(after.enrichment?.source, 'clay');
  assert.equal(after.enrichment?.employees, 31);
  assert.equal(after.enrichment?.metaPixel, true);
  assert.equal(after.score!.icp.components.find((component) => component.key === 'company_size')!.value, 1);
  assert.equal(after.score!.ads.opportunity, 0.85, 'Pixel ohne laufende Anzeigen');
  assert.match(after.score!.ads.detail, /Meta-Pixel/);
  assert.equal(events.at(-1)!.title, 'Firmendaten ergänzt (Clay): 11–50 Mitarbeiter · Meta-Pixel · 1 Social-Profil');

  const empty = await callback(server, { leadId: lead.id, employees: '', techStack: '' });
  assert.deepEqual(empty.json(), { ok: true, status: 'failed' });
  const failed = ((await get(server, `/api/leads/${lead.id}`)) as LeadDetailResponse).lead;
  assert.equal(failed.enrichment?.error, 'Clay hat keine Firmendaten gefunden.');
  assert.equal(failed.enrichment?.employees, 31, 'frühere Daten bleiben');
  assert.equal(failed.score!.total, after.score!.total);

  // Neue Anfrage: bisherige Werte bleiben bis zum Ergebnis sichtbar und zählen weiter.
  const again = (await enrich(server, lead.id)).json() as LeadDetailResponse;
  assert.equal(again.lead.enrichment?.status, 'pending');
  assert.equal(again.lead.enrichment?.employees, 31);
  assert.equal(again.lead.score!.total, after.score!.total);
});

test('Live: Clay lehnt ab → failed mit verständlicher Meldung, ohne Schlüssel im Text', async (t) => {
  const clay = await startFakeClay({ token: 'richtig' });
  t.after(() => clay.close());
  const server = app({ LEAD_SEARCH_MODE: 'live', ENRICHMENT_PROVIDER: 'clay', CLAY_WEBHOOK_URL: `${clay.baseUrl}/webhook`, CLAY_WEBHOOK_TOKEN: 'falsch', CLAY_CALLBACK_SECRET: SECRET });
  const lead = await createLead(server);
  const { lead: after } = (await enrich(server, lead.id)).json() as LeadDetailResponse;
  assert.equal(after.enrichment?.status, 'failed');
  assert.equal(after.enrichment?.error, 'Clay lehnt den Zugang ab (HTTP 401) – CLAY_WEBHOOK_TOKEN prüfen.');
  assert.doesNotMatch(JSON.stringify(after), /falsch/);
});

test('Rückkanal ohne Sitzung erreichbar, alles andere nicht; 10 falsche Schlüssel → 429', async (t) => {
  assert.ok(AUTH_OPEN_ROUTES.includes('/api/enrichment/clay'));
  const clay = await startFakeClay();
  t.after(() => clay.close());
  const server = app({ LEAD_SEARCH_MODE: 'live', ENRICHMENT_PROVIDER: 'clay', CLAY_WEBHOOK_URL: `${clay.baseUrl}/webhook`, CLAY_CALLBACK_SECRET: SECRET }, true);
  assert.equal((await get(server, '/api/enrichment/status')).error.code, 'unauthorized');
  assert.equal((await enrich(server, 'x')).statusCode, 401);
  assert.equal((await callback(server, { leadId: 'unbekannt', employees: 3 })).statusCode, 404, 'mit Schlüssel bis zur Route');
  for (let i = 0; i < 10; i++) assert.equal((await callback(server, { leadId: 'x' }, 'falsch')).statusCode, 401);
  const blocked = await callback(server, { leadId: 'x' });
  assert.equal(blocked.statusCode, 429, 'während der Sperre auch mit richtigem Schlüssel');
});

// ── Treg (Standard-Quelle seit 05.10.) ─────────────────────────────────────

// Form der echten Treg-Antwort (exporo.de, 05.10.2026): output vereinheitlicht, raw je Anbieter.
const COMPANY = {
  output: {
    name: 'Muster Wohnbau',
    domain: 'muster-wohnbau.de',
    industry: 'real-estate',
    employees: '11-50',
    founded: 2012,
    location: 'Köln Germany',
    linkedin_url: 'https://www.linkedin.com/company/123456',
  },
  raw: {
    technologies: [{ name: 'WordPress' }, { name: 'Facebook Pixel' }, 'Google Tag Manager'],
    socials: { instagram: 'instagram.com/musterwohnbau', crunchbase: 'https://crunchbase.com/x', note: 'kein Link' },
  },
};

test('Treg: Firmendaten sofort, nur die Domain geht hinaus, Kostendeckel, Score neu', async (t) => {
  const treg = await startFakeTreg({ companies: { 'muster-wohnbau.de': COMPANY } });
  t.after(() => treg.close());
  const server = app({ LEAD_SEARCH_MODE: 'live', TREG_TOKEN: 'treg-test-token', TREG_BASE_URL: treg.baseUrl });
  assert.deepEqual(await get(server, '/api/enrichment/status'), { mode: 'live', provider: 'treg', autoEnrich: false, dailyLimit: 50, usedToday: 0 });
  const lead = await createLead(server);

  const response = await enrich(server, lead.id);
  assert.equal(response.statusCode, 202, response.body);
  const { lead: after, events } = response.json() as LeadDetailResponse;
  assert.equal(after.enrichment?.status, 'done');
  assert.equal(after.enrichment?.source, 'treg');
  assert.equal(after.enrichment?.employees, 31);
  assert.equal(after.enrichment?.employeesRange, '11–50');
  assert.deepEqual(after.enrichment?.techStack, ['WordPress', 'Facebook Pixel', 'Google Tag Manager']);
  assert.equal(after.enrichment?.metaPixel, true);
  assert.equal(after.enrichment?.googleTagManager, true);
  assert.equal(after.enrichment?.socials.linkedin, 'https://www.linkedin.com/company/123456');
  assert.equal(after.enrichment?.socials.instagram, 'https://instagram.com/musterwohnbau');
  assert.equal(after.enrichment?.socials.facebook, null);
  assert.equal(after.score!.icp.components.find((component) => component.key === 'company_size')!.value, 1);
  assert.equal(events.at(-1)!.title, 'Firmendaten ergänzt (Treg): 11–50 Mitarbeiter · Meta-Pixel · 2 Social-Profile');

  assert.equal(treg.requests.length, 1);
  const request = treg.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/call/treg.companies.enrich');
  assert.equal(request.headers['x-treg-token'], 'treg-test-token');
  assert.equal(request.headers['x-treg-route-max-cost'], '0.05', 'Kostendeckel je Abruf (Treg-Standard wäre 1 $)');
  assert.deepEqual(request.body, { domain: 'muster-wohnbau.de' }, 'keine Namen, keine LinkedIn-Daten');
  assert.equal(((await get(server, '/api/enrichment/status')) as EnrichmentStatusResponse).usedToday, 1);
  assert.equal((await callback(server, { leadId: lead.id, employees: 3 })).statusCode, 404, 'Clay-Rückkanal bei Treg aus');
});

test('Treg: ohne Daten aus raw (nur output) → Tech-Stack unbekannt, Score ohne Meta-Pixel', async (t) => {
  const treg = await startFakeTreg({ companies: { 'muster-wohnbau.de': { output: { name: 'Muster', employees: '501-1k' } } } });
  t.after(() => treg.close());
  const server = app({ LEAD_SEARCH_MODE: 'live', TREG_TOKEN: 'treg-test-token', TREG_BASE_URL: treg.baseUrl, TREG_MAX_COST_USD: '0.01' });
  const lead = await createLead(server);
  const { lead: after } = (await enrich(server, lead.id)).json() as LeadDetailResponse;
  assert.equal(after.enrichment?.employees, 751);
  assert.equal(after.enrichment?.employeesRange, '501–1000');
  assert.equal(after.enrichment?.metaPixel, null);
  assert.deepEqual(after.enrichment?.techStack, []);
  assert.equal(treg.requests[0].headers['x-treg-route-max-cost'], '0.01');
});

test('Treg: ohne Website kein Abruf; unbekannte Firma; ohne Token aus', async (t) => {
  const treg = await startFakeTreg({ companies: {} });
  t.after(() => treg.close());
  const server = app({ LEAD_SEARCH_MODE: 'live', TREG_TOKEN: 'treg-test-token', TREG_BASE_URL: treg.baseUrl });
  const noSite = await createLead(server, { providerId: 'ACoOHNE', website: null });
  const { lead } = (await enrich(server, noSite.id)).json() as LeadDetailResponse;
  assert.equal(lead.enrichment?.status, 'failed');
  assert.match(lead.enrichment!.error!, /Keine Website bekannt/);
  assert.equal(treg.requests.length, 0);
  assert.equal(((await get(server, '/api/enrichment/status')) as EnrichmentStatusResponse).usedToday, 0, 'zählt nicht');

  const unknown = await createLead(server, { providerId: 'ACoUNBEKANNT', website: 'https://unbekannt.example' });
  const failed = ((await enrich(server, unknown.id)).json() as LeadDetailResponse).lead;
  assert.equal(failed.enrichment?.status, 'failed');
  assert.equal(failed.enrichment?.error, 'Keine Firmendaten zu unbekannt.example gefunden (kein Anbieter kennt die Firma).');

  const off = app({ LEAD_SEARCH_MODE: 'live' });
  const offLead = await createLead(off);
  const response = await enrich(off, offLead.id);
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error.message, /Einstellungen → Firmendaten/);
});

test('Treg: Guthaben leer → verständliche Meldung, automatische Anreicherung bricht ab, Token nie im Text', async (t) => {
  const treg = await startFakeTreg({ status: 402 });
  t.after(() => treg.close());
  const server = app({ LEAD_SEARCH_MODE: 'live', TREG_TOKEN: 'treg-test-token', TREG_BASE_URL: treg.baseUrl, ENRICH_AUTO: 'true' });
  const response = await server.inject({
    method: 'POST',
    url: '/api/leads',
    payload: { owner: 'nick', cards: [card(), card({ providerId: 'ACoZWEI', website: 'https://zwei.example' })] },
  });
  const { created } = response.json() as CreateLeadsResponse;
  assert.equal(created[0].enrichment?.error, 'Treg-Guthaben aufgebraucht – auf treg.to aufladen.');
  assert.equal(created[1].enrichment ?? null, null, 'zweiter Lead nicht mehr versucht');
  assert.equal(treg.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(created), /treg-test-token/);
});

test('Treg: echte Antworten vom 05.10.2026 (exporo.de, zinsland.de) werden gelesen', () => {
  const exporo = parseTregCompany(
    { name: 'Exporo', domain: 'exporo.de', industry: 'investment-banking', employees: '10-50', founded: 2012, location: 'Hanover Germany', linkedin_url: 'https://www.linkedin.com/company/5357250' },
    {},
  );
  assert.equal(exporo.usable, true);
  assert.deepEqual([exporo.values.employees, exporo.values.employeesRange], [30, '10–50']);
  assert.equal(exporo.values.socials.linkedin, 'https://www.linkedin.com/company/5357250');
  assert.equal(exporo.values.metaPixel, null, 'kein Tech-Stack geliefert → unbekannt, nicht „nein“');
  const zinsland = parseTregCompany({ name: 'Zinsland', employees: '1-10', description: 'siehe [www.zinsland.de](https://www.zinsland.de)' }, {});
  assert.deepEqual([zinsland.values.employees, zinsland.values.employeesRange], [6, '1–10']);
  assert.equal(parseTregCompany({ name: null, domain: 'x.de' }, {}).usable, false, 'Fehlschlag = name null');
});
