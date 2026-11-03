import { recordAiUsage } from '../../ai/usage.js';
import type { EnrichedProfile, MetaAdsCheck, PrescreenVerdict, SearchHit, SearchProfile } from '../../../../shared/leadSearch.js';
import { companySearchTerm, evaluateAds, isoDay, uncheckedAds, type ArchivedAd } from '../../ads/metaAds.js';
import { randomBetween, sleep } from '../../lib/sleep.js';
import type { AuthFounderId } from '../../../../shared/auth.js';
import {
  AdapterError,
  type EnrichResult,
  type LeadSearchAdapter,
  type NetworkCheck,
  type RunContext,
  type SearchOptions,
} from '../../pipeline/adapter.js';
import { MOCK_LEADS, MOCK_LEADS_BY_ID, type MockAds } from './mockData.js';

const DAY = 24 * 60 * 60 * 1000;

/** Simulierter weiterer Gründer-Account: Kontakte und offene Anfragen (Provider-IDs oder öffentliche Kennungen). */
export interface MockFounderNetwork {
  founder: AuthFounderId;
  connected?: string[];
  invited?: string[];
  /** Prüfung schlägt fehl (z. B. Account getrennt) – kurzer Grund. */
  error?: string;
}

const OPEN_INVITATION_LEADS = MOCK_LEADS.filter((lead) => lead.openInvitation);

/**
 * Standard der Simulation: Johannes' Account als zweiter Gründer-Account. Er kennt nur Personen, die schon wegen einer
 * offenen Anfrage des Such-Accounts aussortiert werden – der Weg wird durchlaufen, der Trichter 40 → 33 → 15 → 7 → 5
 * bleibt gleich.
 */
export const DEFAULT_MOCK_FOUNDER_NETWORKS: readonly MockFounderNetwork[] = [
  {
    founder: 'johannes',
    connected: [OPEN_INVITATION_LEADS[0].hit.providerId],
    invited: OPEN_INVITATION_LEADS[1].hit.publicIdentifier ? [OPEN_INVITATION_LEADS[1].hit.publicIdentifier] : [],
  },
];

/** Baut Anzeigen so, wie sie GET /ads_archive liefern würde – eigene und Fremdtreffer. */
export function mockArchivedAds(companyName: string, ads: MockAds | undefined, now: Date): ArchivedAd[] {
  if (!ads) return [];
  const pageName = companySearchTerm(companyName);
  const pageId = String(100_000_000 + (pageName.length * 7919) % 900_000_000);
  const active = ads.active ?? 0;
  const lastStop = now.getTime() - (ads.stoppedDaysAgo ?? 30) * DAY;
  const own: ArchivedAd[] = Array.from({ length: ads.total }, (_, index) => {
    const running = index < active;
    const stop = running ? null : lastStop - (index - active) * 9 * DAY;
    return {
      id: `${pageId}${index}`,
      page_id: pageId,
      page_name: pageName,
      ad_delivery_start_time: isoDay(new Date((stop ?? now.getTime()) - (20 + index * 11) * DAY)),
      ad_delivery_stop_time: stop === null ? undefined : isoDay(new Date(stop)),
    };
  });
  const foreign: ArchivedAd[] = Array.from({ length: ads.foreign ?? 0 }, (_, index) => ({
    id: `9${pageId}${index}`,
    page_id: `9${index}${pageId}`,
    page_name: index % 2 ? 'ImmoScout Projektmarketing' : 'Neubau-Kompass Deutschland',
    ad_delivery_start_time: isoDay(new Date(now.getTime() - 30 * DAY)),
  }));
  return [...own, ...foreign];
}

/** Modell, mit dem die Simulation ihre KI-Kosten rechnet. */
const MOCK_AI_MODEL = 'claude-opus-5-5';

/**
 * Simulation ohne Schlüssel und ohne Internet. Liefert dieselben Datenstrukturen wie der Live-Adapter;
 * die Verzögerungen sind so bemessen, dass ein Lauf ca. 15–20 Sekunden dauert (Faktor `speed`).
 */
export class MockAdapter implements LeadSearchAdapter {
  readonly mode = 'mock' as const;
  readonly canQualify = true;
  readonly canCheckAds = true;

  constructor(
    private readonly speed = 1,
    private readonly options: { founderNetworks?: readonly MockFounderNetwork[] } = {},
  ) {}

  private wait(ms: number, ctx: RunContext) {
    return sleep(Math.round(ms * this.speed), ctx.signal);
  }

  /** Zeit pro Profil so wählen, dass die Anreicherung insgesamt rund 11 Sekunden dauert. */
  private perProfileMs(profile: SearchProfile) {
    return Math.min(1000, Math.max(450, 11_000 / Math.max(1, profile.maxResults)));
  }

