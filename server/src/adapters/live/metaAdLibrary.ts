import type { EnrichedProfile, MetaAdsCheck } from '../../../../shared/leadSearch.js';
import {
  ADS_COUNTRY,
  ARCHIVED_AD_FIELDS,
  companySearchTerm,
  domainOf,
  evaluateAds,
  mergeAdsChecks,
  personSearchTerm,
  samePerson,
  uncheckedAds,
  type ArchivedAd,
  type PersonRef,
} from '../../ads/metaAds.js';
import { DEFAULT_META_GRAPH_VERSION } from '../../config.js';
import { AdapterError, CancelledError } from '../../pipeline/adapter.js';

/**
 * Client für die Meta Ad Library API (Graph API). Nur der dokumentierte Endpunkt
 * GET https://graph.facebook.com/{version}/ads_archive mit access_token, ad_reached_countries, ad_type,
 * ad_active_status, search_terms, search_type, fields und limit.
 *
 * Für Länder der EU liefert Meta mit ad_type=ALL alle Anzeigen (nicht nur politische) – bis ein Jahr nach der
 * letzten Ausspielung. Der Token steht nur in der Anfrage-URL und taucht in keiner Meldung und keinem Log auf.
 */

/** So viele Anzeigen pro Abfrage – reicht, um eigene Anzeigen zwischen Fremdtreffern zu finden. */
const PAGE_LIMIT = 100;

export class MetaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly metaMessage: string,
  ) {
    super(`Meta ${status}${code !== null ? ` (#${code})` : ''}: ${metaMessage}`);
    this.name = 'MetaApiError';
  }
}

export class MetaNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaNetworkError';
  }
}

export interface MetaAdLibraryOptions {
  accessToken: string;
  version?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AdsArchiveQuery {
  searchTerms: string;
  activeStatus: 'ALL' | 'ACTIVE';
  limit?: number;
}

export class MetaAdLibraryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  readonly version: string;

  constructor(private readonly options: MetaAdLibraryOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    this.version = options.version ?? DEFAULT_META_GRAPH_VERSION;
  }

  /** Eine Seite Anzeigen zu einem Suchbegriff, in Deutschland ausgespielt. */
  async searchAds(query: AdsArchiveQuery, signal: AbortSignal): Promise<{ ads: ArchivedAd[]; hasMore: boolean }> {
    const url = new URL(`${this.baseUrl}/${this.version}/ads_archive`);
    url.searchParams.set('access_token', this.options.accessToken);
    url.searchParams.set('ad_type', 'ALL');
    url.searchParams.set('ad_reached_countries', JSON.stringify([ADS_COUNTRY]));
    url.searchParams.set('ad_active_status', query.activeStatus);
    url.searchParams.set('search_terms', query.searchTerms);
    // Alle Wörter müssen vorkommen (Standard der API). Fremdtreffer sortiert danach der Abgleich mit Seitenname/Domain aus.
    url.searchParams.set('search_type', 'KEYWORD_UNORDERED');
    url.searchParams.set('fields', ARCHIVED_AD_FIELDS.join(','));
    url.searchParams.set('limit', String(query.limit ?? PAGE_LIMIT));

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.any([signal, timeout]) });
    } catch (error) {
      if (signal.aborted) throw new CancelledError();
      if (timeout.aborted) throw new MetaNetworkError('Zeitüberschreitung bei der Meta-Werbebibliothek');
      throw new MetaNetworkError(this.redact(error instanceof Error ? error.message : String(error)));
    }
    const text = await response.text();
    let json: { data?: ArchivedAd[]; paging?: { next?: string }; error?: { message?: string; code?: number; error_subcode?: number } } | null =
      null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok || json?.error) {
      const error = json?.error;
      throw new MetaApiError(
        response.status,
        typeof error?.code === 'number' ? error.code : null,
        typeof error?.error_subcode === 'number' ? error.error_subcode : null,
        this.redact(error?.message ?? (text.slice(0, 200) || 'keine Details')),
      );
    }
    return { ads: Array.isArray(json?.data) ? json.data : [], hasMore: Boolean(json?.paging?.next) };
  }

  private redact(message: string): string {
    return this.options.accessToken ? message.split(this.options.accessToken).join('***') : message;
  }
}

