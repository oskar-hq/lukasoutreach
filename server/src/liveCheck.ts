/**
 * Verbindungstest für den Live-Modus – zeigt, was Unipile, Anthropic und die Meta-Werbebibliothek wirklich liefern.
 * Nur lesend und sparsam: Account-Liste, Region, je eine Suche (5 Treffer), 1 Profil, 1 Firma,
 * offene Einladungen, Kontakte der Gründer-Accounts (höchstens 3 Seiten je Account), 1 KI-Bewertung, Meta-Ads der gefundenen Firma. Keine Vernetzungsanfragen, keine Nachrichten.
 *
 * Im Container:  docker compose exec backend node dist/server/src/liveCheck.js
 * Nur Meta-Ads bestimmter Firmen prüfen (ohne LinkedIn):
 *                docker compose exec backend node dist/server/src/liveCheck.js --meta "Firma A GmbH" "Firma B"
 * Lokal:         npm run check --prefix server
 */
import { AUTH_FOUNDER_IDS, defaultFounderName } from '../../shared/auth.js';
import { DEFAULT_SEARCH_PROFILE, type SearchHit } from '../../shared/leadSearch.js';
import { AnthropicQualifier } from './adapters/live/anthropicQualifier.js';
import {
  accountWarnings,
  buildClassicSearchBody,
  collectIds,
  buildSearchBody,
  describeAccount,
  orJoin,
  pickLinkedinAccount,
  searchCombinations,
  toSearchHit,
} from './adapters/live/liveAdapter.js';
import { MetaAdLibraryClient, MetaAdsChecker } from './adapters/live/metaAdLibrary.js';
import { UNIPILE_SESSION_DOWN_TEXT, UnipileClient, UnipileHttpError, isUnipileSessionDown, type UnipilePeopleResult } from './adapters/live/unipileClient.js';
import { companySearchTerm } from './ads/metaAds.js';
import { loadConfigWithSettings } from './settings/effective.js';
import { parseQualification } from './qualify/schema.js';

const config = loadConfigWithSettings();
const signal = AbortSignal.timeout(180_000);
let failures = 0;
/** Firma aus Schritt 5/6 – wird in Schritt 8 in der Meta-Werbebibliothek gesucht. */
let foundCompany: { name: string; website: string | null } | null = null;
const metaArg = process.argv.indexOf('--meta');
const metaOnly = metaArg === -1 ? null : process.argv.slice(metaArg + 1).map((name) => name.trim()).filter(Boolean);

const line = (text = '') => console.log(text);
const ok = (text: string) => line(`  ✓ ${text}`);
const info = (text: string) => line(`    ${text}`);
const fail = (text: string, error: unknown) => {
  failures++;
  const detail =
    error instanceof UnipileHttpError
      ? `HTTP ${error.status}${error.type ? ` (${error.type})` : ''}${error.detail ? ` – ${error.detail}` : ''}`
      : error instanceof Error
        ? error.message
        : String(error);
  line(`  ✗ ${text}: ${detail}`);
  if (isUnipileSessionDown(error)) info(`→ ${UNIPILE_SESSION_DOWN_TEXT}`);
  else if (error instanceof UnipileHttpError && error.status >= 500) info('→ Serverfehler bei Unipile (nicht LinkedIn) – Unipile-Dashboard/Status prüfen und später erneut versuchen.');
};

/** Rohdaten gekürzt ausgeben – zeigt die echten Feldnamen, ohne die Konsole zu fluten. */
function shorten(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 100 ? `${value.slice(0, 100)}…` : value;
  if (Array.isArray(value)) return depth > 2 ? `[${value.length} Einträge]` : value.slice(0, 2).map((entry) => shorten(entry, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 3) return '{…}';
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry, depth + 1)]));
  }
  return value;
}
const raw = (label: string, value: unknown) => {
  line(`    ${label}:`);
  for (const row of JSON.stringify(shorten(value), null, 2).split('\n')) line(`      ${row}`);
};

