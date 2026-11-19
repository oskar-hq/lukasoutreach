import { AI_PURPOSE_LABELS, type AiPurpose } from '../../../shared/dashboard.js';
import { FINAL_STATUSES, HANDOFF_STATUSES, type RunSnapshot } from '../../../shared/leadSearch.js';
import { LEAD_FEEDBACK_REASON_LABELS, type LeadFeedbackReason, type LearningEfficiency } from '../../../shared/learning.js';
import { LEAD_STAGES, LEAD_STAGE_LABELS, type LeadStage } from '../../../shared/leads.js';
import type { Database } from '../db/database.js';
import { USAGE_SOURCE_LABELS, type UsageSource } from '../linkedin/accountUsage.js';

/**
 * Optimierungs-Bericht (Wunsch des Nutzers 09.11.: „ganz viel mehr tracken, als MD-Datei runterladen und Claude
 * geben“, Vertrag `shared/learning.ts` → `GET /api/learning/report`).
 *
 * - `recordRun` hält nach jedem Lauf den Trichter (`search_runs`) und je Treffer fest, wie weit er kam und warum
 *   (`search_decisions`) – ohne Namen und Profil-Links, `DECISIONS_KEEP_DAYS` Tage.
 * - `buildReport` setzt daraus und aus den vorhandenen Tabellen (KI-Kosten seit 11.10., Suchgedächtnis,
 *   Account-Zähler seit 17.10., Rückmeldungen seit 13.10., Leads) eine Markdown-Datei zusammen. Vieles gilt damit
 *   rückwirkend; Trichter je Lauf, Entscheidungen je Treffer und Modellvergleich erst ab dem Update.
 */
export const DECISIONS_KEEP_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

