import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, type EnrichedProfile, type RunSnapshot, type SearchHit } from '../../shared/leadSearch.js';
import { AUTO_QUALIFY_DEFAULT_TERMS } from '../../shared/settings.js';
import { createLiveAdapter } from '../src/adapters/live/liveAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { quickQualify } from '../src/qualify/keywords.js';
import { startBody, tempDataDir, waitForEnd } from './helpers.js';
import { startFakeAnthropic, startFakeMeta, startFakeUnipile } from './fakeServers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

const hit = (headline: string): SearchHit => ({
  providerId: 'ACoX',
  publicIdentifier: 'x',
  firstName: 'Christian',
  lastName: 'Wilhelm',
  headline,
  location: 'Achern',
  networkDistance: 2,
  profileUrl: null,
});
const profile = (headline: string, position: string | null, companyName: string | null): EnrichedProfile =>
  ({ headline, position, companyName, companyIndustry: null, companyDescription: null, companyWebsite: null, location: 'Achern' }) as EnrichedProfile;
const terms = [...AUTO_QUALIFY_DEFAULT_TERMS];

test('ohne KI qualifiziert: Stichwort + Entscheider, Kategorie aus dem Stichwort', () => {
  const builder = quickQualify(hit('Projektentwicklung und eigener Vertrieb'), profile('Projektentwicklung und eigener Vertrieb', 'Geschäftsführer', 'Wilhelm Immobilien GmbH'), terms);
  assert.equal(builder?.qualified, true);
  assert.equal(builder?.category, 'bautraeger_projektentwickler');
  assert.match(builder?.reason ?? '', /„Projektentwicklung“ in der Headline und Rolle „Geschäftsführer“/);
  // Seit 27.10.: Bauträger ohne Hinweis auf eigenen Vertrieb stuft die KI ein (sie sieht die Firmenbeschreibung).
  assert.equal(quickQualify(hit('Projektentwicklung ist meine Leidenschaft'), profile('Projektentwicklung ist meine Leidenschaft', 'Geschäftsführer', 'Wilhelm Immobilien GmbH'), terms), null);
  const investment = quickQualify(hit('Inhaber'), profile('Inhaber', 'Inhaber', 'Kapitalanlageimmobilien Süd GmbH'), terms);
  assert.equal(investment?.category, 'kapitalanlage_vertrieb');
});

test('ohne KI nicht: kein Entscheider, Gegenbeleg, kein Stichwort, ausgeschaltet', () => {
  assert.equal(quickQualify(hit('Projektentwicklung'), profile('Projektentwicklung', 'Projektleiter', 'X GmbH'), terms), null);
  assert.equal(quickQualify(hit('GF'), profile('Geschäftsführer · Versicherungsmakler', 'Geschäftsführer', 'Projektentwicklung & Versicherung GmbH'), terms), null);
  assert.equal(quickQualify(hit('GF'), profile('Geschäftsführer', 'Geschäftsführer', 'Software GmbH'), terms), null);
  assert.equal(quickQualify(hit('GF'), profile('Projektentwicklung', 'Geschäftsführer', 'X'), []), null);
});

test('Einstellung: Standardliste, eigene Liste, „off“', () => {
  const dir = tempDataDir();
  assert.deepEqual(loadConfig({ DATA_DIR: dir }).autoQualifyTerms, terms);
  assert.deepEqual(loadConfig({ DATA_DIR: dir, AUTO_QUALIFY_TERMS: ' Bauträger, Wohnbau ,Bauträger' }).autoQualifyTerms, ['Bauträger', 'Wohnbau']);
  assert.deepEqual(loadConfig({ DATA_DIR: dir, AUTO_QUALIFY_TERMS: 'off' }).autoQualifyTerms, []);
});

test('Live: Treffer mit Stichwort brauchen keinen KI-Aufruf – weniger Kosten, gleiche Übergabe', async () => {
  const unipile = await startFakeUnipile();
  const anthropic = await startFakeAnthropic();
  const meta = await startFakeMeta();
  servers.push(unipile, anthropic, meta);
  const run = async (env: NodeJS.ProcessEnv) => {
    const config = loadConfig({
      LEAD_SEARCH_MODE: 'live',
      UNIPILE_DSN: unipile.baseUrl,
      UNIPILE_API_KEY: 'unipile-test-key',
      ANTHROPIC_API_KEY: 'anthropic-test-key',
      META_ACCESS_TOKEN: 'meta-test-key',
      DATA_DIR: tempDataDir(),
      ...env,
    });
    const adapter = createLiveAdapter(config, { pause: async () => {}, anthropicBaseURL: anthropic.baseUrl, metaBaseURL: meta.baseUrl });
    const app = buildApp({ config, adapter, logger: false, requireSession: false });
    const before = anthropic.requests.length;
    const response = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody({ known: [], profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 15 } }) });
    const result = await waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id, 15_000);
    await app.close();
    return { result, calls: anthropic.requests.length - before };
  };
  // Fake-Firmen „Kapital Invest n GmbH“ (jede dritte): mit diesem Stichwort ohne KI. (Bauträger-Stichwörter brauchen
  // seit 27.10. einen Hinweis auf eigenen Vertrieb – die Fake-Firmen „Bau Projekt n“ haben keinen.)
  const plain = await run({ AUTO_QUALIFY_TERMS: 'off' });
  const quick = await run({ AUTO_QUALIFY_TERMS: 'Kapital Invest' });
  assert.equal(plain.result.status, 'done');
  assert.equal(quick.result.status, 'done');
  assert.ok(quick.calls < plain.calls, `${quick.calls} < ${plain.calls}`);
  const auto = quick.result.leads.filter((lead) => lead.qualification?.reason.includes('ohne KI eingestuft'));
  assert.ok(auto.length > 0);
  assert.ok(auto.every((lead) => lead.qualification?.category === 'kapitalanlage_vertrieb'));
  assert.ok(auto.every((lead) => lead.status === 'qualified' || lead.status === 'ads_active'), 'Meta-Ads trotzdem geprüft');
});
