import { randomUUID } from 'node:crypto';
import {
  FINAL_STATUSES,
  clampMaxResults,
  isQualifyingCategory,
  MANUAL_QUALIFY_STATUSES,
  HANDOFF_STATUSES,
  metaAdsLabel,
  type EnrichedProfile,
  type MetaAdsCheck,
  type NewLeadCard,
  runSearchHits,
  type PipelineLead,
  type PrescreenVerdict,
  type Qualification,
  type RunError,
  type RunPhase,
  type RunSnapshot,
  type LeadStatus,
  type SearchHit,
  type StartRunRequest,
} from '../../../shared/leadSearch.js';
import { LEAD_STAGE_LABELS } from '../../../shared/leads.js';
import { uncheckedAds } from '../ads/metaAds.js';
import { scoreLead } from '../scoring/score.js';
import { detectHiring } from '../qualify/hiring.js';
import { quickQualify } from '../qualify/keywords.js';
import { LARGE_GROUP_REASON, applyTargetRules } from '../qualify/targetGroup.js';
import { companyKeys } from '../leads/companyKey.js';
import { QualificationValidationError, parseQualification } from '../qualify/schema.js';
import { trackingNote, type TrackingEntry } from '../tracking/tracking.js';
import type { AuthFounderId } from '../../../shared/auth.js';
import { AdapterError, CancelledError, type FounderNetwork, type LeadSearchAdapter, type RunContext } from './adapter.js';
import type { RunRecord, RunStore } from './runStore.js';
import type { SearchMemory } from './searchMemory.js';
import type { FeedbackSnapshot } from '../learning/learningStore.js';

/** Lead, der schon im Cockpit steht – für den Grund „Bereits im Cockpit · Nick · Angeschrieben“. */
export interface ExistingLead {
  owner: string;
  stage: string;
}

/** Lead derselben Firma im Cockpit – für „Gleiche Firma schon im Cockpit · Max Muster · Nick · Verloren“. */
export interface CompanyLead extends ExistingLead {
  person: string;
  company: string;
}

const FOUNDER_LABELS: Record<string, string> = { nick: 'Nick', johannes: 'Johannes' };

function companyNote(existing: CompanyLead, suffix = ''): string {
  const stage = (LEAD_STAGE_LABELS as Record<string, string>)[existing.stage] ?? existing.stage;
  return `Gleiche Firma schon im Cockpit · ${existing.person} · ${FOUNDER_LABELS[existing.owner] ?? existing.owner} · ${stage}${suffix}`;
}

function cockpitNote(existing: ExistingLead, suffix = ''): string {
  const stage = (LEAD_STAGE_LABELS as Record<string, string>)[existing.stage] ?? existing.stage;
  return `Bereits im Cockpit · ${FOUNDER_LABELS[existing.owner] ?? existing.owner} · ${stage}${suffix}`;
}

/** Urteil aus den Kontakten/Anfragen der übrigen Gründer-Accounts – null = dort unbekannt. */
interface NetworkVerdict {
  status: 'connected' | 'invited' | 'deferred';
  note: string;
}

/**
 * Ist die Person mit einem Gründer-Account vernetzt oder hat sie von dort eine offene Anfrage? Geprüft mit allen
 * Kennungen, die vorliegen (Provider-ID des Treffers und laut Profil, öffentliche Kennung). Konnte ein Account nicht
 * geprüft werden, gilt der Lead nicht als neu, sondern wird zurückgestellt (`deferred`) – lieber später als doppelt.
 */