async function main() {
  line('Lead-Suche – Verbindungstest (nur lesend)');
  line(`  Modus: ${config.mode} · Unipile: ${config.unipile.dsn ?? '–'} · Key: ${config.unipile.apiKey ? `…${config.unipile.apiKey.slice(-4)}` : 'fehlt'}`);
  line(`  Suche: ${config.unipile.searchApi} · Anthropic: ${config.anthropic.apiKey ? config.anthropic.model : 'kein Key'}`);
  line(`  Meta-Werbebibliothek: ${config.meta.accessToken ? `${config.meta.graphVersion} · Token …${config.meta.accessToken.slice(-4)}` : 'kein Token'}`);
  if (!config.unipile.dsn || !config.unipile.apiKey) {
    failures++;
    line('\n  ✗ UNIPILE_DSN und UNIPILE_API_KEY müssen in der .env stehen.');
    return;
  }
  const unipile = new UnipileClient({ dsn: config.unipile.dsn, apiKey: config.unipile.apiKey });

  // 1. Account
  line('\n1) LinkedIn-Account bei Unipile');
  let accountId = config.unipile.accountId;
  let premium: string[] = [];
  try {
    const { items } = await unipile.listAccounts(signal);
    for (const account of items ?? []) {
      const features = account.connection_params?.im?.premiumFeatures ?? [];
      info(`${account.type ?? '?'} · ${account.name ?? '–'} · id ${account.id} · Status ${(account.sources ?? []).map((s) => s.status).join(', ') || '–'}${features.length ? ` · Premium: ${features.join(', ')}` : ''}`);
    }
    const status = describeAccount(items ?? [], accountId, config.unipile.searchApi);
    const picked = pickLinkedinAccount(items ?? [], accountId, config.unipile.searchApi);
    for (const warning of accountWarnings(items ?? [], accountId, config.unipile.searchApi)) info(`⚠ ${warning}`);
    if (status.state === 'ok' && picked) {
      accountId = picked.id;
      premium = picked.connection_params?.im?.premiumFeatures ?? [];
      ok(`verwende ${picked.name ?? picked.id} (${picked.id})`);
    } else {
      fail('kein startklarer LinkedIn-Account', new Error(status.message));
      return;
    }
  } catch (error) {
    fail('Account-Liste', error);
    return;
  }

  // 2. Region
  line(`\n2) Region „${DEFAULT_SEARCH_PROFILE.region}“`);
  const regionIds: Record<string, string> = {};
  for (const type of ['LOCATION', 'REGION'] as const) {
    try {
      const { items } = await unipile.searchParameters({ accountId, type, keywords: DEFAULT_SEARCH_PROFILE.region, limit: 3 }, signal);
      if (items?.[0]) regionIds[type] = items[0].id;
      ok(`${type}: ${(items ?? []).map((item) => `${item.title} (${item.id})`).join(' · ') || 'nichts gefunden'}`);
    } catch (error) {
      fail(`${type}`, error);
    }
  }

  // 3. Suche – klassisch und, falls vorhanden, Sales Navigator
  const apis: Array<'classic' | 'sales_navigator'> = premium.includes('sales_navigator') ? ['classic', 'sales_navigator'] : ['classic'];
  let firstHit: SearchHit | null = null;
  for (const api of apis) {
    line(`\n3) Suche über ${api === 'classic' ? 'LinkedIn (klassisch)' : 'Sales Navigator'} – 5 Treffer`);
    const locationId = config.unipile.locationId ?? (api === 'classic' ? regionIds.LOCATION : regionIds.REGION ?? regionIds.LOCATION);
    if (!locationId) {
      fail('keine Region-ID', new Error('Region konnte nicht aufgelöst werden'));
      continue;
    }
    // Klassisch wie im echten Lauf: einfache Suche mit einem Stichwort und einer Position (erste Kombination).
    const first = searchCombinations(DEFAULT_SEARCH_PROFILE)[0];
    const body = api === 'classic' ? buildClassicSearchBody(first.keyword, first.position, locationId) : buildSearchBody(api, DEFAULT_SEARCH_PROFILE, locationId);
    line(`    Anfrage: ${JSON.stringify(body)}`);
    try {
      const response = await unipile.search({ accountId, body, limit: 5 }, signal);
      const items = (response.items ?? []) as UnipilePeopleResult[];
      const paging = (response as { paging?: { total_count?: number } }).paging;
      ok(`${items.length} Treffer${paging?.total_count !== undefined ? ` von insgesamt ${paging.total_count}` : ''} · weitere Seite: ${response.cursor ? 'ja' : 'nein'}`);
      for (const item of items) {
        const hit = toSearchHit(item);
        info(`${hit.firstName} ${hit.lastName} · ${hit.headline.slice(0, 70)} · ${hit.networkDistance ?? '?'}. Grad · ${hit.publicIdentifier ?? 'ohne public id'}${hit.pendingInvitation ? ' · Anfrage offen' : ''}`);
      }
      if (items[0]) raw('Rohdaten erster Treffer', items[0]);
      if (!firstHit && items[0]) firstHit = toSearchHit(items[0]);
    } catch (error) {
      fail('Suche', error);
    }
  }

  // 3b. Suchvarianten – welcher Filter schränkt wie stark ein? (je 1 Suche, nur Trefferzahl)
  const classicLocation = config.unipile.locationId ?? regionIds.LOCATION;
  if (classicLocation) {
    line('\n3b) Suchvarianten (klassisch) – wie viele Treffer meldet LinkedIn je Variante?');
    const { keywords, positions } = DEFAULT_SEARCH_PROFILE;
    const base = { api: 'classic', category: 'people', location: [classicLocation], network_distance: [2, 3] };
    const variants: Array<[string, object]> = [
      ['A  bisher: Stichwörter ODER + Titel ODER', buildSearchBody('classic', DEFAULT_SEARCH_PROFILE, classicLocation)],
      ['B  nur Stichwörter (ODER), kein Titel', { ...base, keywords: orJoin(keywords) }],
      ['C  nur Titel (ODER), keine Stichwörter', { ...base, advanced_keywords: { title: orJoin(positions) } }],
      ['D  alles in Stichwörtern: (… ODER …) AND (… ODER …)', { ...base, keywords: `(${orJoin(keywords)}) AND (${orJoin(positions)})` }],
      ['E  neu: ein Stichwort + ein Titel (so sucht die App jetzt)', { ...base, keywords: keywords[0], advanced_keywords: { title: positions[0] } }],
      ['F  wie A, ohne Region', (({ location: _location, ...rest }) => rest)(buildSearchBody('classic', DEFAULT_SEARCH_PROFILE, classicLocation) as Record<string, unknown>)],
      ['G  wie A, ohne Kontaktgrad', (({ network_distance: _distance, ...rest }) => rest)(buildSearchBody('classic', DEFAULT_SEARCH_PROFILE, classicLocation) as Record<string, unknown>)],
    ];
    for (const [label, body] of variants) {
      try {
        const response = await unipile.search({ accountId, body, limit: 10 }, signal);
        const items = (response.items ?? []) as UnipilePeopleResult[];
        const total = (response as { paging?: { total_count?: number } }).paging?.total_count;
        const first = items[0] ? toSearchHit(items[0]) : null;
        ok(`${label}: ${total ?? `${items.length}${response.cursor ? '+' : ''}`} Treffer${first ? ` · z. B. ${first.headline.slice(0, 60)}` : ''}`);
      } catch (error) {
        fail(label, error);
      }
    }
  }

  // 4. Offene Einladungen
  line('\n4) Gesendete, offene Vernetzungsanfragen');
  try {
    const response = await unipile.invitationsSent({ accountId, limit: 10 }, signal);
    ok(`${response.items?.length ?? 0} auf der ersten Seite · weitere Seite: ${response.cursor ? 'ja' : 'nein'}`);
    if (response.items?.[0]) raw('Rohdaten erste Einladung', response.items[0]);
  } catch (error) {
    fail('Einladungen', error);
  }

  // 4b. Dubletten-Abgleich über alle Gründer-Accounts
  line('\n4b) Dubletten-Abgleich: Kontakte und offene Anfragen je Account');
  info(`Such-Account ${accountId}: Kontakte über den Kontaktgrad in Suche/Profil, Anfragen siehe 4)`);
  const checkedAccounts = new Set([accountId]);
  for (const founder of AUTH_FOUNDER_IDS) {
    const founderAccount = config.linkedin.accounts[founder];
    const name = defaultFounderName(founder);
    if (!founderAccount) {
      info(`${name}: kein Account (UNIPILE_ACCOUNT_${founder.toUpperCase()} leer) – wird nicht geprüft`);
      continue;
    }
    if (checkedAccounts.has(founderAccount)) {
      info(`${name}: ${founderAccount} = Such-Account bzw. schon geprüft`);
      continue;
    }
    checkedAccounts.add(founderAccount);
    try {
      // Sparsam: höchstens 3 Seiten Kontakte und 1 Seite Anfragen – der echte Lauf lädt alles (zwischengespeichert).
      const relations = await collectIds(
        (cursor) => unipile.listRelations({ accountId: founderAccount, limit: 100, cursor }, signal),
        (relation) => [relation.member_id, relation.public_identifier],
        3,
        async () => {},
      );
      const invitations = await unipile.invitationsSent({ accountId: founderAccount, limit: 100 }, signal);
      ok(
        `${name} (${founderAccount}): ${relations.count}${relations.truncated ? '+' : ''} Kontakte · ${invitations.items?.length ?? 0}${invitations.cursor ? '+' : ''} offene Anfragen – zählen im Dubletten-Filter mit`,
      );
    } catch (error) {
      fail(`${name} (${founderAccount}) – Kontakte nicht ladbar, neue Leads würden zurückgestellt`, error);
    }
  }

  if (!firstHit) {
    line('\nKein Treffer – Profil, Firma und KI werden übersprungen.');
    return;
  }

  // 5. Profil (ohne Benachrichtigung)
  line(`\n5) Profil von ${firstHit.firstName} ${firstHit.lastName} (notify=false)`);
  let companyId: string | null = null;
  let profileSummary = { headline: firstHit.headline, position: null as string | null, companyName: null as string | null };
  try {
    const profile = await unipile.getProfile({ accountId, identifier: firstHit.providerId }, signal);
    const experience = profile.work_experience ?? [];
    const current = experience.find((entry) => entry.current) ?? experience.find((entry) => !entry.end) ?? experience[0];
    companyId = current?.company_id ?? null;
    profileSummary = { headline: profile.headline ?? firstHit.headline, position: current?.position ?? null, companyName: current?.company ?? null };
    ok(`Position: ${current?.position ?? '–'} · Firma: ${current?.company ?? '–'} · company_id: ${companyId ?? '–'}`);
    info(`Standort: ${profile.location ?? '–'} · Netzwerk: ${profile.network_distance ?? '–'} · Einladung: ${profile.invitation ? `${profile.invitation.type}/${profile.invitation.status}` : 'keine'} · Stationen: ${experience.length}`);
    raw('Rohdaten Profil', profile);
  } catch (error) {
    fail('Profil', error);
  }

  // 6. Firma
  let company = { description: null as string | null, website: null as string | null, industry: null as string | null };
  if (companyId) {
    line(`\n6) Firmenprofil ${companyId}`);
    try {
      const result = await unipile.getCompany({ accountId, identifier: companyId }, signal);
      company = { description: result.description ?? null, website: result.website ?? null, industry: result.industry?.[0] ?? null };
      if (profileSummary.companyName) foundCompany = { name: profileSummary.companyName, website: result.website ?? null };
      ok(`${result.name ?? '–'} · Website: ${result.website ?? '–'} · Branche: ${result.industry?.join(', ') ?? '–'} · Beschreibung: ${result.description?.length ?? 0} Zeichen`);
    } catch (error) {
      fail('Firma', error);
    }
  }

  if (profileSummary.companyName && !foundCompany) foundCompany = { name: profileSummary.companyName, website: null };

  // 7. KI-Bewertung
  line('\n7) KI-Bewertung');
  if (!config.anthropic.apiKey) {
    info('übersprungen – kein ANTHROPIC_API_KEY (Leads bleiben dann „nicht bewertet“)');
    return;
  }
  try {
    const qualifier = new AnthropicQualifier({ apiKey: config.anthropic.apiKey, model: config.anthropic.model });
    const output = await qualifier.qualify(
      firstHit,
      {
        headline: profileSummary.headline,
        position: profileSummary.position,
        companyName: profileSummary.companyName,
        companyDescription: company.description,
        companyWebsite: company.website,
        companyIndustry: company.industry,
        location: firstHit.location,
      },
      signal,
    );
    const result = parseQualification(output, config.minConfidence);
    ok(`${result.category} · ${Math.round(result.confidence * 100)} % · ${result.qualified ? 'qualifiziert' : 'aussortiert'}`);
    info(result.reason);
  } catch (error) {
    fail('KI-Bewertung', error);
  }
}

