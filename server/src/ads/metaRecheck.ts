import { DEFAULT_SEARCH_PROFILE, type EnrichedProfile, type MetaAdsCheck, type SearchHit } from '../../../shared/leadSearch.js';
import type { CockpitLead } from '../../../shared/leads.js';
import { META_RECHECK_IDLE, type MetaRecheckStatus } from '../../../shared/metaRecheck.js';
import { AdapterError, CancelledError, type LeadSearchAdapter } from '../pipeline/adapter.js';
import type { Logger } from '../pipeline/runner.js';

/**
 * Meta-Ads für alle Leads im Cockpit nachprüfen (Vertrag `shared/metaRecheck.ts`, Wunsch des Nutzers 15.10.).
 * Nacheinander, mit kurzer Pause zwischen den Leads (Meta begrenzt die Abfragen je Stunde). Meldet Meta ein Limit,
 * wartet der Dienst und macht mit demselben Lead weiter. Ein abgelehnter Token oder fehlende Rechte beenden ihn.
 * Geprüft wird über den Adapter – live die Werbebibliothek (Firma + privater Name), in der Simulation die Testdaten.
 */

export const META_RECHECK_MESSAGES = {
  noToken: 'Ohne Meta-Token kann nichts geprüft werden. Trag ihn unter Einstellungen → Meta-Werbebibliothek ein.',
  busy: 'Die Nachprüfung läuft schon.',
  waiting: (minutes: number) => `Meta nimmt gerade keine weiteren Abfragen an – es geht in etwa ${minutes} Minuten automatisch weiter.`,
  done: (count: number) => `${count} ${count === 1 ? 'Lead' : 'Leads'} nachgeprüft.`,
} as const;

declare module 'fastify' {
  interface FastifyInstance {
    /** Meta-Nachprüfung (Tests: `idle()`). */
    metaRecheck: MetaRecheckService;
  }
}

export class MetaRecheckBusyError extends Error {}
export class MetaRecheckUnavailableError extends Error {}

export interface MetaRecheckDeps {
  leads: {
    metaRecheckIds(): string[];
    get(id: string): CockpitLead | null;
    setCheckedMetaAds(id: string, check: MetaAdsCheck, now?: number): CockpitLead | null;
  };
  adapter: Pick<LeadSearchAdapter, 'checkMetaAds' | 'canCheckAds'>;
  log: Logger;
  now?: () => number;
  /** Pause zwischen zwei Leads (ms) – live 1,5 s, in Tests 0. */
  pauseMs?: number;
  /** Wartezeit nach einem Meta-Limit (ms), Standard 60 Minuten. */
  limitWaitMs?: number;
}

/** Lead → Treffer und Profil, wie sie die Lead-Suche dem Meta-Check gibt. */
export function recheckInput(lead: CockpitLead): { hit: SearchHit; profile: EnrichedProfile } {
  const { person, company } = lead;
  return {
    hit: {
      providerId: person.providerId,
      publicIdentifier: person.publicIdentifier,
      firstName: person.firstName,
      lastName: person.lastName,
      headline: person.headline,
      location: person.location,
      networkDistance: person.networkDistance,
      profileUrl: person.profileUrl,
    },
    profile: {
      headline: person.headline,
      position: person.position || null,
      companyName: company.name || null,
      companyDescription: null,
      companyWebsite: company.website,
      companyIndustry: company.industry,
      location: person.location ?? company.region,
    },
  };
}

