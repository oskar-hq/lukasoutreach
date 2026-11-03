import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetaAdsCheck, NewLeadCard, RunSnapshot } from '../../shared/leadSearch.js';
import type { CreateLeadsResponse, LeadListResponse } from '../../shared/leads.js';
import { ICP_WEIGHTS, scoreLead, type ScoreInput } from '../src/scoring/score.js';
import { mockApp, startBody, waitForEnd } from './helpers.js';

const NOW = Date.UTC(2026, 9, 3, 12);

function ads(overrides: Partial<MetaAdsCheck>): MetaAdsCheck {
  return { state: 'none', advertiser: null, ads: 0, activeAds: 0, lastStop: null, foreignAds: 0, libraryUrl: null, note: null, ...overrides };
}

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    category: 'kapitalanlage_vertrieb',
    confidence: 0.92,
    qualified: true,
    position: 'Geschäftsführer',
    headline: 'Geschäftsführer · Muster Kapitalanlagen GmbH',
    location: 'Hamburg, Deutschland',
    website: 'https://www.muster-kapital.de/',
    metaAds: ads({ state: 'none' }),
    ...overrides,
  };
}

test('Gewichte des ICP-Scores summieren auf 1', () => {
  const sum = Object.values(ICP_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 1000) / 1000, 1);
});

test('Greenfield: GF eines Kapitalanlage-Vertriebs in Deutschland, keine Meta-Ads → hoch', () => {
  const score = scoreLead(input(), NOW);
  assert.equal(score.leadType, 'greenfield');
  assert.equal(score.ads.status, 'none_found');
  assert.equal(score.ads.confidence, 0.7);
  assert.equal(score.tier, 'high');
  assert.equal(score.icp.tier, 'high');
  // Größe unbekannt → zählt nicht mit, Score wird nicht schlechter, aber Vollständigkeit sinkt
  assert.equal(score.icp.components.find((c) => c.key === 'company_size')?.value, null);
  assert.equal(score.completeness, 0.85);
  // ICP = (0,35·0,92 + 0,25·1 + 0,15·1 + 0,1·1) / 0,85
  assert.equal(score.icp.score, Math.round(((0.35 * 0.92 + 0.25 + 0.15 + 0.1) / 0.85) * 100) / 100);
  assert.equal(score.total, Math.round((0.7 * ((0.35 * 0.92 + 0.5) / 0.85) + 0.3 * 0.8) * 100) / 100);
  assert.ok(score.hardFilters.every((filter) => filter.passed === true));
  assert.match(score.icp.components[4].detail, /muster-kapital\.de/);
});

test('Lead-Typen aus der Meta-Werbebibliothek', () => {
  const reactivation = scoreLead(input({ metaAds: ads({ state: 'stopped', ads: 4, lastStop: '2026-06-01' }) }), NOW);
  assert.equal(reactivation.leadType, 'reactivation');
  assert.equal(reactivation.ads.opportunity, 0.9, 'vor weniger als einem Jahr beendet');
  const old = scoreLead(input({ metaAds: ads({ state: 'stopped', ads: 2, lastStop: '2024-01-10' }) }), NOW);
  assert.equal(old.ads.opportunity, 0.8);

  const active = scoreLead(input({ metaAds: ads({ state: 'active', ads: 5, activeAds: 3 }) }), NOW);
  assert.equal(active.leadType, 'active');
  // Seit 07.10. kein Ausschluss: aktive Kampagnen sind eine Chance (von Hand prüfen), aber kleiner als Greenfield.
  assert.equal(active.ads.opportunity, 0.6);
  assert.ok(active.total < reactivation.total);

  const unchecked = scoreLead(input({ metaAds: ads({ state: 'unchecked', note: 'META_ACCESS_TOKEN fehlt' }) }), NOW);
  assert.equal(unchecked.leadType, 'unclear');
  assert.equal(unchecked.ads.detail, 'META_ACCESS_TOKEN fehlt');

  const unsure = scoreLead(input({ website: null, metaAds: ads({ state: 'none', foreignAds: 3 }) }), NOW);
  assert.equal(unsure.ads.confidence, 0.45, 'ohne Website und mit Fremdtreffern unsicher');
  assert.equal(unsure.leadType, 'unclear');
});