export class InsightsStore {
  constructor(
    private readonly db: Database,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Nach jedem Lauf. Wirft nicht nach außen weiter – der Runner fängt trotzdem (`safely`). */
  recordRun(run: RunSnapshot, sources: ReadonlyMap<string, string>, info: { auto: boolean; founder: string | null }): void {
    const { auto, founder } = info;
    const now = this.now();
    const leads = run.leads;
    const count = (test: (status: string) => boolean) => leads.filter((lead) => test(lead.status)).length;
    const costUsd = (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM ai_usage WHERE run_id = ?').get(run.id) as { usd: number }).usd;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO search_runs (id, started_at, finished_at, mode, status, error_code, auto, max_results, leads, screened_out,
             profiles, qualified, rejected, deferred, cost_usd, founder, keywords, positions, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.startedAt,
          run.finishedAt ?? now,
          run.mode,
          run.status,
          run.error?.code ?? null,
          auto ? 1 : 0,
          run.profile.maxResults ?? null,
          leads.length,
          count((status) => status === 'screened_out'),
          leads.filter((lead) => lead.profile).length,
          count((status) => (HANDOFF_STATUSES as readonly string[]).includes(status)),
          count((status) => status === 'rejected'),
          count((status) => status === 'deferred'),
          costUsd,
          founder,
          clip(run.profile.keywords.join(', '), 300),
          clip(run.profile.positions.join(', '), 300),
          run.error ? clip(`${run.error.title}: ${run.error.message}`, 400) : null,
        );
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO search_decisions (run_id, provider_id, at, query_key, status, prescreen_fit, prescreen_reason, profile_fetched,
           category, confidence, qualified, reason, note, headline, position, industry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const lead of leads) {
        // Nur Treffer, die über den Dubletten-Filter hinaus kamen oder dort hängen blieben – alles mit Endzustand.
        if (!(FINAL_STATUSES as readonly string[]).includes(lead.status)) continue;
        const q = lead.qualification;
        insert.run(
          run.id,
          lead.id,
          now,
          sources.get(lead.id) ?? null,
          lead.status,
          lead.prescreen?.fit ?? null,
          clip(lead.prescreen?.reason, 200),
          lead.profile ? 1 : 0,
          q?.category ?? null,
          q?.confidence ?? null,
          q ? (q.qualified ? 1 : 0) : null,
          clip(q?.reason, 300),
          clip(lead.note, 160),
          clip(lead.hit.headline, 200),
          clip(lead.profile?.position ?? null, 120),
          clip(lead.profile?.companyIndustry ?? null, 80),
        );
      }
      this.db.prepare('DELETE FROM search_decisions WHERE at < ?').run(now - DECISIONS_KEEP_DAYS * DAY_MS);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Profilabrufe aller Accounts gegen qualifizierte Leads aus der Lead-Suche in den letzten `days` Tagen. */
  efficiency(days: number, dayOf: (at: number) => string): LearningEfficiency {
    const now = this.now();
    const fromDay = dayOf(now - (days - 1) * DAY_MS);
    const profileFetches = (
      this.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM linkedin_account_usage WHERE kind = 'profile' AND day >= ?").get(fromDay) as { n: number }
    ).n;
    const qualified = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND json_extract(origin, '$.kind') = 'search'")
        .get(now - days * DAY_MS) as { n: number }
    ).n;
    return { days, profileFetches, qualified, perQualified: qualified > 0 ? Math.round((profileFetches / qualified) * 10) / 10 : null };
  }
}

// ── Bericht ──────────────────────────────────────────────────────────────────

export interface ReportOptions {
  now: number;
  days: number;
  timeZone: string;
  usdToEur: number;
  mode: string;
  /** Wirksame Einstellungen, die für Kosten und Suche zählen: [Name, Wert]. */
  settings: Array<[string, string]>;
  /** Unipile-Account-ID → lesbarer Name (z. B. „Nick (Gründer)“). */
  accountName: (accountId: string) => string;
  efficiency: LearningEfficiency;
}

/** Zelle einer Markdown-Tabelle: eine Zeile, ohne senkrechte Striche, gekürzt. */
function cell(value: unknown, max = 140): string {
  if (value === null || value === undefined || value === '') return '–';
  const text = String(value).replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? (text.length > max ? `${text.slice(0, max)}…` : text) : null;
}

export function table(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return '_Keine Daten._';
  const align = headers.map(() => '---');
  return [`| ${headers.join(' | ')} |`, `| ${align.join(' | ')} |`, ...rows.map((row) => `| ${row.map((value) => cell(value)).join(' | ')} |`)].join('\n');
}

const pct = (part: number, whole: number) => (whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toLocaleString('de-DE')} %` : '–');
const int = (value: number) => Math.round(value).toLocaleString('de-DE');
const eur = (value: number) => `${(Math.round(value * 10_000) / 10_000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} €`;

export function dayFormatter(timeZone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (at) => format.format(new Date(at));
}

export function dateTimeFormatter(timeZone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (at) => format.format(new Date(at));
}

const purposeLabel = (purpose: string) => AI_PURPOSE_LABELS[purpose as AiPurpose] ?? purpose;

export function buildReport(db: Database, options: ReportOptions): string {
  const { now, days, usdToEur } = options;
  const day = dayFormatter(options.timeZone);
  const dateTime = dateTimeFormatter(options.timeZone);
  const from = now - days * DAY_MS;
  const fromDay = day(now - (days - 1) * DAY_MS);
  const all = <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).all(...params) as unknown as T[];
  const one = <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).get(...params) as unknown as T;
  const firstAt = (sql: string) => one<{ at: number | null }>(sql).at;
  const since = (at: number | null) => (at ? day(at) : 'noch keine');
  const out: string[] = [];
  const section = (title: string, ...lines: string[]) => out.push(`\n## ${title}\n`, ...lines);

  // ── Kopf ──
  out.push(
    `# Optimierungs-Bericht Outreach-Cockpit`,
    '',
    `Erstellt: ${dateTime(now)} (${options.timeZone}) · Zeitraum: letzte ${days} Tage (ab ${fromDay}) · Betrieb: ${options.mode === 'live' ? 'echt' : 'Simulation'}`,
    '',
    '> Für Claude: Dieser Bericht enthält Rohzahlen aus dem Cockpit (ohne Namen und Profil-Links), damit du Vorschläge machen',
    '> kannst, wie die LinkedIn-Suche mit weniger Abrufen auskommt (Accounts schützen), welche KI-Aufgabe welches Modell',
    '> braucht (Kosten) und wie die Einstufung genauer wird. Kosten sind Schätzungen nach Listenpreis',
    `> (1 $ = ${usdToEur.toLocaleString('de-DE')} €). Zahlen „seit Beginn“ gelten ab dem jeweils genannten Datum.`,
  );

  section(
    'Datenstand – seit wann es welche Zahlen gibt',
    table(
      ['Daten', 'seit'],
      [
        ['KI-Aufrufe mit Modell und Token', since(firstAt('SELECT MIN(at) AS at FROM ai_usage'))],
        ['Rückmeldungen (passt / passt nicht)', since(firstAt('SELECT MIN(at) AS at FROM lead_feedback'))],
        ['LinkedIn-Abrufe je Account und Tag (Zähler fürs Limit, nur 14 Tage)', (one<{ day: string | null }>('SELECT MIN(day) AS day FROM linkedin_account_usage').day ?? 'noch keine')],
        ['LinkedIn-Abrufe je Zweck (Lead-Suche, neue Kontakte, Aufwärmen)', (one<{ day: string | null }>('SELECT MIN(day) AS day FROM linkedin_usage_log').day ?? 'noch keine')],
        ['Trichter je Lauf', since(firstAt('SELECT MIN(started_at) AS at FROM search_runs'))],
        ['Entscheidung je Treffer (Vorprüfung, Profil, Einstufung)', since(firstAt('SELECT MIN(at) AS at FROM search_decisions'))],
        ['Modellvergleich', since(firstAt('SELECT MIN(at) AS at FROM ai_shadow'))],
        ['Leads im Cockpit', since(firstAt('SELECT MIN(created_at) AS at FROM leads'))],
      ],
    ),
  );

  section('Einstellungen (wirksam)', table(['Einstellung', 'Wert'], options.settings));

  // ── KI-Kosten ──
  type UsageRow = { purpose: string; model: string; calls: number; input: number; output: number; cache_read: number; cache_write: number; usd: number; first: number; last: number };
  const usageSql = `SELECT purpose, model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read,
      SUM(cache_write) AS cache_write, SUM(cost_usd) AS usd, MIN(at) AS first, MAX(at) AS last FROM ai_usage WHERE at >= ? GROUP BY purpose, model ORDER BY usd DESC`;
  const usageRows = (rows: UsageRow[]) =>
    rows.map((row) => [
      purposeLabel(row.purpose),
      row.model,
      int(row.calls),
      int(row.input),
      int(row.output),
      pct(row.cache_read, row.input + row.cache_read + row.cache_write),
      eur(row.usd * usdToEur),
      eur((row.usd * usdToEur) / Math.max(1, row.calls)),
      `${day(row.first)} – ${day(row.last)}`,
    ]);
  const usageHeaders = ['Zweck', 'Modell', 'Aufrufe', 'Input-Token', 'Output-Token', 'aus Cache', 'Kosten', 'je Aufruf', 'genutzt'];
  section(
    'KI-Kosten je Zweck und Modell',
    `### Letzte ${days} Tage`,
    '',
    table(usageHeaders, usageRows(all<UsageRow>(usageSql, from))),
    '',
    '### Seit Beginn (zeigt auch, wann welches Modell lief)',
    '',
    table(usageHeaders, usageRows(all<UsageRow>(usageSql, 0))),
  );
  const perDay = new Map<string, number>();
  for (const row of all<{ at: number; usd: number }>('SELECT at, cost_usd AS usd FROM ai_usage WHERE at >= ?', from)) {
    perDay.set(day(row.at), (perDay.get(day(row.at)) ?? 0) + row.usd * usdToEur);
  }
  out.push('', '### Je Tag', '', table(['Tag', 'Kosten'], [...perDay].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => [key, eur(value)])));

