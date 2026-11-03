import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetaAdsCheck } from '../../shared/leadSearch.js';
import type { CockpitLead } from '../../shared/leads.js';
import type { MetaRecheckStatus } from '../../shared/metaRecheck.js';
import { MetaAdLibraryClient, MetaAdsChecker } from '../src/adapters/live/metaAdLibrary.js';
import { mergeAdsChecks, personSearchTerm, samePerson, uncheckedAds, type ArchivedAd } from '../src/ads/metaAds.js';
import { MetaRecheckService } from '../src/ads/metaRecheck.js';
import { AdapterError } from '../src/pipeline/adapter.js';
import { mockApp } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };
const today = new Date('2026-10-15T09:00:00Z');

test('Person: Suchbegriff ohne Titel, Seite muss Vor- und Nachname enthalten', () => {
  assert.equal(personSearchTerm({ firstName: 'Dr. Max', lastName: 'Mustermann' }), 'Max Mustermann');
  assert.equal(personSearchTerm({ firstName: 'Max', lastName: '' }), '');
  assert.ok(samePerson('Max Mustermann', { firstName: 'Max', lastName: 'Mustermann' }));
  assert.ok(samePerson('Max Mustermann Immobilien', { firstName: 'Max', lastName: 'Mustermann' }));
  assert.ok(samePerson('Jörg Müller', { firstName: 'Joerg', lastName: 'Müller' }), 'Umlaute wie ausgeschrieben');
  assert.ok(!samePerson('Mustermann Wohnbau', { firstName: 'Max', lastName: 'Mustermann' }), 'Nachname allein reicht nicht');
  assert.ok(!samePerson('Maxi Mustermann', { firstName: 'Max', lastName: 'Mustermann' }));
});

test('Zusammenführen: stärkeres Ergebnis gewinnt, bei Gleichstand die Firma', () => {
  const base = uncheckedAds('x', 'Muster GmbH');
  const none: MetaAdsCheck = { ...base, state: 'none', note: null };
  const stopped: MetaAdsCheck = { ...base, state: 'stopped', ads: 2, lastStop: '2026-05-01', note: null };
  const active: MetaAdsCheck = { ...base, state: 'active', ads: 1, activeAds: 1, advertiser: 'Max Mustermann', note: null };
  assert.equal(mergeAdsChecks(none, active).source, 'person');
  assert.match(mergeAdsChecks(none, active).note ?? '', /privaten Namen/);
  assert.equal(mergeAdsChecks(stopped, active).state, 'active');
  assert.equal(mergeAdsChecks(stopped, { ...stopped }).source, 'company');
  assert.equal(mergeAdsChecks(none, null).source, undefined, 'ohne eigene Anzeigen keine Quelle');
  assert.equal(mergeAdsChecks(base, active).state, 'active', 'auch ohne Firma im Profil');
});

/** Fake der Werbebibliothek: Anzeigen je Suchbegriff. */
function fakeMeta(byTerm: Record<string, ArchivedAd[]>) {
  const terms: string[] = [];
  const fetchFake = (async (input: URL | string) => {
    const url = new URL(String(input));
    const term = url.searchParams.get('search_terms') ?? '';
    terms.push(term);
    return new Response(JSON.stringify({ data: byTerm[term] ?? [] }), { status: 200 });
  }) as typeof fetch;
  const client = new MetaAdLibraryClient({ accessToken: 'geheim', fetch: fetchFake });
  return { checker: new MetaAdsChecker(client, () => today), terms };
}

test('Live-Check: Firma ohne Anzeigen, Person wirbt über den privaten Namen', async () => {
  const { checker, terms } = fakeMeta({
    'Max Mustermann': [
      { id: '1', page_id: '77', page_name: 'Max Mustermann', ad_delivery_start_time: '2026-09-01' },
      { id: '2', page_id: '78', page_name: 'Erika Mustermann', ad_delivery_start_time: '2026-09-01' },
    ],
  });
  const profile = { headline: '', position: null, companyName: 'Muster Wohnbau GmbH', companyDescription: null, companyWebsite: null, companyIndustry: null, location: null };
  const result = await checker.check(profile, AbortSignal.timeout(5_000), { firstName: 'Max', lastName: 'Mustermann' });
  assert.equal(result.state, 'active');
  assert.equal(result.source, 'person');
  assert.equal(result.activeAds, 1, 'fremde Seite mit gleichem Nachnamen zählt nicht');
  assert.equal(result.foreignAds, 1);
  assert.equal(result.checkedAt, today.getTime());
  assert.deepEqual(terms, ['Muster Wohnbau', 'Max Mustermann']);
});