export class MetaRecheckService {
  private state: MetaRecheckStatus = { ...META_RECHECK_IDLE };
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: MetaRecheckDeps) {
    this.now = deps.now ?? Date.now;
  }

  status(): MetaRecheckStatus {
    return { ...this.state };
  }

  /** Startet die Nachprüfung im Hintergrund. Wirft `MetaRecheckBusyError` bzw. `MetaRecheckUnavailableError`. */
  start(): MetaRecheckStatus {
    if (this.running) throw new MetaRecheckBusyError(META_RECHECK_MESSAGES.busy);
    if (!this.deps.adapter.canCheckAds) throw new MetaRecheckUnavailableError(META_RECHECK_MESSAGES.noToken);
    const ids = this.deps.leads.metaRecheckIds().filter((id) => !this.deps.leads.get(id)?.metaAds?.manual);
    this.state = { ...META_RECHECK_IDLE, state: 'running', total: ids.length, startedAt: this.now() };
    this.abort = new AbortController();
    this.deps.log.info({ total: ids.length }, 'Meta-Nachprüfung gestartet');
    this.running = this.work(ids, this.abort.signal)
      .catch((error) => {
        if (error instanceof CancelledError) return;
        this.deps.log.error({ err: error instanceof Error ? error.message : String(error) }, 'Meta-Nachprüfung fehlgeschlagen');
        this.finish('failed', 'Die Nachprüfung ist wegen eines unerwarteten Fehlers ausgefallen. Details stehen im Backend-Log.');
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    return this.status();
  }

  /** Wartet, bis die Nachprüfung fertig ist (Tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  close(): void {
    this.abort?.abort();
  }

  private async work(ids: string[], signal: AbortSignal): Promise<void> {
    const pauseMs = this.deps.pauseMs ?? 1_500;
    const limitWaitMs = this.deps.limitWaitMs ?? 60 * 60_000;
    for (let index = 0; index < ids.length; ) {
      const lead = this.deps.leads.get(ids[index]);
      // Inzwischen gelöscht oder von Hand eingetragen: zählt als geprüft, ohne Abfrage.
      if (!lead || lead.metaAds?.manual) {
        this.state.checked++;
        index++;
        continue;
      }
      const { hit, profile } = recheckInput(lead);
      try {
        const check = await this.deps.adapter.checkMetaAds(hit, profile, { signal, runId: 'meta-recheck', profile: DEFAULT_SEARCH_PROFILE });
        const saved = this.deps.leads.setCheckedMetaAds(lead.id, check, this.now());
        this.count(saved ? check : null);
      } catch (error) {
        if (error instanceof CancelledError || signal.aborted) throw new CancelledError();
        if (error instanceof AdapterError && error.code === 'rate_limit') {
          const minutes = Math.round(limitWaitMs / 60_000);
          this.state = { ...this.state, state: 'waiting', resumeAt: this.now() + limitWaitMs, message: META_RECHECK_MESSAGES.waiting(minutes) };
          this.deps.log.warn({ checked: this.state.checked, total: this.state.total }, 'Meta-Nachprüfung wartet auf das Meta-Limit');
          await sleep(limitWaitMs, signal);
          this.state = { ...this.state, state: 'running', resumeAt: null, message: null };
          continue; // derselbe Lead noch einmal
        }
        if (error instanceof AdapterError && error.fatal) {
          this.finish('failed', `${error.title}: ${error.message}`);
          return;
        }
        // Einzelner Lead nicht prüfbar (Netz, Meta-Fehler): weiter mit dem nächsten.
        this.deps.log.warn({ leadId: lead.id, err: error instanceof Error ? error.message : String(error) }, 'Meta-Nachprüfung: Lead nicht geprüft');
        this.state.checked++;
        this.state.unchecked++;
      }
      index++;
      if (pauseMs > 0 && index < ids.length) await sleep(pauseMs, signal);
    }
    this.finish('done', META_RECHECK_MESSAGES.done(this.state.checked));
  }

  private count(check: MetaAdsCheck | null): void {
    this.state.checked++;
    if (!check) return;
    if (check.state === 'active') this.state.active++;
    else if (check.state === 'stopped') this.state.stopped++;
    else if (check.state === 'none') this.state.none++;
    else this.state.unchecked++;
    if (check.source === 'person') this.state.byPerson++;
  }

  private finish(state: 'done' | 'failed', message: string): void {
    this.state = { ...this.state, state, finishedAt: this.now(), resumeAt: null, message };
    this.deps.log.info({ ...this.state }, 'Meta-Nachprüfung beendet');
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