  // ── Läufe ──
  type RunRow = { run_id: string; at: number; calls: number; usd: number; prescreen: number; qualify: number; models: string };
  const runCosts = new Map(
    all<RunRow>(
      `SELECT run_id, MIN(at) AS at, COUNT(*) AS calls, SUM(cost_usd) AS usd,
         SUM(CASE WHEN purpose = 'prescreen' THEN 1 ELSE 0 END) AS prescreen, SUM(CASE WHEN purpose = 'qualify' THEN 1 ELSE 0 END) AS qualify,
         GROUP_CONCAT(DISTINCT model) AS models
       FROM ai_usage WHERE run_id IS NOT NULL AND at >= ? GROUP BY run_id`,
      from,
    ).map((row) => [row.run_id, row]),
  );
  type SearchRunRow = {
    id: string; auto: number; status: string; error_code: string | null; error_message: string | null; founder: string | null; keywords: string | null;
    leads: number; screened_out: number; profiles: number; qualified: number; rejected: number; deferred: number; max_results: number | null; finished_at: number; started_at: number;
  };
  const runInfo = new Map(all<SearchRunRow>('SELECT * FROM search_runs WHERE started_at >= ?', from).map((row) => [row.id, row]));
  const createdByRun = new Map(
    all<{ run: string; n: number }>("SELECT json_extract(origin, '$.runId') AS run, COUNT(*) AS n FROM leads WHERE json_extract(origin, '$.kind') = 'search' AND created_at >= ? GROUP BY run", from).map((row) => [row.run, row.n]),
  );
  // Alle Läufe: mit Trichter (ab dem Update) und solche, die nur KI-Kosten haben (älter, oder „neue Kontakte“ je Tag).
  const runIds = [...new Set([...runInfo.keys(), ...runCosts.keys()])]
    .map((id) => ({ id, at: runInfo.get(id)?.started_at ?? runCosts.get(id)!.at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 120);
  const kindOf = (id: string, info: SearchRunRow | undefined) =>
    id.startsWith('neue-kontakte-') ? 'neue Kontakte (Tag)' : info ? (info.auto ? 'automatisch' : 'von Hand') : '–';
  section(
    'Läufe der Lead-Suche',
    'KI-Kosten je Lauf gibt es rückwirkend; Trichter (Treffer → Vorprüfung → Profil → qualifiziert), Gründer, Suchbegriffe und Fehler erst ab dem Update mit diesem Bericht. „Profile abgerufen“ ohne Firmenseiten (je Lead meist noch eine).',
    '',
    table(
      ['Start', 'Art', 'Gründer', 'Status', 'Treffer geprüft', 'Vorprüfung raus', 'Profile abgerufen', 'qualifiziert', 'abgelehnt', 'zurückgestellt', 'Leads angelegt', 'KI-Aufrufe (Vorpr./Einst.)', 'Kosten', 'je Lead', 'Modelle', 'Dauer', 'Suchbegriffe', 'Fehler'],
      runIds.map(({ id, at }) => {
        const info = runInfo.get(id);
        const cost = runCosts.get(id);
        const created = createdByRun.get(id) ?? 0;
        const eurCost = (cost?.usd ?? 0) * usdToEur;
        return [
          dateTime(at),
          kindOf(id, info),
          info?.founder ?? '–',
          info ? `${info.status}${info.error_code ? ` (${info.error_code})` : ''}` : '–',
          info?.leads ?? '–',
          info?.screened_out ?? '–',
          info?.profiles ?? '–',
          info?.qualified ?? '–',
          info?.rejected ?? '–',
          info?.deferred ?? '–',
          created,
          cost ? `${cost.prescreen}/${cost.qualify}` : '0/0',
          eur(eurCost),
          created ? eur(eurCost / created) : '–',
          cost?.models ?? '–',
          info ? `${Math.round((info.finished_at - info.started_at) / 60_000)} min` : '–',
          info?.keywords ?? '–',
          info?.error_message ?? '–',
        ];
      }),
    ),
  );

  // ── Automatische Suche je Tag ──
  const autoDays = new Map<string, { runs: number; failed: number; hits: number; profiles: number; qualified: number; created: number; errors: Set<string> }>();
  for (const [id, info] of runInfo) {
    if (!info.auto) continue;
    const key = `${day(info.started_at)}|${info.founder ?? '–'}`;
    const entry = autoDays.get(key) ?? { runs: 0, failed: 0, hits: 0, profiles: 0, qualified: 0, created: 0, errors: new Set<string>() };
    entry.runs++;
    if (info.status !== 'done') entry.failed++;
    entry.hits += info.leads;
    entry.profiles += info.profiles;
    entry.qualified += info.qualified;
    entry.created += createdByRun.get(id) ?? 0;
    if (info.error_code) entry.errors.add(info.error_code);
    autoDays.set(key, entry);
  }
  section(
    'Automatische Suche je Tag und Gründer',
    'Ab dem Update. Zeigt Tage, an denen Läufe liefen, aber nichts dabei herauskam.',
    '',
    table(
      ['Tag', 'Gründer', 'Läufe', 'davon abgebrochen', 'Treffer geprüft', 'Profile abgerufen', 'qualifiziert', 'Leads angelegt', 'Fehler'],
      [...autoDays]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([key, entry]) => {
          const [d, founder] = key.split('|');
          return [d, founder, entry.runs, entry.failed, entry.hits, entry.profiles, entry.qualified, entry.created, [...entry.errors].join(', ') || '–'];
        }),
    ),
  );

  // ── Suchanfragen ──
  type QueryRow = { label: string; pages: number; hits: number; fresh: number; likely: number; qualified: number; good: number; bad: number; exhausted_at: number | null; updated_at: number };
  const queries = all<QueryRow>('SELECT label, pages, hits, fresh, likely, qualified, good, bad, exhausted_at, updated_at FROM search_queries ORDER BY updated_at DESC');
  section(
    'Suchanfragen (Stichwort · Position · Region) seit Beginn',
    'Jede Seite ist eine LinkedIn-Suche. „neu“ = noch nie geprüfte Profile, „vielversprechend“ = Vorprüfung „likely“.',
    '',
    table(
      ['Anfrage', 'zuletzt', 'Seiten', 'Treffer', 'neu', 'vielversprechend', 'qualifiziert', 'qualif. je Seite', 'passt', 'passt nicht', 'erschöpft'],
      queries.map((row) => [
        row.label,
        day(row.updated_at),
        row.pages,
        row.hits,
        row.fresh,
        row.likely,
        row.qualified,
        row.pages ? Math.round((row.qualified / row.pages) * 100) / 100 : '–',
        row.good,
        row.bad,
        row.exhausted_at ? day(row.exhausted_at) : 'nein',
      ]),
    ),
  );

  // ── LinkedIn ──
  const usage = all<{ day: string; account_id: string; kind: string; count: number }>(
    'SELECT day, account_id, kind, count FROM linkedin_account_usage WHERE day >= ? ORDER BY day, account_id',
    fromDay,
  );
  const usageByDay = new Map<string, { profile: number; search: number; accounts: Set<string> }>();
  const usageByAccount = new Map<string, { profile: number; search: number; days: Set<string> }>();
  for (const row of usage) {
    const d = usageByDay.get(row.day) ?? { profile: 0, search: 0, accounts: new Set<string>() };
    const a = usageByAccount.get(row.account_id) ?? { profile: 0, search: 0, days: new Set<string>() };
    if (row.kind === 'profile' || row.kind === 'search') {
      d[row.kind] += row.count;
      a[row.kind] += row.count;
    }
    d.accounts.add(row.account_id);
    a.days.add(row.day);
    usageByDay.set(row.day, d);
    usageByAccount.set(row.account_id, a);
  }
  const eff = options.efficiency;
  const sources = all<{ day: string; account_id: string; source: string; count: number }>(
    'SELECT day, account_id, source, count FROM linkedin_usage_log WHERE day >= ? ORDER BY day DESC, account_id',
    fromDay,
  );
  const sourceKeys = Object.keys(USAGE_SOURCE_LABELS) as UsageSource[];
  const bySourceDay = new Map<string, Record<string, number>>();
  const bySourceAccount = new Map<string, Record<string, number>>();
  for (const row of sources) {
    const d = bySourceDay.get(row.day) ?? {};
    d[row.source] = (d[row.source] ?? 0) + row.count;
    bySourceDay.set(row.day, d);
    const a = bySourceAccount.get(row.account_id) ?? {};
    a[row.source] = (a[row.source] ?? 0) + row.count;
    bySourceAccount.set(row.account_id, a);
  }
  section(
    'Wohin die LinkedIn-Abrufe gingen',
    'Ab dem Update. Profil und Firmenseite zählen beide gegen das Profil-Limit des Accounts. „Neue Kontakte“ = angenommene Anfragen, die das Cockpit als Lead übernimmt; „Aufwärmen“ = Profile aus der Tracking-Liste.',
    '',
    '### Je Tag',
    '',
    table(['Tag', ...sourceKeys.map((key) => USAGE_SOURCE_LABELS[key])], [...bySourceDay].map(([key, entry]) => [key, ...sourceKeys.map((source) => entry[source] ?? 0)])),
    '',
    '### Je Account (Zeitraum)',
    '',
    table(
      ['Account', ...sourceKeys.map((key) => USAGE_SOURCE_LABELS[key])],
      [...bySourceAccount].map(([id, entry]) => [options.accountName(id), ...sourceKeys.map((source) => entry[source] ?? 0)]),
    ),
  );
  section(
    'LinkedIn-Abrufe',
    `Profil- und Firmenabrufe je qualifiziertem Lead (letzte ${eff.days} Tage, alle Zwecke; die Tageszähler bleiben 14 Tage): **${eff.perQualified ?? '–'}** (${int(eff.profileFetches)} Abrufe, ${int(eff.qualified)} Leads aus der Suche). Limits je Account und Tag: 100 Profile, 1.000 Suchtreffer (Sales Navigator 2.500), Gründer-Accounts die Hälfte.`,
    '',
    '### Je Account',
    '',
    table(
      ['Account', 'Profile', 'Suchtreffer', 'aktive Tage', 'Profile je aktivem Tag'],
      [...usageByAccount].map(([id, row]) => [options.accountName(id), row.profile, row.search, row.days.size, Math.round(row.profile / Math.max(1, row.days.size))]),
    ),
    '',
    '### Je Tag',
    '',
    table(
      ['Tag', 'Profile', 'Suchtreffer', 'Accounts'],
      [...usageByDay].map(([key, row]) => [key, row.profile, row.search, row.accounts.size]),
    ),
  );

  // ── Entscheidungen je Treffer ──
  type FitRow = { fit: string | null; n: number; fetched: number; qualified: number; rejected: number };
  const fits = all<FitRow>(
    `SELECT prescreen_fit AS fit, COUNT(*) AS n, SUM(profile_fetched) AS fetched,
       SUM(CASE WHEN status IN ('qualified', 'ads_active') THEN 1 ELSE 0 END) AS qualified, SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
     FROM search_decisions WHERE at >= ? GROUP BY prescreen_fit ORDER BY n DESC`,
    from,
  );
  const statuses = all<{ status: string; note: string | null; n: number }>(
    'SELECT status, note, COUNT(*) AS n FROM search_decisions WHERE at >= ? GROUP BY status, note ORDER BY n DESC LIMIT 25',
    from,
  );
  const rejectedCategories = all<{ category: string | null; n: number; avg: number | null }>(
    "SELECT category, COUNT(*) AS n, AVG(confidence) AS avg FROM search_decisions WHERE at >= ? AND status = 'rejected' GROUP BY category ORDER BY n DESC",
    from,
  );
  type DecisionRow = { headline: string | null; position: string | null; industry: string | null; prescreen_fit: string | null; prescreen_reason: string | null; category: string | null; confidence: number | null; reason: string | null; note: string | null };
  const wasted = all<DecisionRow>(
    "SELECT * FROM search_decisions WHERE at >= ? AND status = 'rejected' AND profile_fetched = 1 ORDER BY at DESC LIMIT 60",
    from,
  );
  const screened = all<DecisionRow>("SELECT * FROM search_decisions WHERE at >= ? AND status = 'screened_out' ORDER BY at DESC LIMIT 40", from);
  section(
    'Entscheidungen je Treffer',
    'Ab dem Update mit diesem Bericht. Ziel: Profile, die nach dem Abruf abgelehnt werden, schon in der Vorprüfung erkennen – jeder gesparte Abruf schont die Accounts.',
    '',
    '### Vorprüfung → Ergebnis',
    '',
    table(
      ['Vorprüfung', 'Treffer', 'Profil abgerufen', 'qualifiziert', 'abgelehnt', 'Quote qualifiziert je Abruf'],
      fits.map((row) => [row.fit ?? 'ohne (Dublette, Warteliste o. Ä.)', row.n, row.fetched, row.qualified, row.rejected, pct(row.qualified, row.fetched)]),
    ),
    '',
    '### Endzustände',
    '',
    table(['Status', 'Hinweis', 'Anzahl'], statuses.map((row) => [row.status, row.note, row.n])),
    '',
    '### Nach dem Profilabruf abgelehnt – je Kategorie',
    '',
    table(['Kategorie der KI', 'Anzahl', 'Ø Sicherheit'], rejectedCategories.map((row) => [row.category, row.n, row.avg === null ? '–' : Math.round(row.avg * 100) / 100])),
    '',
    '### Beispiele: Profil abgerufen, dann abgelehnt (verschwendete Abrufe, jüngste zuerst)',
    '',
    table(
      ['Headline', 'Position', 'Branche', 'Vorprüfung', 'Kategorie', 'Sicherheit', 'Begründung'],
      wasted.map((row) => [row.headline, row.position, row.industry, row.prescreen_fit, row.category, row.confidence, row.reason]),
    ),
    '',
    '### Beispiele: in der Vorprüfung aussortiert (prüfen, ob gute dabei sind)',
    '',
    table(['Headline', 'Grund der Vorprüfung'], screened.map((row) => [row.headline, row.prescreen_reason])),
  );

  // ── Modellvergleich ──
  type ShadowAgg = { purpose: string; main_model: string; shadow_model: string; main_verdict: string; shadow_verdict: string; n: number };
  const shadow = all<ShadowAgg>(
    `SELECT purpose, main_model, shadow_model, main_verdict, shadow_verdict, COUNT(*) AS n FROM ai_shadow WHERE at >= ?
     GROUP BY purpose, main_model, shadow_model, main_verdict, shadow_verdict ORDER BY purpose, main_model, shadow_model`,
    from,
  );
  const pairs = new Map<string, { purpose: string; main: string; other: string; n: number; same: number; cells: string[] }>();
  for (const row of shadow) {
    const key = `${row.purpose}|${row.main_model}|${row.shadow_model}`;
    const entry = pairs.get(key) ?? { purpose: row.purpose, main: row.main_model, other: row.shadow_model, n: 0, same: 0, cells: [] };
    entry.n += row.n;
    if (row.main_verdict === row.shadow_verdict) entry.same += row.n;
    entry.cells.push(`${row.main_verdict}→${row.shadow_verdict}: ${row.n}`);
    pairs.set(key, entry);
  }
  const disagreements = all<{ purpose: string; headline: string | null; main_model: string; main_verdict: string; main_category: string | null; shadow_model: string; shadow_verdict: string; shadow_category: string | null }>(
    'SELECT * FROM ai_shadow WHERE at >= ? AND main_verdict != shadow_verdict ORDER BY at DESC LIMIT 40',
    from,
  );
  section(
    'Modellvergleich',
    'Ein Teil der Vorprüfungen und Einstufungen lief zusätzlich mit einem zweiten Modell (zählt nicht). Einstufung: „ja“ = die KI hält den Lead für qualifiziert. Vorprüfung: likely / maybe / no. Hohe Übereinstimmung heißt: das günstigere Modell reicht.',
    '',
    table(
      ['Aufgabe', 'Hauptmodell', 'Vergleichsmodell', 'Fälle', 'gleich entschieden', 'Hauptmodell → Vergleich'],
      [...pairs.values()].map((entry) => [purposeLabel(entry.purpose), entry.main, entry.other, entry.n, pct(entry.same, entry.n), entry.cells.join(' · ')]),
    ),
    '',
    '### Abweichungen (jüngste zuerst)',
    '',
    table(
      ['Aufgabe', 'Headline', 'Hauptmodell', 'Vergleichsmodell'],
      disagreements.map((row) => [
        purposeLabel(row.purpose),
        row.headline,
        `${row.main_model}: ${row.main_verdict}${row.main_category ? ` (${row.main_category})` : ''}`,
        `${row.shadow_model}: ${row.shadow_verdict}${row.shadow_category ? ` (${row.shadow_category})` : ''}`,
      ]),
    ),
  );

  // ── Rückmeldungen ──
  type FeedbackRow = { verdict: string; source: string; reason: string | null; outcome: string | null; note: string | null; category: string | null; headline: string | null; position: string | null; industry: string | null; quick_term: string | null; at: number };
  const feedback = all<FeedbackRow>('SELECT * FROM lead_feedback ORDER BY at DESC LIMIT 150');
  const feedbackCounts = all<{ verdict: string; source: string; n: number }>('SELECT verdict, source, COUNT(*) AS n FROM lead_feedback GROUP BY verdict, source ORDER BY n DESC');
  section(
    'Rückmeldungen (Beispiele für die KI) seit Beginn',
    '„outcome“ = automatisch: passt bei interessierter Antwort, Frage, Termin oder Übergabe; passt nicht, wenn der Lead ohne jeden Kontakt auf „Verloren“ gesetzt wurde. „manual“ = von Hand im Cockpit.',
    '',
    table(['Urteil', 'Quelle', 'Anzahl'], feedbackCounts.map((row) => [row.verdict === 'good' ? 'passt' : 'passt nicht', row.source, row.n])),
    '',
    table(
      ['Tag', 'Urteil', 'Quelle', 'Grund / Ergebnis', 'Kategorie', 'Headline', 'Position', 'Branche', 'ohne KI über'],
      feedback.map((row) => [
        day(row.at),
        row.verdict === 'good' ? 'passt' : 'passt nicht',
        row.source,
        row.outcome ?? (row.reason ? LEAD_FEEDBACK_REASON_LABELS[row.reason as LeadFeedbackReason] ?? row.reason : null) ?? row.note,
        row.category,
        row.headline,
        row.position,
        row.industry,
        row.quick_term,
      ]),
    ),
  );

  // ── Was aus den Leads wurde ──
  const leadRows = all<{ category: string | null; stage: string; n: number }>(
    `SELECT json_extract(assessment, '$.category') AS category, stage, COUNT(*) AS n FROM leads
     WHERE json_extract(origin, '$.kind') = 'search' GROUP BY category, stage`,
  );
  const byCategory = new Map<string, Record<string, number>>();
  for (const row of leadRows) {
    const key = row.category ?? 'ohne';
    const entry = byCategory.get(key) ?? {};
    entry[row.stage] = (entry[row.stage] ?? 0) + row.n;
    byCategory.set(key, entry);
  }
  const reached = (entry: Record<string, number>, stages: readonly LeadStage[]) => stages.reduce((sum, stage) => sum + (entry[stage] ?? 0), 0);
  const AFTER_CONNECT: LeadStage[] = ['connected', 'contacted', 'replied', 'meeting', 'handed_over'];
  const AFTER_REPLY: LeadStage[] = ['replied', 'meeting', 'handed_over'];
  const queryOutcome = all<{ label: string; n: number; connected: number; replied: number; lost: number }>(
    `SELECT q.label AS label, COUNT(*) AS n,
       SUM(CASE WHEN l.stage IN ('connected', 'contacted', 'replied', 'meeting', 'handed_over') THEN 1 ELSE 0 END) AS connected,
       SUM(CASE WHEN l.stage IN ('replied', 'meeting', 'handed_over') THEN 1 ELSE 0 END) AS replied,
       SUM(CASE WHEN l.stage = 'lost' THEN 1 ELSE 0 END) AS lost
     FROM leads l JOIN search_lead_source s ON s.provider_id = l.provider_id JOIN search_queries q ON q.key = s.query_key
     GROUP BY q.label ORDER BY n DESC LIMIT 40`,
  );
  section(
    'Was aus den Leads der Suche wurde (heutiger Stand)',
    'Stufen: ' + LEAD_STAGES.map((stage) => `${stage} = ${LEAD_STAGE_LABELS[stage]}`).join(', ') + '. Gelöschte (verlorene) Leads fehlen.',
    '',
    '### Je Kategorie der KI',
    '',
    table(
      ['Kategorie', ...LEAD_STAGES, 'vernetzt+', 'geantwortet+'],
      [...byCategory].map(([key, entry]) => {
        const total = Object.values(entry).reduce((sum, value) => sum + value, 0);
        return [key, ...LEAD_STAGES.map((stage) => entry[stage] ?? 0), pct(reached(entry, AFTER_CONNECT), total), pct(reached(entry, AFTER_REPLY), total)];
      }),
    ),
    '',
    '### Je Suchanfrage (soweit bekannt, 90 Tage)',
    '',
    table(['Anfrage', 'Leads', 'vernetzt+', 'geantwortet+', 'verloren'], queryOutcome.map((row) => [row.label, row.n, row.connected, row.replied, row.lost])),
  );

  section(
    'Fragen an Claude',
    '1. Welche Suchanfragen sollten raus oder seltener laufen, welche fehlen (Profilabrufe je qualifiziertem Lead senken)?',
    '2. Welche Muster in den „verschwendeten Abrufen“ könnte die Vorprüfung schon an der Headline erkennen (Prompt-Vorschlag)?',
    '3. Reicht laut Modellvergleich ein günstigeres Modell für Vorprüfung oder Einstufung? Wo nicht?',
    '4. Fallen Kategorien oder Begründungen auf, bei denen die KI und die echten Ergebnisse auseinanderliegen?',
  );
  return `${out.join('\n')}\n`;
}