/** 8. Meta-Werbebibliothek: Rohdaten einer Stichprobe, dann die Prüfung je Firma wie im Lauf. */
async function checkMeta(companies: Array<{ name: string; website: string | null }>) {
  line('\n8) Meta-Werbebibliothek (Ad Library API)');
  if (!config.meta.accessToken) {
    info('übersprungen – kein META_ACCESS_TOKEN (qualifizierte Leads bleiben dann „Meta-Ads nicht geprüft“)');
    if (metaOnly) failures++;
    return;
  }
  const client = new MetaAdLibraryClient({ accessToken: config.meta.accessToken, version: config.meta.graphVersion });
  try {
    const probe = await client.searchAds({ searchTerms: 'Kapitalanlage', activeStatus: 'ALL', limit: 3 }, signal);
    ok(`Zugriff klappt – Stichprobe „Kapitalanlage“: ${probe.ads.length} Anzeigen · weitere Seite: ${probe.hasMore ? 'ja' : 'nein'}`);
    if (probe.ads[0]) raw('Rohdaten erste Anzeige', probe.ads[0]);
  } catch (error) {
    fail('Meta-Werbebibliothek', error);
    return;
  }
  if (!companies.length) {
    info('Keine Firma zum Prüfen – mit --meta "Firmenname" kannst du gezielt Firmen prüfen.');
    return;
  }
  const checker = new MetaAdsChecker(client);
  for (const company of companies) {
    try {
      const result = await checker.check(
        { headline: '', position: null, companyName: company.name, companyDescription: null, companyWebsite: company.website, companyIndustry: null, location: null },
        signal,
      );
      const verdict = { none: 'keine eigenen Anzeigen → passt', stopped: 'Anzeigen beendet → passt', active: 'schaltet gerade Anzeigen → aussortiert', unchecked: 'nicht geprüft' }[result.state];
      ok(`${company.name} (Suche: „${companySearchTerm(company.name)}“): ${verdict}`);
      info(
        `eigene Anzeigen: ${result.ads} · davon aktiv: ${result.activeAds} · zuletzt beendet: ${result.lastStop ?? '–'} · Werbetreibender: ${result.advertiser ?? '–'} · Fremdtreffer: ${result.foreignAds}`,
      );
      if (result.note) info(result.note);
      if (result.libraryUrl) info(`Zum Nachprüfen: ${result.libraryUrl}`);
    } catch (error) {
      fail(`Meta-Ads ${company.name}`, error);
    }
  }
}

if (metaOnly) {
  line('Lead-Suche – Verbindungstest Meta-Werbebibliothek (nur lesend)');
  if (!metaOnly.length) line('  Firmennamen fehlen, z. B. --meta "Muster Wohnbau GmbH"');
  await checkMeta(metaOnly.map((name) => ({ name, website: null })));
} else {
  await main();
  await checkMeta(foundCompany ? [foundCompany] : []);
}
line(failures ? `\nFertig – ${failures} Problem(e). Schick mir diese Ausgabe.` : '\nFertig – alles erreichbar. Schick mir diese Ausgabe, dann prüfe ich die Feldnamen.');
if (failures) process.exitCode = 1;