test('Live-Check: Firma schaltet gerade – keine zusätzliche Abfrage zur Person', async () => {
  const { checker, terms } = fakeMeta({
    'Muster Wohnbau': [{ id: '1', page_id: '5', page_name: 'Muster Wohnbau', ad_delivery_start_time: '2026-09-01' }],
  });
  const profile = { headline: '', position: null, companyName: 'Muster Wohnbau GmbH', companyDescription: null, companyWebsite: null, companyIndustry: null, location: null };
  const result = await checker.check(profile, AbortSignal.timeout(5_000), { firstName: 'Max', lastName: 'Mustermann' });
  assert.equal(result.state, 'active');
  assert.equal(result.source, 'company');
  assert.deepEqual(terms, ['Muster Wohnbau']);
});

test('Nachprüfung über die API: alle Leads außer verlorenen und von Hand eingetragenen', async () => {
  const app = mockApp();
  await app.ready();
  try {
    const list = (await app.inject({ method: 'GET', url: '/api/leads?limit=500' })).json() as { leads: CockpitLead[] };
    assert.ok(list.leads.length > 0, 'Simulation hat Demo-Leads');
    const manual = list.leads.find((lead) => lead.stage !== 'lost')!;
    const patched = await app.inject({ method: 'PATCH', url: `/api/leads/${manual.id}`, payload: { metaAds: { state: 'active' } } });
    assert.equal(patched.statusCode, 200);

    const idle = (await app.inject({ method: 'GET', url: '/api/settings/meta-recheck' })).json() as MetaRecheckStatus;
    assert.equal(idle.state, 'idle');

    const started = await app.inject({ method: 'POST', url: '/api/settings/meta-recheck' });
    assert.equal(started.statusCode, 202);
    await app.metaRecheck.idle();

    const status = (await app.inject({ method: 'GET', url: '/api/settings/meta-recheck' })).json() as MetaRecheckStatus;
    const open = list.leads.filter((lead) => lead.stage !== 'lost');
    assert.equal(status.state, 'done');
    assert.equal(status.total, open.length - 1);
    assert.equal(status.checked, status.total);
    assert.equal(status.active + status.stopped + status.none + status.unchecked, status.checked);

    const after = (await app.inject({ method: 'GET', url: `/api/leads/${manual.id}` })).json() as { lead: CockpitLead };
    assert.equal(after.lead.metaAds?.manual, true, 'von Hand eingetragen bleibt');
  } finally {
    await app.close();
  }
});

/** Service mit festen Leads und einem Adapter, der das erste Mal ein Meta-Limit meldet. */
function lead(id: string, metaAds: MetaAdsCheck | null = null): CockpitLead {
  return {
    id,
    person: { firstName: 'Max', lastName: id, headline: '', position: '', location: null, providerId: id, publicIdentifier: null, profileUrl: null, networkDistance: null },
    company: { name: `Firma ${id}`, website: null, industry: null, region: null },
    metaAds,
  } as unknown as CockpitLead;
}

test('Meta-Limit: wartet, macht mit demselben Lead weiter; Token-Fehler beendet', async () => {
  const leads = new Map([
    ['a', lead('a')],
    ['b', lead('b')],
  ]);
  const saved: string[] = [];
  let calls = 0;
  const store = {
    metaRecheckIds: () => [...leads.keys()],
    get: (id: string) => leads.get(id) ?? null,
    setCheckedMetaAds: (id: string, check: MetaAdsCheck) => {
      saved.push(`${id}:${check.state}`);
      return leads.get(id)!;
    },
  };
  const none: MetaAdsCheck = { ...uncheckedAds('x', null), state: 'none', note: null };
  const service = new MetaRecheckService({
    leads: store,
    adapter: {
      canCheckAds: true,
      checkMetaAds: async () => {
        calls++;
        if (calls === 1) throw new AdapterError('rate_limit', 'Meta-Limit erreicht', 'zu viele', true);
        return none;
      },
    },
    log: silent,
    pauseMs: 0,
    limitWaitMs: 20,
  });
  service.start();
  assert.throws(() => service.start(), /läuft schon/);
  await service.idle();
  assert.deepEqual(saved, ['a:none', 'b:none']);
  assert.equal(calls, 3);
  assert.equal(service.status().state, 'done');

  const failing = new MetaRecheckService({
    leads: store,
    adapter: {
      canCheckAds: true,
      checkMetaAds: async () => {
        throw new AdapterError('auth', 'Meta-Token ungültig oder abgelaufen', 'Token abgelehnt', true);
      },
    },
    log: silent,
    pauseMs: 0,
  });
  failing.start();
  await failing.idle();
  assert.equal(failing.status().state, 'failed');
  assert.match(failing.status().message ?? '', /Meta-Token ungültig/);

  const off = new MetaRecheckService({ leads: store, adapter: { canCheckAds: false, checkMetaAds: async () => none }, log: silent });
  assert.throws(() => off.start(), /Meta-Token/);
});