/** Graph-API-Fehler verständlich machen. Token-, Rechte- und Limitfehler brechen den Lauf ab. */
export function toMetaAdapterError(error: unknown): Error {
  if (error instanceof AdapterError || error instanceof CancelledError) return error;
  if (error instanceof MetaNetworkError) {
    return new AdapterError('network', 'Meta nicht erreichbar', `Meta-Werbebibliothek nicht erreichbar (${error.message}) – Ads nicht geprüft`, false);
  }
  if (!(error instanceof MetaApiError)) {
    return new AdapterError('unknown', 'Unerwarteter Fehler', error instanceof Error ? error.message : String(error), false);
  }
  const code = error.code ?? -1;
  if (code === 190 || error.status === 401) {
    return new AdapterError(
      'auth',
      'Meta-Token ungültig oder abgelaufen',
      `Die Meta-Werbebibliothek lehnt META_ACCESS_TOKEN ab (${error.metaMessage}). Erzeuge einen neuen Token und trag ihn unter Einstellungen → Meta-Werbebibliothek ein.`,
      true,
    );
  }
  if ([4, 17, 32, 613].includes(code) || error.status === 429) {
    return new AdapterError(
      'rate_limit',
      'Meta-Limit erreicht',
      'Die Meta-Werbebibliothek nimmt gerade keine weiteren Abfragen an. Warte etwa eine Stunde und starte die Suche dann erneut.',
      true,
    );
  }
  if (code === 10 || (code >= 200 && code < 300) || error.status === 403) {
    return new AdapterError(
      'auth',
      'Kein Zugriff auf die Meta-Werbebibliothek',
      `Meta verweigert den Zugriff (${error.metaMessage}). Die Ad Library API braucht eine bestätigte Identität bei Meta (facebook.com/ID) und einen Token derselben App.`,
      true,
    );
  }
  if (code === 100) {
    return new AdapterError(
      'config',
      'Meta lehnt die Abfrage ab',
      `Die Meta-Werbebibliothek lehnt die Abfrage ab (${error.metaMessage}). Prüfe die Graph-API-Version unter Einstellungen → Meta-Werbebibliothek.`,
      true,
    );
  }
  return new AdapterError('provider', 'Meta-Fehler', `Meta-Werbebibliothek: ${error.metaMessage} – Ads nicht geprüft`, false);
}

/**
 * Prüft eine Firma in der Werbebibliothek: Suche nach dem Firmennamen, bei keinem eigenen Treffer zusätzlich nach
 * der Website-Domain. Höchstens drei Abfragen pro Lead.
 */
export class MetaAdsChecker {
  constructor(
    private readonly client: MetaAdLibraryClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Firma prüfen und – solange sie nicht gerade selbst wirbt – auch den privaten Namen der Person (eine Abfrage mehr;
   * Wunsch des Nutzers 15.10.: manche schalten die Anzeigen über ihr eigenes Profil).
   */
  async check(profile: EnrichedProfile, signal: AbortSignal, person?: PersonRef | null): Promise<MetaAdsCheck> {
    const company = await this.checkCompany(profile, signal);
    const stamp = (check: MetaAdsCheck): MetaAdsCheck => ({ ...check, checkedAt: this.now().getTime() });
    if (company.state === 'active' || !person) return stamp(mergeAdsChecks(company, null));
    return stamp(mergeAdsChecks(company, await this.checkPerson(person, signal)));
  }

  /** Anzeigen unter dem Namen der Person – nur Seiten, deren Name Vor- und Nachname enthält. */
  private async checkPerson(person: PersonRef, signal: AbortSignal): Promise<MetaAdsCheck | null> {
    const term = personSearchTerm(person);
    if (!term) return null;
    try {
      const { ads } = await this.client.searchAds({ searchTerms: term, activeStatus: 'ALL' }, signal);
      return evaluateAds(ads, { name: term, website: null }, { today: this.now(), term, isOwn: (ad) => !!ad.page_name && samePerson(ad.page_name, person) });
    } catch (error) {
      throw toMetaAdapterError(error);
    }
  }

  private async checkCompany(profile: EnrichedProfile, signal: AbortSignal): Promise<MetaAdsCheck> {
    const companyName = profile.companyName?.trim();
    if (!companyName) return uncheckedAds('Keine Firma im Profil – Meta-Ads nicht geprüft', null);
    const term = companySearchTerm(companyName);
    if (term.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return uncheckedAds('Firmenname zu kurz für die Suche – Meta-Ads nicht geprüft', companyName);
    const company = { name: companyName, website: profile.companyWebsite };
    const today = this.now();

    try {
      const ads: ArchivedAd[] = [];
      const byName = await this.client.searchAds({ searchTerms: term, activeStatus: 'ALL' }, signal);
      ads.push(...byName.ads);
      let result = evaluateAds(ads, company, { today, term });

      const domain = domainOf(profile.companyWebsite);
      if (result.state === 'none' && domain) {
        const byDomain = await this.client.searchAds({ searchTerms: domain, activeStatus: 'ALL' }, signal);
        ads.push(...byDomain.ads);
        result = evaluateAds(ads, company, { today, term });
      }
      // Volle Seite ohne aktive eigene Anzeige: sicherheitshalber nur die aktiven nachladen.
      if (result.state === 'stopped' && byName.hasMore) {
        const active = await this.client.searchAds({ searchTerms: term, activeStatus: 'ACTIVE' }, signal);
        ads.push(...active.ads);
        result = evaluateAds(ads, company, { today, term });
      }
      return result;
    } catch (error) {
      throw toMetaAdapterError(error);
    }
  }
}