export function networkVerdict(
  networks: readonly FounderNetwork[],
  ids: ReadonlyArray<string | null | undefined>,
  name: (founder: AuthFounderId) => string,
): NetworkVerdict | null {
  const keys = ids.map((id) => id?.trim().toLowerCase()).filter((id): id is string => Boolean(id));
  const ok = networks.filter((network) => !network.error);
  const connected = ok.find((network) => keys.some((key) => network.connected.has(key)));
  if (connected) return { status: 'connected', note: `Bereits vernetzt mit ${name(connected.founder)}` };
  const invited = ok.find((network) => keys.some((key) => network.invited.has(key)));
  if (invited) return { status: 'invited', note: `Vernetzungsanfrage von ${name(invited.founder)} bereits offen` };
  const failed = networks.find((network) => network.error);
  if (failed) {
    return {
      status: 'deferred',
      note: `Kontakte von ${name(failed.founder)} nicht prüfbar (${failed.error}) – beim nächsten Lauf dran`,
    };
  }
  return null;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export class RunBusyError extends Error {
  constructor(readonly runId: string) {
    super('Es läuft bereits eine Suche. Warte, bis sie fertig ist, oder brich sie ab.');
    this.name = 'RunBusyError';
  }
}

/** Mehr Treffer suchen als Profile abgerufen werden – der Dubletten-Filter sortiert einen Teil aus. */
export function searchTarget(maxResults: number): number {
  return Math.min(50, Math.max(20, maxResults * 2 + 10));
}

/** Höchstens so viele KI-Einschätzungen gleichzeitig. */
const QUALIFY_CONCURRENCY = 2;
/** KI-Vorprüfung: so viele Treffer je Anfrage, so viele Anfragen gleichzeitig. */
export const PRESCREEN_BATCH = 40;
const PRESCREEN_CONCURRENCY = 2;

/** Reihenfolge der Anreicherung: erst „passt vermutlich“, dann unklar – innerhalb gleich wie die Suche. */
const PRESCREEN_RANK = { likely: 0, maybe: 1, no: 2 } as const;
function prescreenRank(verdict: PrescreenVerdict | null | undefined): number {
  return verdict ? PRESCREEN_RANK[verdict.fit] : PRESCREEN_RANK.maybe;
}

/**
 * Die Pipeline – identisch für Simulation und Live-Betrieb:
 * 1. Suche (bis `searchHits` Treffer) → 2. Dubletten-Filter → 2b. KI-Vorprüfung anhand der Suchdaten (klar falsche
 * Branche/Region fliegt ohne Profilabruf raus, Wunsch des Kunden 11.10.) → 3. Profilabruf (max. `maxResults`, die
 * vielversprechendsten zuerst) → 4. KI-Qualifizierung → 4b. Meta-Werbebibliothek (aktive Ads werden markiert) → 5. Übergabe.
 */
export class PipelineRunner {
  /** Je Lauf: was beim Ende vor dem Ereignis „end“ passiert (`start(…, onEnd)`). */
  private readonly onEnd = new Map<string, (run: RunSnapshot) => void>();

  constructor(
    /** Mit `current()` (z. B. `AdapterRef`) gilt für jeden Lauf der Adapter vom Start – spätere Wechsel betreffen nur neue Läufe. */
    private readonly adapter: LeadSearchAdapter & { current?: () => LeadSearchAdapter },
    private readonly store: RunStore,
    private readonly options: {
      minConfidence: number | (() => number);
      /**
       * Suchtreffer pro Lauf (`SEARCH_HITS_PER_RUN`). Ohne Angabe wie früher `searchTarget(maxResults)`; nie weniger
       * als das, damit kleine Werte die Anreicherung nicht aushungern.
       */
      searchHits?: number | (() => number);
      log: Logger;
      /** Abgleich mit der hochgeladenen Outreach-Tracking-Liste. */
      tracking?: { lookup(hit: Pick<SearchHit, 'providerId' | 'publicIdentifier' | 'profileUrl'>): TrackingEntry | null };
      /** Abgleich mit den Leads in der Datenbank (Phase 2) – gilt unabhängig von dem, was der Browser schickt. */
      leads?: {
        findExisting(hit: { providerId: string; publicIdentifier?: string | null }): ExistingLead | null;
        /** Früher als „Verloren“ gelöscht (Datenschutz) – nie wieder vorschlagen. */
        wasDeleted?(hit: { providerId: string; publicIdentifier?: string | null }): boolean;
        /** Firmen im Cockpit nach `companyKeys` (27.10.: Firmen-Dubletten) – einmal je Lauf gelesen. */
        companyIndex?(): Map<string, CompanyLead>;
        /** Wurde ein Lead dieser Firma früher als „Verloren“ gelöscht? */
        companyWasDeleted?(company: { name?: string | null; website?: string | null }): boolean;
      };
      /** Anzeigename eines Gründers für Gründe wie „Bereits vernetzt mit Nick“ (Standard: Nick/Johannes). */
      founderName?: (id: AuthFounderId) => string;
      /** Vor jedem Profilabruf (alle Läufe) – zählt fürs Tageslimit des gemeinsamen Such-Accounts. Darf nicht werfen. */
      onProfileFetch?: () => void;
      /**
       * Suchgedächtnis (Wunsch des Nutzers 11.10.): geprüfte Profile aller Läufe zählen nicht mehr zur Trefferzahl, die
       * Suche blättert je Anfrage weiter, wo der letzte Lauf aufgehört hat, und ergiebige Anfragen kommen zuerst.
       */
      memory?: SearchMemory;
      /** Uhr fürs Suchgedächtnis (Tests). */
      now?: () => number;
      /** Stichwörter für die Qualifizierung ohne KI (`AUTO_QUALIFY_TERMS`, `qualify/keywords.ts`). */
      autoQualifyTerms?: () => readonly string[];
      /** KI-Kosten eines Laufs in Euro bisher – für die Kostengrenze (`start(…, { maxCostEur })`). Darf nicht werfen. */
      runCostEur?: (runId: string) => number;
      /**
       * Lernen aus Lead-Qualität (`shared/learning.ts`): Beispiele für die KI (einmal je Lauf) und „Qualifizieren“ von
       * Hand als 👍. Ohne: keine Beispiele (Tests).
       */
      learning?: {
        examples(): string | null;
        markQualified(providerId: string, snapshot: FeedbackSnapshot): void;
      };
    },
  ) {}

  /**
   * `limits.maxCostEur`: Kostengrenze für die KI in diesem Lauf (Tagesbudget der automatischen Suche) – ist sie erreicht,
   * liest der Lauf keine weiteren Profile, der Rest wird zurückgestellt (Warteliste, nächster Lauf).
   */
  start(request: StartRunRequest, limits: { maxCostEur?: number } = {}, onEnd?: (run: RunSnapshot) => void): RunSnapshot {
    const active = this.store.active();
    if (active) throw new RunBusyError(active.snapshot.id);

    const adapter = this.adapter.current ? this.adapter.current() : this.adapter;
    const snapshot: RunSnapshot = {
      id: randomUUID(),
      mode: adapter.mode,
      profile: { ...request.profile, maxResults: clampMaxResults(request.profile.maxResults) },
      status: 'running',
      phase: 'search',
      leads: [],
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      handedOff: false,
    };
    const record = this.store.add(snapshot);
    if (onEnd) this.onEnd.set(snapshot.id, onEnd);
    void this.execute(record, request, adapter, limits);
    return snapshot;
  }

  cancel(id: string): boolean {
    const record = this.store.get(id);
    if (!record || record.snapshot.status !== 'running') return false;
    record.controller.abort();
    return true;
  }

  /** Schritt 5: qualifizierte Leads (auch mit aktiven Meta-Ads, markiert) als Karte „Neuer Lead“. Mehrfach aufrufbar. */
  handoff(id: string): NewLeadCard[] | null {
    const record = this.store.get(id);
    if (!record) return null;
    const run = record.snapshot;
    run.handedOff = true;
    return run.leads.filter((lead) => HANDOFF_STATUSES.includes(lead.status)).map((lead) => toNewLeadCard(run, lead));
  }

  /**
   * Nach dem Lauf von Hand qualifizieren (Wunsch des Nutzers 12.10.): Der Lead gilt als `qualified` (`manual`) und geht
   * bei der Übergabe mit. Die Karte bekommt die Oberfläche zurück – war der Lauf schon übergeben, legt sie sie selbst an.
   */
  qualifyManually(
    runId: string,
    leadId: string,
  ): { run: RunSnapshot; lead: PipelineLead; card: NewLeadCard } | 'not_found' | 'running' | 'not_allowed' {
    const record = this.store.get(runId);
    const run = record?.snapshot;
    const lead = run?.leads.find((entry) => entry.id === leadId);
    if (!run || !lead) return 'not_found';
    if (run.status === 'running') return 'running';
    if (!MANUAL_QUALIFY_STATUSES.includes(lead.status)) return 'not_allowed';
    const before = lead.qualification;
    lead.qualification = before
      ? { ...before, qualified: true }
      : { qualified: true, category: 'sonstiges', confidence: 1, reason: 'Von Hand qualifiziert', summary: lead.prescreen?.reason ?? '' };
    lead.status = 'qualified';
    lead.manual = true;
    lead.note = 'Von Hand qualifiziert';
    this.store.emit(run.id, { type: 'leads', leads: [lead] });
    // Suchgedächtnis: nicht mehr auf der Warteliste, gilt als geprüft.
    const { memory, log } = this.options;
    if (memory && run.mode === 'live') {
      const now = (this.options.now ?? Date.now)();
      safely(() => memory.updateBacklog([lead.id], [], now), undefined, log, run.id);
      safely(() => memory.addChecked([lead.id], now), undefined, log, run.id);
    }
    // Lernen: Die KI lag hier daneben – das Profil wird ein „passt“-Beispiel (13.10., `shared/learning.ts`).
    const { learning } = this.options;
    if (learning && run.mode === 'live') {
      const profile = lead.profile;
      safely(
        () =>
          learning.markQualified(lead.id, {
            category: before?.category ?? null,
            headline: profile?.headline || lead.hit.headline || null,
            position: profile?.position ?? null,
            company: profile?.companyName ?? null,
            industry: profile?.companyIndustry ?? null,
            quickTerm: null,
          }),
        undefined,
        log,
        run.id,
      );
    }
    return { run, lead, card: toNewLeadCard(run, lead) };
  }

  /**
   * Schritt 2b: Treffer in Paketen vorprüfen. „no“ → `screened_out` (Endzustand, kein Profilabruf). Schlägt ein Paket
   * fehl (nicht fatal), bleiben seine Treffer ungeprüft im Rennen – lieber ein Profilabruf zu viel als ein Lead zu wenig.
   */
  private async prescreen(
    adapter: LeadSearchAdapter,
    leads: PipelineLead[],
    ctx: RunContext,
    update: (lead: PipelineLead, patch: Partial<PipelineLead>) => void,
    runId: string,
  ): Promise<void> {
    const batches: PipelineLead[][] = [];
    for (let start = 0; start < leads.length; start += PRESCREEN_BATCH) batches.push(leads.slice(start, start + PRESCREEN_BATCH));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        let verdicts: Map<string, PrescreenVerdict>;
        try {
          verdicts = await adapter.prescreen!(batch.map((lead) => lead.hit), ctx);
        } catch (error) {
          // Auch ein Anthropic-Limit bricht hier nicht ab: Ohne Vorprüfung geht es mit dem Profilabruf weiter.
          if (error instanceof AdapterError && (!error.fatal || error.code === 'rate_limit')) {
            this.options.log.warn({ runId, err: error.message, size: batch.length }, 'KI-Vorprüfung fehlgeschlagen – Treffer bleiben im Rennen');
            continue;
          }
          throw error;
        }
        for (const lead of batch) {
          const verdict = verdicts.get(lead.id);
          if (!verdict) continue;
          if (verdict.fit === 'no') update(lead, { prescreen: verdict, status: 'screened_out', note: `Vorprüfung: ${verdict.reason}` });
          else update(lead, { prescreen: verdict });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRESCREEN_CONCURRENCY, batches.length) }, worker));
  }

  /**
   * Nach jedem Lauf (auch von Hand, auch nach Abbruch): Profile mit Endergebnis ins Suchgedächtnis, Ertrag je
   * Suchanfrage nachtragen. Darf den Lauf nie scheitern lassen.
   */
  private remember(run: RunSnapshot, sources: ReadonlyMap<string, string>): void {
    const { memory, log } = this.options;
    if (!memory) return;
    const now = (this.options.now ?? Date.now)();
    safely(() => memory.addChecked(checkedIds(run), now), undefined, log, run.id);
    const stats = new Map<string, { likely: number; qualified: number }>();
    for (const lead of run.leads) {
      const key = sources.get(lead.id);
      if (!key) continue;
      const entry = stats.get(key) ?? { likely: 0, qualified: 0 };
      if (lead.prescreen?.fit === 'likely') entry.likely++;
      if (HANDOFF_STATUSES.includes(lead.status)) entry.qualified++;
      stats.set(key, entry);
    }
    safely(() => memory.addYield(stats, now), undefined, log, run.id);
    // Welche Anfrage welches Profil fand – Antworten und 👍/👎 kommen erst später und zählen dann für die Anfrage.
    safely(() => memory.addSources(new Map(run.leads.flatMap((lead) => (sources.has(lead.id) ? [[lead.id, sources.get(lead.id)!] as const] : []))), now), undefined, log, run.id);
    // Zurückgestellt (Limit, Kontakte nicht prüfbar, Abbruch) → Warteliste; alles mit Ergebnis raus aus ihr.
    const deferred = run.leads
      .filter((lead) => lead.status === 'deferred')
      .map((lead) => ({ hit: lead.hit, source: sources.get(lead.id) ?? null, prescreen: lead.prescreen ?? null }));
    const done = run.leads.filter((lead) => lead.status !== 'deferred').map((lead) => lead.id);
    safely(() => memory.updateBacklog(done, deferred, now), undefined, log, run.id);
  }

  private async execute(record: RunRecord, request: StartRunRequest, adapter: LeadSearchAdapter, limits: { maxCostEur?: number } = {}): Promise<void> {
    const run = record.snapshot;
    const { log, tracking, leads } = this.options;
    const minConfidence = typeof this.options.minConfidence === 'function' ? this.options.minConfidence() : this.options.minConfidence;
    // Eigener Controller: bricht bei Abbruch durch den Nutzer UND bei einem fatalen Fehler in der KI-Qualifizierung.
    const internal = new AbortController();
    record.controller.signal.addEventListener('abort', () => internal.abort(), { once: true });
    // Nur live: Die Simulation bewertet nach festen Regeln, Beispiele änderten nichts.
    const examples = adapter.mode === 'live' && this.options.learning ? safely(() => this.options.learning!.examples(), null, log, run.id) : null;
    const ctx: RunContext = { signal: internal.signal, runId: run.id, profile: run.profile, examples };
    let fatal: AdapterError | null = null;

    const emitLeads = (leads: PipelineLead[]) => {
      if (leads.length) this.store.emit(run.id, { type: 'leads', leads });
    };
    const update = (lead: PipelineLead, patch: Partial<PipelineLead>) => {
      Object.assign(lead, patch);
      emitLeads([lead]);
    };
    const setPhase = (phase: RunPhase) => {
      run.phase = phase;
      this.store.emit(run.id, { type: 'phase', phase });
    };
    // Welche Suchanfrage hat wen gefunden – für den Ertrag im Suchgedächtnis.
    const sources = new Map<string, string>();
    const addHits = (hits: SearchHit[], source?: string) => {
      if (source) for (const hit of hits) if (hit.providerId && !sources.has(hit.providerId)) sources.set(hit.providerId, source);
      const known = new Set(run.leads.map((lead) => lead.id));
      const added: PipelineLead[] = [];
      for (const hit of hits) {
        if (!hit.providerId || known.has(hit.providerId)) continue;
        known.add(hit.providerId);
        const lead: PipelineLead = {
          id: hit.providerId,
          hit,
          status: 'found',
          note: null,
          profile: null,
          qualification: null,
          metaAds: null,
        };
        run.leads.push(lead);
        added.push(lead);
      }
      emitLeads(added);
    };

    const queue = createQueue(QUALIFY_CONCURRENCY);
    log.info({ runId: run.id, mode: run.mode, profile: run.profile }, 'Lead-Suche gestartet');

    try {
      // Feste Unipile-Limits (17.10.): Haben alle Such-Accounts ihre Profilabrufe für heute verbraucht, gar nicht erst suchen.
      const profileCapacity = adapter.profileCapacity ? await adapter.profileCapacity(ctx) : Infinity;
      if (profileCapacity <= 0) {
        throw new AdapterError(
          'rate_limit',
          'Tageslimit aller LinkedIn-Accounts erreicht',
          'Jeder LinkedIn-Account hat heute schon so viele Profile abgerufen, wie Unipile empfiehlt. Morgen geht es weiter – mehr geht nur mit einem weiteren Account.',
          true,
        );
      }

      // ── 1. Suche ─────────────────────────────────────────────
      // Schon geprüfte Profile zählen nicht zur Trefferzahl – die Suche blättert dafür weiter (Obergrenzen im Adapter).
      // Nur live: Die Simulation bleibt bei jedem Lauf gleich (Vertrag: stabiler Trichter).
      const memory = adapter.mode === 'live' ? this.options.memory : undefined;
      const now = this.options.now ?? Date.now;
      const remembered = safely(() => memory?.checked(now()) ?? [], [], log, run.id);
      const skip = new Set([...request.checked, ...remembered]);
      const configuredHits = typeof this.options.searchHits === 'function' ? this.options.searchHits() : this.options.searchHits;
      // Wunsch des Nutzers 12.10.: die Einstellung gilt (mindestens Profile pro Lauf) – keine heimliche Verdopplung.
      const totalHits = configuredHits === undefined ? searchTarget(run.profile.maxResults) : runSearchHits(configuredHits, run.profile.maxResults);
      // Warteliste zuerst: im letzten Lauf zurückgestellte Treffer (Limit erreicht) – die Suche blättert an ihnen vorbei.
      // Höchstens so viele, wie der Lauf Treffer durchsieht – der Rest bleibt auf der Warteliste für den nächsten Lauf.
      const backlog = memory
        ? safely(() => memory.backlog(now()), [], log, run.id)
            .filter((entry) => !skip.has(entry.hit.providerId))
            .slice(0, totalHits)
        : [];
      for (const entry of backlog) addHits([entry.hit], entry.source ?? undefined);
      // Schon vorgeprüft (im Lauf, der sie zurückgestellt hat) – kostet nicht noch einmal.
      for (const entry of backlog) {
        const lead = entry.prescreen ? run.leads.find((candidate) => candidate.id === entry.hit.providerId) : undefined;
        if (lead) lead.prescreen = entry.prescreen;
      }
      if (backlog.length) log.info({ runId: run.id, backlog: backlog.length }, 'Suchgedächtnis: zurückgestellte Treffer zuerst');
      // Die Warteliste zählt mit: neu gesucht wird nur, was bis zur Trefferzahl fehlt – sonst wüchse sie mit jedem Lauf.
      const maxHits = Math.max(0, totalHits - backlog.length);
      run.searchPlan = { hits: totalHits, backlog: backlog.length, newHits: maxHits };
      this.store.emit(run.id, { type: 'run', run });
      const hits = maxHits > 0 ? await adapter.search(run.profile, { maxHits, onHits: addHits, skip, memory }, ctx) : [];
      if (remembered.length) log.info({ runId: run.id, remembered: remembered.length }, 'Suchgedächtnis: bereits geprüfte Profile zählen nicht');
      addHits(hits);

      // ── 2. Dubletten-Filter ──────────────────────────────────
      setPhase('dedupe');
      const pending = await adapter.pendingInvitations(ctx);
      for (const id of request.pendingInvitations) pending.add(id);
      // Kontakte und offene Anfragen der übrigen Gründer-Accounts (der Such-Account steckt in networkDistance/pending).
      const networkCheck = adapter.founderNetworks ? await adapter.founderNetworks(ctx) : { networks: [], warnings: [] };
      const { networks } = networkCheck;
      const founderName = (id: AuthFounderId) => this.options.founderName?.(id) ?? FOUNDER_LABELS[id] ?? id;
      for (const warning of networkCheck.warnings) log.warn({ runId: run.id, warning }, 'Hinweis zur Kontaktprüfung');
      for (const network of networks) {
        if (network.error) {
          log.warn({ runId: run.id, founder: network.founder, err: network.error }, 'Kontakte eines Gründer-Accounts nicht prüfbar – neue Leads zurückgestellt');
        }
      }
      const known = new Map(request.known.map((entry) => [entry.providerId, entry.owner]));
      // Firmen-Dubletten (27.10.): Firmen im Cockpit und in diesem Lauf schon qualifizierte Firmen – je Firma ein Lead.
      const cockpitCompanies = leads?.companyIndex ? safely(() => leads.companyIndex!(), new Map<string, CompanyLead>(), log, run.id) : new Map<string, CompanyLead>();
      const runCompanies = new Map<string, { id: string; name: string }>();
      const companyOf = (profile: EnrichedProfile) => companyKeys({ name: profile.companyName, website: profile.companyWebsite });
      const sameCompanyInCockpit = (profile: EnrichedProfile) => companyOf(profile).map((key) => cockpitCompanies.get(key)).find(Boolean) ?? null;
      const sameCompanyInRun = (profile: EnrichedProfile, self: string) =>
        companyOf(profile)
          .map((key) => runCompanies.get(key))
          .find((entry) => entry !== undefined && entry.id !== self)?.name ?? null;
      const checked = skip;

      for (const lead of run.leads) {
        await adapter.dedupeDelay(ctx);
        const { hit } = lead;
        const owner = known.get(hit.providerId);
        const existing = leads?.findExisting(hit) ?? null;
        const tracked = tracking?.lookup(hit) ?? null;
        if (owner !== undefined) {
          update(lead, { status: 'duplicate', note: owner ? `Bereits im Cockpit · ${owner}` : 'Bereits im Cockpit' });
        } else if (existing) {
          update(lead, { status: 'duplicate', note: cockpitNote(existing) });
        } else if (leads?.wasDeleted?.(hit)) {
          update(lead, { status: 'duplicate', note: 'Früher kein Interesse – Lead wurde gelöscht' });
        } else if (tracked) {
          update(lead, { status: 'duplicate', note: trackingNote(tracked) });
        } else if (checked.has(hit.providerId)) {
          update(lead, { status: 'duplicate', note: 'In einem früheren Lauf bereits geprüft' });
        } else if (hit.pendingInvitation || pending.has(hit.providerId) || (hit.publicIdentifier && pending.has(hit.publicIdentifier))) {
          update(lead, { status: 'invited', note: 'Vernetzungsanfrage bereits offen' });
        } else if (hit.networkDistance === 1) {
          update(lead, { status: 'connected', note: 'Bereits vernetzt' });
        } else {
          const verdict = networkVerdict(networks, [hit.providerId, hit.publicIdentifier], founderName);
          update(lead, verdict ?? { status: 'unique' });
        }
      }

      // ── 2b. KI-Vorprüfung (nur Suchdaten, kein LinkedIn-Aufruf) ──
      if (adapter.prescreen && adapter.canQualify) {
        const open = run.leads.filter((lead) => lead.status === 'unique' && !lead.prescreen);
        if (open.length) {
          setPhase('screen');
          await this.prescreen(adapter, open, ctx, update, run.id);
        }
      }

      // ── 3. Anreicherung + 4. KI-Qualifizierung ──────────────
      setPhase('enrich');
      const candidates = run.leads
        .filter((lead) => lead.status === 'unique')
        .map((lead, index) => ({ lead, index }))
        .sort((a, b) => prescreenRank(a.lead.prescreen) - prescreenRank(b.lead.prescreen) || a.index - b.index)
        .map(({ lead }) => lead);
      // Höchstens so viele Profile, wie die Such-Accounts heute noch dürfen (feste Unipile-Limits).
      const profileLimit = Math.min(run.profile.maxResults, profileCapacity);
      const selected = candidates.slice(0, profileLimit);
      const deferred = candidates.slice(profileLimit);
      for (const lead of deferred) {
        lead.status = 'deferred';
        lead.note =
          profileLimit < run.profile.maxResults
            ? 'Tageslimit der LinkedIn-Accounts erreicht – beim nächsten Lauf dran'
            : `Limit von ${run.profile.maxResults} Profilen pro Lauf erreicht – beim nächsten Lauf dran`;
      }
      emitLeads(deferred);

      // Meta-Ads sind nur Zusatzwissen für die Nachricht (Wunsch des Nutzers 12.10.: „wegen Meta soll keiner rausfliegen“):
      // Auch Token-, Rechte- oder Limitfehler brechen den Lauf nicht ab – ab dann bleibt Meta in diesem Lauf ungeprüft.
      let adsOff: string | null = adapter.canCheckAds ? null : 'META_ACCESS_TOKEN fehlt – Meta-Ads nicht geprüft';
      const checkAds = async (lead: PipelineLead): Promise<MetaAdsCheck> => {
        const companyName = lead.profile?.companyName ?? null;
        if (adsOff) return uncheckedAds(adsOff, companyName);
        try {
          return await adapter.checkMetaAds(lead.hit, lead.profile!, ctx);
        } catch (error) {
          if (error instanceof AdapterError) {
            if (error.fatal) {
              adsOff = `${error.title} – Meta-Ads in diesem Lauf nicht geprüft`;
              log.warn({ runId: run.id, err: error.message }, 'Meta-Werbebibliothek: Lauf geht ohne Meta-Prüfung weiter');
              return uncheckedAds(adsOff, companyName);
            }
            log.warn({ runId: run.id, lead: lead.id, err: error.message }, 'Meta-Ads nicht geprüft');
            return uncheckedAds(error.message, companyName);
          }
          throw error;
        }
      };
      const qualifyLead = async (lead: PipelineLead, preset: Qualification | null = null) => {
        if (internal.signal.aborted || !lead.profile) return;
        update(lead, { status: 'qualifying' });
        try {
          // Eindeutiger Fall per Stichwort: kein KI-Aufruf (spart Kosten), dieselbe Mindestsicherheit.
          const graded = preset
            ? { ...preset, qualified: preset.qualified && preset.confidence >= minConfidence }
            : parseQualification(await adapter.qualify(lead.hit, lead.profile, ctx), minConfidence);
          if (internal.signal.aborted) return;
          // Zielgruppe 27.10.: Konzerne und große Strukturvertriebe nie (feste Liste, zusätzlich zur KI).
          const rated = applyTargetRules(lead.hit, lead.profile, graded);
          // Hiring-Signal (13.10.): Stichwort im Profil (mit Beleg) vor der Einschätzung der KI.
          const hiring = detectHiring(lead.hit, lead.profile) ?? rated.hiring ?? null;
          const qualification: Qualification = hiring ? { ...rated, hiring } : rated;
          if (!qualification.qualified) {
            update(lead, { qualification, status: 'rejected', note: rejectionNote(qualification, minConfidence), score: scoreOf(lead, qualification, null) });
            return;
          }
          // Firmen-Dubletten (27.10.): Je Firma nur ein Lead pro Lauf – der zuerst qualifizierte zählt.
          const sibling = sameCompanyInRun(lead.profile, lead.id);
          if (sibling) {
            update(lead, { qualification, status: 'duplicate', note: `Gleiche Firma schon in diesem Lauf · ${sibling}` });
            return;
          }
          const name = `${lead.hit.firstName} ${lead.hit.lastName}`.trim();
          for (const key of companyOf(lead.profile)) if (!runCompanies.has(key)) runCompanies.set(key, { id: lead.id, name });
          // ── 4b. Meta-Werbebibliothek ──
          update(lead, { qualification, status: 'checking_ads' });
          const metaAds = await checkAds(lead);
          if (internal.signal.aborted) return;
          update(lead, {
            metaAds,
            score: scoreOf(lead, qualification, metaAds),
            status: metaAds.state === 'active' ? 'ads_active' : 'qualified',
            note: metaAds.state === 'active' || metaAds.state === 'unchecked' ? (metaAds.note ?? metaAdsLabel(metaAds)) : null,
          });
        } catch (error) {
          if (error instanceof CancelledError || internal.signal.aborted) return;
          if (error instanceof AdapterError && error.fatal) {
            fatal ??= error;
            internal.abort();
            return;
          }
          const note =
            error instanceof QualificationValidationError
              ? 'KI-Ausgabe ungültig – Lead nicht bewertet'
              : error instanceof AdapterError
                ? error.message
                : 'KI-Einschätzung fehlgeschlagen';
          log.warn({ runId: run.id, lead: lead.id, err: String(error) }, 'Qualifizierung fehlgeschlagen');
          update(lead, { status: 'failed', note });
        }
      };
      const overBudget = () => {
        if (limits.maxCostEur === undefined || !this.options.runCostEur) return false;
        try {
          return this.options.runCostEur(run.id) >= limits.maxCostEur;
        } catch {
          return false;
        }
      };
      for (const [index, lead] of selected.entries()) {
        // Tagesbudget für die KI erreicht → keine weiteren Profile; laufende Einschätzungen schließen noch ab.
        if (overBudget()) {
          const rest = selected.slice(index);
          for (const open of rest) {
            open.status = 'deferred';
            open.note = 'KI-Tagesbudget erreicht – beim nächsten Lauf dran';
          }
          emitLeads(rest);
          log.info({ runId: run.id, maxCostEur: limits.maxCostEur, deferred: rest.length }, 'Lead-Suche: KI-Tagesbudget erreicht');
          break;
        }
        if (index > 0) await adapter.pauseBeforeProfile(ctx);
        update(lead, { status: 'enriching' });
        try {
          try {
            this.options.onProfileFetch?.();
          } catch (error) {
            log.warn({ runId: run.id, err: String(error) }, 'Profilabruf nicht gezählt');
          }
          const result = await adapter.enrich(lead.hit, ctx);
          // Zweiter Abgleich mit Datenbank und Tracking-Liste – das Profil liefert die öffentliche Kennung sicher mit.
          const existingLate = result.publicIdentifier
            ? (leads?.findExisting({ providerId: lead.hit.providerId, publicIdentifier: result.publicIdentifier }) ?? null)
            : null;
          const trackedLate = result.publicIdentifier
            ? (tracking?.lookup({ providerId: lead.hit.providerId, publicIdentifier: result.publicIdentifier, profileUrl: null }) ?? null)
            : null;
          const deletedLate = result.publicIdentifier
            ? (leads?.wasDeleted?.({ providerId: lead.hit.providerId, publicIdentifier: result.publicIdentifier }) ?? false)
            : false;
          // Sales-Navigator-Treffer tragen eine andere ID – erst das Profil liefert Provider-ID und öffentliche Kennung.
          const lateVerdict = networkVerdict(
            networks.filter((network) => !network.error),
            [lead.hit.providerId, lead.hit.publicIdentifier, result.providerId, result.publicIdentifier],
            founderName,
          );
          const companyLead = sameCompanyInCockpit(result.profile);
          const companyDeleted = !companyLead && !!leads?.companyWasDeleted?.({ name: result.profile.companyName, website: result.profile.companyWebsite });
          const companyInRun = sameCompanyInRun(result.profile, lead.id);
          if (existingLate) {
            update(lead, { status: 'duplicate', note: cockpitNote(existingLate, ' (im Profil erkannt)'), profile: result.profile });
          } else if (deletedLate) {
            update(lead, { status: 'duplicate', note: 'Früher kein Interesse – Lead wurde gelöscht', profile: result.profile });
          } else if (trackedLate) {
            update(lead, { status: 'duplicate', note: `${trackingNote(trackedLate)} (im Profil erkannt)`, profile: result.profile });
          } else if (companyLead) {
            update(lead, { status: 'duplicate', note: companyNote(companyLead), profile: result.profile });
          } else if (companyDeleted) {
            update(lead, { status: 'duplicate', note: 'Gleiche Firma früher ohne Interesse – Lead wurde gelöscht', profile: result.profile });
          } else if (companyInRun) {
            update(lead, { status: 'duplicate', note: `Gleiche Firma schon in diesem Lauf · ${companyInRun}`, profile: result.profile });
          } else if (
            result.pendingInvitation ||
            (result.providerId && pending.has(result.providerId)) ||
            (result.publicIdentifier && pending.has(result.publicIdentifier))
          ) {
            update(lead, { status: 'invited', note: 'Vernetzungsanfrage bereits offen (im Profil erkannt)', profile: result.profile });
          } else if (result.networkDistance === 1) {
            update(lead, { status: 'connected', note: 'Bereits vernetzt (im Profil erkannt)', profile: result.profile });
          } else if (lateVerdict) {
            update(lead, { status: lateVerdict.status, note: `${lateVerdict.note} (im Profil erkannt)`, profile: result.profile });
          } else {
            // Nur live: Die Simulation behält ihren festen Trichter (Vertrag), ihre KI-Ausgaben sind vorgegeben.
            const quick = adapter.mode === 'live' ? quickQualify(lead.hit, result.profile, this.options.autoQualifyTerms?.() ?? []) : null;
            if (quick) {
              update(lead, { status: 'enriched', profile: result.profile });
              queue.push(() => qualifyLead(lead, quick));
            } else if (adapter.canQualify) {
              update(lead, { status: 'enriched', profile: result.profile });
              queue.push(() => qualifyLead(lead));
            } else {
              update(lead, { status: 'unrated', note: 'ANTHROPIC_API_KEY fehlt', profile: result.profile });
            }
          }
        } catch (error) {
          if (error instanceof AdapterError && !error.fatal) {
            log.warn({ runId: run.id, lead: lead.id, err: error.message }, 'Profil nicht abrufbar');
            update(lead, { status: 'failed', note: error.message });
            continue;
          }
          throw error;
        }
      }
      await queue.drain();
      if (fatal) throw fatal;
      if (internal.signal.aborted) throw new CancelledError();

      setPhase('done');
      run.status = 'done';
    } catch (error) {
      const failure = fatal ?? error;
      if (failure instanceof AdapterError && !fatal && !record.controller.signal.aborted) {
        // Fehler bei Suche/Profilabruf: laufende KI-Einschätzungen noch abschließen – sie belasten LinkedIn nicht.
        await queue.drain();
      }
      // Ab hier läuft nichts mehr im Hintergrund weiter.
      internal.abort();
      if (failure instanceof AdapterError) {
        run.status = 'failed';
        run.error = { code: failure.code, title: failure.title, message: failure.message };
        log.warn({ runId: run.id, code: failure.code, err: failure.message }, 'Lead-Suche abgebrochen');
      } else if (failure instanceof CancelledError || record.controller.signal.aborted) {
        run.status = 'cancelled';
      } else {
        run.status = 'failed';
        run.error = unexpectedError();
        log.error({ runId: run.id, err: failure instanceof Error ? failure.stack : String(failure) }, 'Unerwarteter Fehler');
      }
      // Was nicht mehr bearbeitet wurde, bekommt einen klaren Endzustand.
      const touched: PipelineLead[] = [];
      // Tageslimit beim Profil oder der Firmenseite (02.11.): der angefangene Lead wartet auf den nächsten Lauf (morgen)
      // und wird dann ganz gelesen – nie ohne Firmenseite.
      const limitHit = failure instanceof AdapterError && failure.code === 'rate_limit';
      for (const lead of run.leads) {
        if (FINAL_STATUSES.includes(lead.status)) continue;
        const inFlight = (lead.status === 'enriching' && !limitHit) || lead.status === 'qualifying' || lead.status === 'checking_ads';
        lead.status = inFlight ? 'failed' : 'deferred';
        lead.note =
          run.status === 'cancelled'
            ? 'Lauf abgebrochen'
            : limitHit
              ? 'Tageslimit erreicht – beim nächsten Lauf dran'
              : 'Nicht mehr bearbeitet – Lauf abgebrochen';
        touched.push(lead);
      }
      emitLeads(touched);
    } finally {
      run.finishedAt = Date.now();
      // KI-Kosten des Laufs – für „Preis je Lead“ im Ergebnis.
      const cost = this.options.runCostEur ? safely(() => this.options.runCostEur!(run.id), 0, log, run.id) : 0;
      run.costEur = Math.round(cost * 10_000) / 10_000;
      if (adapter.mode === 'live') this.remember(run, sources);
      log.info({ runId: run.id, status: run.status, ms: run.finishedAt - run.startedAt }, 'Lead-Suche beendet');
      // Vor dem Ereignis „end“ (z. B. Leads speichern, `run.saved`) – das Ereignis trägt dann schon das Ergebnis.
      const onEnd = this.onEnd.get(run.id);
      this.onEnd.delete(run.id);
      if (onEnd) safely(() => onEnd(run), undefined, log, run.id);
      this.store.emit(run.id, { type: 'end', run });
    }
  }
}