test('Entscheider, Region und Branche abgestuft', () => {
  const sales = scoreLead(input({ position: 'Head of Sales', headline: 'Head of Sales · Muster' }), NOW);
  assert.equal(sales.icp.components[1].value, 0.6);
  assert.equal(sales.hardFilters.find((f) => f.key === 'decision_maker')?.passed, false);

  const vienna = scoreLead(input({ location: 'Wien, Österreich' }), NOW);
  assert.equal(vienna.icp.components[3].value, 0.5);
  assert.equal(vienna.hardFilters.find((f) => f.key === 'region')?.passed, false);
  const unknown = scoreLead(input({ location: null }), NOW);
  assert.equal(unknown.icp.components[3].value, null);
  assert.equal(unknown.hardFilters.find((f) => f.key === 'region')?.passed, null, 'nicht prüfbar → Review statt aussortieren');

  const makler = scoreLead(input({ category: 'makler', qualified: false }), NOW);
  assert.equal(makler.icp.components[0].value, 0.3);
  assert.equal(makler.hardFilters[0].passed, false);
  assert.ok(makler.total < 0.75);
});

test('Firmengröße zählt mit, sobald bekannt', () => {
  const small = scoreLead(input({ employees: 1 }), NOW);
  const fit = scoreLead(input({ employees: 25 }), NOW);
  assert.equal(small.completeness, 1);
  assert.equal(small.icp.components[2].value, 0.4);
  assert.equal(fit.icp.components[2].value, 1);
  assert.ok(fit.icp.score > small.icp.score);
});

test('Lead-Suche: bewertete Leads bekommen einen Score, die Übergabe trägt ihn in die Datenbank', async () => {
  const app = mockApp();
  const started = (await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() })).json() as { run: RunSnapshot };
  const run = await waitForEnd(app, started.run.id);
  const assessed = run.leads.filter((lead) => lead.qualification);
  assert.ok(assessed.length > 0);
  assert.ok(assessed.every((lead) => lead.score?.version === 'v1'));
  assert.ok(run.leads.filter((lead) => !lead.qualification).every((lead) => !lead.score));
  assert.ok(run.leads.filter((lead) => lead.status === 'ads_active').every((lead) => lead.score?.leadType === 'active'));

  const handoff = (await app.inject({ method: 'POST', url: `/api/lead-search/runs/${run.id}/handoff` })).json() as { leads: NewLeadCard[] };
  assert.equal(handoff.leads.length, 7);
  assert.ok(handoff.leads.every((card) => card.score && ['greenfield', 'reactivation', 'unclear', 'active'].includes(card.score.leadType)));

  const created = (await app.inject({ method: 'POST', url: '/api/leads', payload: { cards: handoff.leads, owner: 'nick' } })).json() as CreateLeadsResponse;
  assert.equal(created.created.length, 7);
  // Das Backend rechnet beim Speichern selbst nach – gleiches Ergebnis wie in der Lead-Suche
  const { scoredAt: _a, ...stored } = created.created[0].score!;
  const { scoredAt: _b, ...fromRun } = handoff.leads[0].score!;
  assert.deepEqual(stored, fromRun);

  // Demo-Leads haben ebenfalls einen Score; sortiert nach Score: höchster zuerst
  const sorted = (await app.inject({ method: 'GET', url: '/api/leads?sort=score' })).json() as LeadListResponse;
  assert.equal(sorted.total, 37);
  const totals = sorted.leads.map((lead) => lead.score?.total ?? -1);
  assert.ok(totals.every((value) => value >= 0), 'alle Leads bewertet');
  for (let i = 1; i < totals.length; i++) assert.ok(totals[i - 1] >= totals[i]);
});

test('ältere Leads ohne Score werden beim Start nachgerechnet', async () => {
  const { tempDataDir } = await import('./helpers.js');
  const { openDatabase } = await import('../src/db/database.js');
  const dir = tempDataDir();
  const first = mockApp(undefined, { DATA_DIR: dir });
  await first.ready();
  await first.close();
  const db = openDatabase(dir);
  db.exec('UPDATE leads SET score = NULL, score_total = NULL');
  db.close();

  const second = mockApp(undefined, { DATA_DIR: dir });
  const list = (await second.inject({ method: 'GET', url: '/api/leads' })).json() as LeadListResponse;
  assert.ok(list.leads.every((lead) => lead.score?.version === 'v1'));
});
