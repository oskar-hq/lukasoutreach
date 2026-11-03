import type { FastifyBaseLogger } from 'fastify';
import type { CompanyEnrichment, EnrichmentMode, EnrichmentStatusResponse } from '../../../shared/enrichment.js';
import type { CockpitLead } from '../../../shared/leads.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { LeadNotFoundError, isRealLead, type LeadStore } from '../leads/leadStore.js';
import { NO_SOCIALS, mockValues, parseClayResult, parseTregCompany, type EnrichmentValues } from './values.js';

/**
 * Anreicherung mit Firmendaten (Vertrag `shared/enrichment.ts`). Quelle über ENRICHMENT_PROVIDER:
 *
 * Treg (Standard): `POST <TREG>/call/treg.companies.enrich` mit JSON `{ "domain": … }`, Header `X-Treg-Token` und
 * `X-Treg-Route-Max-Cost` (Obergrenze je Abruf; Treg-Standard wäre 1 $). Treg probiert bis zu 27 Anbieter, billigste
 * zuerst, und nimmt den ersten Treffer; Antwort `{ output, raw, _treg: { served_by, charged_micro, … } }`, Fehlschlag =
 * `output.name == null` (HTTP 200). Ergebnis sofort, nur mit Website-Domain. Es geht nur die Domain hinaus, keine
 * Personendaten.
 *
 * Clay:
 * Live: Lead per POST an den Webhook einer Clay-Tabelle (Clay-Doku „Import data from Webhook“, optionaler Header
 * `x-clay-webhook-auth`). Die Tabelle reichert an und schickt das Ergebnis mit einer „HTTP API“-Spalte an
 * `POST /api/enrichment/clay` zurück (Header `x-cockpit-secret`). Einrichtung der Tabelle: README „Clay“.
 * Simulation: feste Werte je Firma nach ca. 1,5 s · MOCK_SPEED, ohne Netz.
 */

export class EnrichmentOffError extends Error {
  constructor(provider: 'treg' | 'clay' = 'clay', reason?: string) {
    super(
      reason ??
        (provider === 'treg'
          ? 'Treg ist nicht eingerichtet – trag den Token unter Einstellungen → Firmendaten (Treg, Clay) ein.'
          : 'Clay ist nicht eingerichtet – trag Webhook-Adresse und Rückkanal-Schlüssel unter Einstellungen → Firmendaten (Treg, Clay) ein.'),
    );
    this.name = 'EnrichmentOffError';
  }
}

export class EnrichmentLimitError extends Error {
  constructor(
    limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super(`Tageslimit für Firmendaten erreicht (${limit} Anfragen) – morgen geht es weiter.`);
    this.name = 'EnrichmentLimitError';
  }
}

/** So lange gilt eine offene Anfrage als „läuft noch“ – danach darf erneut angefragt werden. */
export const PENDING_TIMEOUT_MS = 60 * 60 * 1000;
/** Simulierte Dauer bei MOCK_SPEED=1. */
const MOCK_DELAY_MS = 1500;
const SEND_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function emptyValues(): EnrichmentValues {
  return { employees: null, employeesRange: null, revenue: null, techStack: [], metaPixel: null, googleTagManager: null, socials: { ...NO_SOCIALS } };
}

function pickValues(enrichment: CompanyEnrichment): EnrichmentValues {
  const { employees, employeesRange, revenue, techStack, metaPixel, googleTagManager, socials } = enrichment;
  return { employees, employeesRange, revenue, techStack, metaPixel, googleTagManager, socials };
}

export function enrichmentMode(config: Config): EnrichmentMode {
  if (config.mode === 'mock') return 'mock';
  if (config.enrichmentProvider === 'treg') return config.treg.token ? 'live' : 'off';
  return config.clay.webhookUrl && config.clay.callbackSecret ? 'live' : 'off';
}

/** Treg-Katalog: geroutet über bis zu 27 Anbieter, nimmt den ersten Treffer (Stand 05.10.2026, Katalog-Suche). */
export const TREG_ENRICH_ID = 'treg.companies.enrich';