/**
 * Kurzer Grund fürs Aussortieren (Wunsch des Nutzers 07.10.: nicht „Makler“ oder „Sonstige“, sondern klar sagen, dass
 * die Branche nicht passt). Die erkannte Kategorie und die Begründung der KI stehen in den Details.
 */
function rejectionNote(qualification: Qualification, minConfidence: number): string {
  if (!isQualifyingCategory(qualification.category)) return 'Falsche Branche';
  if (qualification.reason.startsWith(LARGE_GROUP_REASON)) return 'Zu groß (Konzern)';
  if (qualification.confidence < minConfidence) return `Einschätzung zu unsicher (${Math.round(qualification.confidence * 100)} %)`;
  return 'Passt laut KI nicht';
}

function unexpectedError(): RunError {
  return {
    code: 'unknown',
    title: 'Unerwarteter Fehler',
    message: 'Die Suche wurde wegen eines unerwarteten Fehlers abgebrochen. Details stehen im Backend-Log.',
  };
}

export function toNewLeadCard(run: RunSnapshot, lead: PipelineLead): NewLeadCard {
  const { hit, qualification } = lead;
  if (!qualification) throw new Error(`Lead ${lead.id} ist nicht vollständig qualifiziert`);
  // Von Hand qualifiziert ohne Profilabruf: nur Daten aus der Suche.
  const profile = lead.profile ?? (lead.manual ? { headline: hit.headline, position: null, companyName: null, location: null, companyWebsite: null } : null);
  if (!profile) throw new Error(`Lead ${lead.id} ist nicht vollständig qualifiziert`);
  return {
    runId: run.id,
    mode: run.mode,
    providerId: hit.providerId,
    publicIdentifier: hit.publicIdentifier,
    profileUrl: hit.profileUrl,
    firstName: hit.firstName,
    lastName: hit.lastName,
    headline: profile.headline || hit.headline,
    position: profile.position ?? hit.headline,
    company: profile.companyName ?? '',
    location: profile.location ?? hit.location,
    website: profile.companyWebsite,
    networkDistance: hit.networkDistance,
    category: qualification.category,
    confidence: qualification.confidence,
    reason: lead.manual ? `Von Hand qualifiziert${qualification.reason && qualification.reason !== 'Von Hand qualifiziert' ? ` – KI: ${qualification.reason}` : ''}` : qualification.reason,
    summary: qualification.summary,
    metaAds: lead.metaAds,
    score: lead.score ?? null,
    hiring: qualification.hiring ?? detectHiring(hit, lead.profile),
  };
}