  async search(_profile: SearchProfile, options: SearchOptions, ctx: RunContext): Promise<SearchHit[]> {
    // Wie live: schon geprüfte Profile zählen nicht zur Trefferzahl (ohne `skip` die ersten `maxHits`).
    const hits: SearchHit[] = [];
    let fresh = 0;
    for (const lead of MOCK_LEADS) {
      if (fresh >= options.maxHits) break;
      hits.push({ ...lead.hit });
      if (!options.skip?.has(lead.hit.providerId)) fresh++;
    }
    // Wie im Live-Betrieb kommen die Treffer seitenweise.
    const pageSize = 10;
    for (let start = 0; start < hits.length; start += pageSize) {
      await this.wait(randomBetween(450, 650), ctx);
      options.onHits(hits.slice(start, start + pageSize));
    }
    return hits;
  }

  async pendingInvitations(ctx: RunContext): Promise<Set<string>> {
    await this.wait(500, ctx);
    return new Set(MOCK_LEADS.filter((lead) => lead.openInvitation).map((lead) => lead.hit.providerId));
  }

  async founderNetworks(ctx: RunContext): Promise<NetworkCheck> {
    await this.wait(300, ctx);
    const key = (value: string) => value.trim().toLowerCase();
    const networks = (this.options.founderNetworks ?? DEFAULT_MOCK_FOUNDER_NETWORKS).map((network) => ({
      founder: network.founder,
      connected: new Set((network.connected ?? []).map(key)),
      invited: new Set((network.invited ?? []).map(key)),
      error: network.error ?? null,
    }));
    return { networks, warnings: [] };
  }

  async dedupeDelay(ctx: RunContext): Promise<void> {
    await this.wait(45, ctx);
  }

  /** Simulierte KI-Vorprüfung: Urteil aus den Mock-Daten, sonst „passt vermutlich“. */
  async prescreen(hits: SearchHit[], ctx: RunContext): Promise<Map<string, PrescreenVerdict>> {
    await this.wait(randomBetween(600, 900), ctx);
    // Simulierte KI-Kosten wie ein echtes Paket (Dashboard, Tagesbudget der automatischen Suche).
    recordAiUsage('prescreen', MOCK_AI_MODEL, { input_tokens: 600 + hits.length * 60, output_tokens: hits.length * 30 }, ctx.runId);
    const verdicts = new Map<string, PrescreenVerdict>();
    for (const hit of hits) {
      const lead = MOCK_LEADS_BY_ID.get(hit.providerId);
      if (!lead) continue;
      verdicts.set(hit.providerId, lead.prescreen ?? { fit: 'likely', reason: 'Headline passt zur Zielgruppe' });
    }
    return verdicts;
  }

  async pauseBeforeProfile(ctx: RunContext): Promise<void> {
    const ms = this.perProfileMs(ctx.profile) * 0.6;
    await this.wait(randomBetween(ms * 0.8, ms * 1.2), ctx);
  }

  async enrich(hit: SearchHit, ctx: RunContext): Promise<EnrichResult> {
    const ms = this.perProfileMs(ctx.profile) * 0.4;
    await this.wait(randomBetween(ms * 0.8, ms * 1.2), ctx);
    const lead = MOCK_LEADS_BY_ID.get(hit.providerId);
    if (!lead) throw new AdapterError('provider', 'Profil nicht gefunden', 'Profil nicht abrufbar', false);
    return { profile: { ...lead.profile } };
  }

  async qualify(hit: SearchHit, _profile: unknown, ctx: RunContext): Promise<unknown> {
    await this.wait(randomBetween(700, 1100), ctx);
    const lead = MOCK_LEADS_BY_ID.get(hit.providerId);
    if (!lead) throw new AdapterError('provider', 'Keine Einschätzung', 'Keine Einschätzung möglich', false);
    recordAiUsage('qualify', MOCK_AI_MODEL, { input_tokens: 2_500, output_tokens: 400 }, ctx.runId);
    // Simulierte Modellausgabe – Validierung und strenge Regel folgen im Runner.
    return structuredClone(lead.ai);
  }

  async checkMetaAds(hit: SearchHit, profile: EnrichedProfile, ctx: RunContext): Promise<MetaAdsCheck> {
    await this.wait(randomBetween(350, 600), ctx);
    if (!profile.companyName) return uncheckedAds('Keine Firma im Profil – Meta-Ads nicht geprüft', null);
    const now = new Date();
    const ads = mockArchivedAds(profile.companyName, MOCK_LEADS_BY_ID.get(hit.providerId)?.ads, now);
    return evaluateAds(ads, { name: profile.companyName, website: profile.companyWebsite }, { today: now, term: companySearchTerm(profile.companyName) });
  }
}