function domainOf(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export class EnrichmentService {
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly deps: {
      config: Config;
      db: Database;
      leads: LeadStore;
      log: FastifyBaseLogger;
      fetch?: typeof fetch;
    },
  ) {}

  /** Immer aus der laufenden Konfiguration – Einstellungen wirken ohne Neustart. */
  get mode(): EnrichmentMode {
    return enrichmentMode(this.deps.config);
  }

  get provider(): 'treg' | 'clay' {
    return this.deps.config.enrichmentProvider;
  }

  usedToday(now = Date.now()): number {
    const row = this.deps.db.prepare('SELECT COUNT(*) AS n FROM enrichment_requests WHERE requested_at >= ?').get(dayStart(now)) as { n: number };
    return row.n;
  }

  status(now = Date.now()): EnrichmentStatusResponse {
    const { autoEnrich, dailyLimit } = this.deps.config.clay;
    return { mode: this.mode, provider: this.provider, autoEnrich: this.mode !== 'off' && autoEnrich, dailyLimit, usedToday: this.usedToday(now) };
  }

  /**
   * Anreicherung anstoßen. Läuft schon eine (pending, jünger als 1 h), kommt der Lead unverändert zurück.
   * Wirft LeadNotFoundError, EnrichmentOffError, EnrichmentLimitError.
   */
  async request(id: string, now = Date.now()): Promise<CockpitLead> {
    const lead = this.deps.leads.get(id);
    if (!lead) throw new LeadNotFoundError();
    if (this.mode === 'off') throw new EnrichmentOffError(this.provider);
    // Die Simulation erfindet Firmendaten – nie für echte Leads (aus Live-Läufen oder der Tracking-Liste).
    if (this.mode === 'mock' && isRealLead(lead)) {
      throw new EnrichmentOffError(this.provider, 'In der Simulation werden keine Firmendaten für echte Leads erfunden. Schalte auf Live, um sie über Treg zu holen.');
    }
    const current = lead.enrichment;
    if (current?.status === 'pending' && now - current.requestedAt < PENDING_TIMEOUT_MS) return lead;
    const treg = this.mode === 'live' && this.provider === 'treg';
    const domain = domainOf(lead.company.website);
    if (treg && !domain) {
      // Ohne Domain keine sichere Zuordnung – nichts abfragen, nichts zählen.
      return this.deps.leads.setEnrichment(id, {
        ...(current ? pickValues(current) : emptyValues()),
        source: 'treg',
        status: 'failed',
        requestedAt: now,
        receivedAt: now,
        error: 'Keine Website bekannt – ohne Domain ist die Firma nicht eindeutig zuzuordnen.',
      });
    }

    const { dailyLimit } = this.deps.config.clay;
    if (this.usedToday(now) >= dailyLimit) {
      throw new EnrichmentLimitError(dailyLimit, Math.max(1, Math.ceil((dayStart(now) + DAY_MS - now) / 1000)));
    }
    const source = this.mode === 'mock' ? 'mock' : this.provider;
    this.deps.db.prepare('INSERT INTO enrichment_requests (lead_id, source, requested_at) VALUES (?, ?, ?)').run(id, source, now);
    // Bisherige Werte bleiben sichtbar, bis neue da sind.
    const pending: CompanyEnrichment = {
      source,
      status: 'pending',
      requestedAt: now,
      receivedAt: null,
      ...(current ? pickValues(current) : emptyValues()),
      error: null,
    };
    let next = this.deps.leads.setEnrichment(id, pending, now);

    if (this.mode === 'mock') {
      const delay = Math.round(MOCK_DELAY_MS * this.deps.config.mockSpeed);
      const finish = () => this.deps.leads.setEnrichment(id, { ...pending, ...mockValues(lead.company), status: 'done', receivedAt: Date.now() });
      if (delay === 0) return finish();
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        try {
          finish();
        } catch (error) {
          // Lead inzwischen gelöscht (Demo zurückgesetzt) – nichts zu tun.
          if (!(error instanceof LeadNotFoundError)) this.deps.log.error({ err: error }, 'Simulierte Anreicherung fehlgeschlagen');
        }
      }, delay);
      timer.unref();
      this.timers.add(timer);
      return next;
    }

    if (treg) {
      const result = await this.fetchTreg(domain!);
      const finished = Date.now();
      if ('values' in result) {
        this.deps.log.info({ leadId: id, servedBy: result.servedBy, chargedUsd: result.chargedUsd }, 'Firmendaten über Treg geholt');
        return this.deps.leads.setEnrichment(id, { ...pending, ...result.values, status: 'done', receivedAt: finished });
      }
      this.deps.log.warn({ leadId: id, error: result.error }, 'Firmendaten über Treg fehlgeschlagen');
      if (result.stop) this.stopped = result.error;
      return this.deps.leads.setEnrichment(id, { ...pending, status: 'failed', receivedAt: finished, error: result.error });
    }

    try {
      await this.send(lead);
      this.deps.log.info({ leadId: id }, 'Lead an Clay geschickt');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
      this.deps.log.warn({ leadId: id, error: message }, 'Senden an Clay fehlgeschlagen');
      next = this.deps.leads.setEnrichment(id, { ...pending, status: 'failed', receivedAt: Date.now(), error: message });
    }
    return next;
  }

  /** Bei der Übergabe: neue Leads mit Score Hoch/Mittel anreichern, solange das Tageslimit reicht. Fehler nur loggen. */
  async autoEnrich(leads: CockpitLead[]): Promise<void> {
    if (this.mode === 'off' || !this.deps.config.clay.autoEnrich) return;
    this.stopped = null;
    for (const lead of leads) {
      // Treg-Guthaben leer oder Token falsch: nicht weiter Lead für Lead dagegen laufen.
      if (this.stopped) return;
      if (!lead.score || lead.score.tier === 'low' || lead.stage !== 'new') continue;
      try {
        await this.request(lead.id);
      } catch (error) {
        if (error instanceof EnrichmentLimitError) {
          this.deps.log.info('Clay-Tageslimit erreicht – weitere Leads werden nicht automatisch angereichert');
          return;
        }
        this.deps.log.warn({ err: error, leadId: lead.id }, 'Automatische Anreicherung fehlgeschlagen');
      }
    }
  }

  /** Rückmeldung von Clay. Wirft LeadNotFoundError. */
  receive(id: string, body: Record<string, unknown>, now = Date.now()): CockpitLead {
    const lead = this.deps.leads.get(id);
    if (!lead) throw new LeadNotFoundError();
    const { values, usable } = parseClayResult(body);
    const clayError = typeof body.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 200) : null;
    const failed = clayError !== null || !usable;
    const previous = lead.enrichment;
    const enrichment: CompanyEnrichment = {
      source: 'clay',
      status: failed ? 'failed' : 'done',
      requestedAt: previous?.requestedAt ?? now,
      receivedAt: now,
      // Fehlschlag: frühere Daten behalten statt sie mit „unbekannt“ zu überschreiben.
      ...(failed && previous ? pickValues(previous) : values),
      error: failed ? (clayError ? `Clay meldet: ${clayError}` : 'Clay hat keine Firmendaten gefunden.') : null,
    };
    return this.deps.leads.setEnrichment(id, enrichment, now);
  }

  /** Nur Prüfbefehl: ein Abruf über Treg, ohne zu speichern oder zu zählen. */
  probe(domain: string) {
    return this.fetchTreg(domain);
  }

  /** Grund, warum die automatische Anreicherung in diesem Durchlauf abbricht (Guthaben, Zugang). */
  private stopped: string | null = null;

  /**
   * Ein Abruf über Treg. Fehler als Satz (ohne Token, ohne Antworttext). stop = weitere Abrufe zwecklos.
   * `servedBy`/`chargedUsd` nur für Log und Prüfbefehl.
   */
  private async fetchTreg(domain: string): Promise<{ values: EnrichmentValues; servedBy: string | null; chargedUsd: number | null } | { error: string; stop?: boolean }> {
    const { token, baseUrl, maxCostUsd } = this.deps.config.treg;
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(`${baseUrl}/call/${TREG_ENRICH_ID}`, {
        method: 'POST',
        headers: {
          'X-Treg-Token': token!,
          'content-type': 'application/json',
          accept: 'application/json',
          // Ohne Obergrenze erlaubt Treg bis 1 $ je Abruf (teure Anbieter am Ende der Reihe).
          'X-Treg-Route-Max-Cost': String(maxCostUsd),
        },
        body: JSON.stringify({ domain }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      return { error: error instanceof Error && error.name === 'TimeoutError' ? 'Treg antwortet nicht (Zeitüberschreitung).' : 'Treg ist nicht erreichbar.' };
    }
    type TregBody = { output?: unknown; raw?: unknown; _treg?: { served_by?: string; charged_micro?: number } };
    let body: TregBody | null = null;
    try {
      body = (await response.json()) as TregBody;
    } catch {
      body = null;
    }
    // Treg-eigene Fehler kommen als HTTP-Status (Antworttext nie weitergeben – er könnte Anfragedaten spiegeln).
    const status = response.status;
    if (status === 401 || status === 403) return { error: 'Treg lehnt den Zugang ab – bitte den Token unter Einstellungen → Firmendaten (Treg, Clay) prüfen.', stop: true };
    if (status === 402) return { error: 'Treg-Guthaben aufgebraucht – auf treg.to aufladen.', stop: true };
    if (status === 404) return { error: 'Treg kennt den Dienst nicht (treg.companies.enrich) – bitte melden.', stop: true };
    if (status === 429 || status === 503) return { error: 'Treg bzw. die Datenanbieter sind gerade ausgelastet – später noch einmal.' };
    if (status < 200 || status >= 300) return { error: `Treg meldet einen Fehler (HTTP ${status}).` };
    const output = body?.output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) return { error: 'Unerwartete Antwort von Treg.' };
    const { values, usable } = parseTregCompany(output as Record<string, unknown>, body?.raw);
    if (!usable) return { error: `Keine Firmendaten zu ${domain} gefunden (kein Anbieter kennt die Firma).` };
    const micro = body?._treg?.charged_micro;
    return { values, servedBy: body?._treg?.served_by ?? null, chargedUsd: typeof micro === 'number' ? micro / 1_000_000 : null };
  }

  private async send(lead: CockpitLead): Promise<void> {
    const { webhookUrl, webhookToken } = this.deps.config.clay;
    const publicUrl = this.deps.config.auth.publicUrl;
    const fetchImpl = this.deps.fetch ?? fetch;
    const { person, company } = lead;
    const response = await fetchImpl(webhookUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(webhookToken ? { 'x-clay-webhook-auth': webhookToken } : {}) },
      body: JSON.stringify({
        leadId: lead.id,
        firstName: person.firstName,
        lastName: person.lastName,
        fullName: `${person.firstName} ${person.lastName}`.trim(),
        position: person.position,
        linkedinUrl: person.profileUrl,
        location: person.location,
        company: company.name,
        website: company.website,
        domain: domainOf(company.website),
        callbackUrl: publicUrl ? `${publicUrl}/api/enrichment/clay` : null,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new Error(error instanceof Error && error.name === 'TimeoutError' ? 'Clay antwortet nicht (Zeitüberschreitung).' : 'Clay ist nicht erreichbar.');
    });
    if (!response.ok) {
      // Kein Antworttext in die Meldung – könnte Teile der Anfrage spiegeln.
      throw new Error(
        response.status === 401 || response.status === 403
          ? `Clay lehnt den Zugang ab (HTTP ${response.status}) – CLAY_WEBHOOK_TOKEN prüfen.`
          : `Clay hat die Anfrage abgelehnt (HTTP ${response.status}).`,
      );
    }
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