/** Scoring v1 aus den Daten der Lead-Suche. */
function scoreOf(lead: PipelineLead, qualification: Qualification, metaAds: MetaAdsCheck | null) {
  return scoreLead({
    category: qualification.category,
    confidence: qualification.confidence,
    qualified: qualification.qualified,
    position: lead.profile?.position ?? null,
    headline: lead.profile?.headline || lead.hit.headline,
    location: lead.profile?.location ?? lead.hit.location,
    website: lead.profile?.companyWebsite ?? null,
    metaAds,
  });
}

/** Endergebnisse, nach denen ein Profil nicht noch einmal abgerufen werden muss. */
const CHECKED_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>(['qualified', 'ads_active', 'rejected', 'duplicate', 'invited', 'connected']);

/**
 * Provider-IDs, für die dieser Lauf ein Endergebnis hat: Profil abgerufen und entschieden – oder von der KI-Vorprüfung
 * aussortiert (`screened_out`, ohne Profil). So sieht die nächste Suche nicht dieselben Headlines wieder durch.
 */
export function checkedIds(run: Pick<RunSnapshot, 'leads'>): string[] {
  return run.leads
    .filter((lead) => lead.status === 'screened_out' || (lead.profile && CHECKED_STATUSES.has(lead.status)))
    .map((lead) => lead.id);
}

/** Suchgedächtnis ist Beiwerk: Ein Datenbankfehler wird geloggt, der Lauf geht weiter. */
function safely<T>(work: () => T, fallback: T, log: Logger, runId: string): T {
  try {
    return work();
  } catch (error) {
    log.warn({ runId, err: error instanceof Error ? error.message : String(error) }, 'Suchgedächtnis nicht verfügbar');
    return fallback;
  }
}

/** Kleine Warteschlange mit begrenzter Parallelität. */
function createQueue(concurrency: number) {
  const waiting: Array<() => Promise<void>> = [];
  const running = new Set<Promise<void>>();
  const next = () => {
    while (running.size < concurrency && waiting.length) {
      const task = waiting.shift()!;
      const promise: Promise<void> = task().finally(() => {
        running.delete(promise);
        next();
      });
      running.add(promise);
    }
  };
  return {
    push(task: () => Promise<void>) {
      waiting.push(task);
      next();
    },
    async drain() {
      while (running.size || waiting.length) await Promise.race(running);
    },
  };
}
