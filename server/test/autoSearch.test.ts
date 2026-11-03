import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  AUTO_SEARCH_ACTOR,
  AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES,
  AUTO_SEARCH_TIME_ZONE,
  type AutoSearchListResponse,
  type AutoSearchSchedule,
  type AutoSearchUpdate,
  focusKeywords,
} from '../../shared/autoSearch.js';
import { DEFAULT_SEARCH_PROFILE, type LeadStatus, type LinkedinAccountStatus, type PipelineLead, type PrescreenVerdict, type RunSnapshot, type SearchProfile } from '../../shared/leadSearch.js';
import type { LeadDetailResponse, LeadListResponse } from '../../shared/leads.js';
import type { NotificationListResponse } from '../../shared/notifications.js';
import { createLiveAdapter } from '../src/adapters/live/liveAdapter.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { AUTO_SEARCH_MESSAGES, checkedIds, mostlyUnrated } from '../src/autoSearch/planner.js';
import { dueSlot, nextRunAt } from '../src/autoSearch/time.js';
import { ROLE_MESSAGES } from '../src/auth/roles.js';
import { loadConfig } from '../src/config.js';
import { DATABASE_FILE } from '../src/db/database.js';
import { AdapterError, type RunContext, type SearchOptions } from '../src/pipeline/adapter.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

/** Automatische Lead-Suche (Vertrag shared/autoSearch.ts) – Mock-Modus, Fake-Uhr, Planer per `tick()`. */

const MINUTE = 60_000;
/** Montag, 05.10.2026, 07:00 in Berlin (Sommerzeit, UTC+2). */
const MONDAY_0700 = Date.UTC(2026, 9, 5, 5, 0);

/** Mock, dessen Suche erst weiterläuft, wenn `release()` gerufen wird – so bleibt die Suche „belegt“. */
class GatedAdapter extends MockAdapter {
  private open!: () => void;
  private gate = new Promise<void>((resolve) => (this.open = resolve));
  constructor() {
    super(0);
  }
  release() {
    this.open();
  }
  close() {
    this.gate = new Promise<void>((resolve) => (this.open = resolve));
  }
  override async search(profile: SearchProfile, options: SearchOptions, ctx: RunContext) {
    await this.gate;
    return super.search(profile, options, ctx);
  }
}

function autoApp(options: { dataDir?: string; adapter?: MockAdapter; env?: NodeJS.ProcessEnv; clock?: { now: number } } = {}) {
  // Standard: 10 Minuten vor dem Termin – Speichern in der fälligen Minute zählt den Termin als erledigt.
  const clock = options.clock ?? { now: MONDAY_0700 - 10 * MINUTE };
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: options.dataDir ?? tempDataDir(),
    AUTH_DEMO_ACCOUNTS: 'true',
    AUTH_COOKIE_SECURE: 'false',
    MOCK_SPEED: '0',
    ...options.env,
  });
  const app = buildApp({ config, adapter: options.adapter ?? new MockAdapter(0), logger: false, requireSession: true, autoSearchNow: () => clock.now });
  return { app, clock };
}

type App = ReturnType<typeof autoApp>['app'];

async function login(app: App, username: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'demo' } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}

const req = (app: App, cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const plan = (overrides: Partial<AutoSearchUpdate> = {}): AutoSearchUpdate => ({
  enabled: true,
  days: [1],
  time: '07:00',
  profile: { ...DEFAULT_SEARCH_PROFILE },
  ...overrides,
});

async function save(app: App, cookie: string, founder: string, update: object) {
  const response = await req(app, cookie, 'PUT', `/api/auto-search/${founder}`, update);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as AutoSearchSchedule;
}

async function schedules(app: App, cookie: string): Promise<Record<string, AutoSearchSchedule>> {
  const response = await req(app, cookie, 'GET', '/api/auto-search');
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as AutoSearchListResponse;
  return Object.fromEntries(body.schedules.map((schedule) => [schedule.founder, schedule]));
}

const errorOf = (response: { statusCode: number; json: () => { error: { code: string; message: string; field?: string; runId?: string } } }) => ({
  status: response.statusCode,
  ...response.json().error,
});

async function run(app: App, cookie: string, id: string): Promise<RunSnapshot> {
  return (await req(app, cookie, 'GET', `/api/lead-search/runs/${id}`)).json().run as RunSnapshot;
}

/** Wie `waitForEnd` aus den Helfern, aber mit Sitzung. */
async function waitForEnd(app: App, cookie: string, id: string): Promise<RunSnapshot> {
  const started = Date.now();
  for (;;) {
    const snapshot = await run(app, cookie, id);
    if (snapshot.status !== 'running') return snapshot;
    if (Date.now() - started > 5000) throw new Error(`Lauf ${id} nicht fertig geworden`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── Rechte ──────────────────────────────────────────────────────────────────

test('Rechte: Gründer nur eigener Plan, Admin beide, Mitarbeiter nichts', async () => {
  const { app } = autoApp();
  const [nick, admin, anna] = [await login(app, 'nick'), await login(app, 'admin'), await login(app, 'mitarbeiter')];

  assert.deepEqual(Object.keys(await schedules(app, nick)), ['nick']);
  assert.deepEqual(Object.keys(await schedules(app, admin)), ['nick', 'johannes']);
  assert.deepEqual(Object.keys(await schedules(app, await login(app, 'johannes'))), ['johannes']);

  for (const [method, url] of [
    ['GET', '/api/auto-search'],
    ['PUT', '/api/auto-search/nick'],
    ['POST', '/api/auto-search/nick/run'],
  ] as const) {
    const response = await req(app, anna, method, url, method === 'PUT' ? plan() : undefined);
    assert.deepEqual(errorOf(response), { status: 403, code: 'not_allowed', message: ROLE_MESSAGES.autoSearch }, `${method} ${url}`);
  }

  const foreignPut = await req(app, nick, 'PUT', '/api/auto-search/johannes', plan());
  assert.deepEqual(errorOf(foreignPut), { status: 403, code: 'not_allowed', message: ROLE_MESSAGES.autoSearchFounder });
  const foreignRun = await req(app, nick, 'POST', '/api/auto-search/johannes/run');
  assert.deepEqual(errorOf(foreignRun), { status: 403, code: 'not_allowed', message: ROLE_MESSAGES.autoSearchFounder });

  assert.equal((await req(app, admin, 'PUT', '/api/auto-search/johannes', plan())).statusCode, 200);
  assert.deepEqual(errorOf(await req(app, admin, 'PUT', '/api/auto-search/peter', plan())), {
    status: 404,
    code: 'not_found',
    message: 'Diesen Gründer gibt es nicht.',
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/auto-search' })).statusCode, 401);
  await app.close();
});

// ── Standardwerte und Validierung ───────────────────────────────────────────

test('ohne gespeicherten Plan: Standardwerte (werktags 07:00, aus)', async () => {
  const { app } = autoApp();
  const admin = await login(app, 'admin');
  const response = await req(app, admin, 'GET', '/api/auto-search');
  const body = response.json() as AutoSearchListResponse;
  assert.equal(body.timeZone, AUTO_SEARCH_TIME_ZONE);
  for (const schedule of body.schedules) {
    assert.deepEqual(
      { ...schedule, founder: undefined },
      {
        founder: undefined,
        enabled: false,
        days: [1, 2, 3, 4, 5],
        time: '07:00',
        profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 15 },
        nextRunAt: null,
        followUpAt: null,
        followUpManual: false,
        lastRun: null,
        nextFocus: 'kapitalanlage_vertrieb',
        focusCounts: { kapitalanlage_vertrieb: 0, finanzdienstleister: 0, bautraeger_projektentwickler: 0 },
        kapitalanlagePercent: 50,
        updatedAt: null,
        updatedBy: null,
        dailyTarget: null,
        maxRounds: 4,
        dailyBudgetEur: null,
        secondTime: null,
        today: null,
      },
    );
  }
  await app.close();
});

test('zweiter Termin am Tag: beide Uhrzeiten lösen je einen Lauf aus, nextRunAt = frühester, Prüfung mit Feld', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  clock.now = MONDAY_0700 - 10 * MINUTE;

  const invalid = await req(app, nick, 'PUT', '/api/auto-search/nick', plan({ secondTime: '25:00' }));
  assert.deepEqual(errorOf(invalid), { status: 400, code: 'invalid_request', message: 'Bitte eine Uhrzeit wie 14:00 angeben.', field: 'secondTime' });
  const same = await req(app, nick, 'PUT', '/api/auto-search/nick', plan({ secondTime: '07:00' }));
  assert.equal(errorOf(same).field, 'secondTime');

  const saved = await save(app, nick, 'nick', plan({ secondTime: '14:00' }));
  assert.equal(saved.secondTime, '14:00');
  assert.equal(saved.nextRunAt, MONDAY_0700);

  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const morning = (await schedules(app, nick)).nick;
  assert.equal(morning.lastRun?.status, 'done');
  assert.equal(morning.nextRunAt, MONDAY_0700 + 7 * 60 * MINUTE, 'als Nächstes 14:00');

  clock.now = MONDAY_0700 + 7 * 60 * MINUTE + 5_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const afternoon = (await schedules(app, nick)).nick;
  assert.notEqual(afternoon.lastRun?.runId, morning.lastRun?.runId);
  assert.equal(afternoon.lastRun?.startedAt, MONDAY_0700 + 7 * 60 * MINUTE);
  assert.equal(afternoon.today?.rounds, 2);

  // Fehlt `secondTime` im Update (ältere Oberfläche), bleibt er; leerer Text bzw. null schaltet ihn aus.
  assert.equal((await save(app, nick, 'nick', plan())).secondTime, '14:00');
  assert.equal((await save(app, nick, 'nick', plan({ secondTime: '' as unknown as null }))).secondTime, null);
  await app.close();
});

test('Speichern: Validierung mit Feld, Tage sortiert, geändert von', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  const cases: Array<[object, string, string]> = [
    [plan({ time: '7:00' }), 'time', 'Bitte eine Uhrzeit wie 07:00 angeben.'],
    [plan({ time: '24:00' }), 'time', 'Bitte eine Uhrzeit wie 07:00 angeben.'],
    [plan({ days: [] }), 'days', 'Wähle mindestens einen Tag.'],
    [plan({ days: [0, 1] as never }), 'days', 'Wochentage nur von Montag bis Sonntag.'],
    [plan({ days: [8] as never }), 'days', 'Wochentage nur von Montag bis Sonntag.'],
    [plan({ profile: { ...DEFAULT_SEARCH_PROFILE, keywords: ['  '] } }), 'profile.keywords', 'Mindestens ein Stichwort.'],
    [plan({ profile: { ...DEFAULT_SEARCH_PROFILE, keywords: ['x'.repeat(61)] } }), 'profile.keywords', 'Höchstens 20 Stichwörter mit je höchstens 60 Zeichen.'],
    [plan({ profile: { ...DEFAULT_SEARCH_PROFILE, positions: [] } }), 'profile.positions', 'Mindestens eine Position.'],
    [
      plan({ profile: { ...DEFAULT_SEARCH_PROFILE, positions: Array.from({ length: 21 }, (_, i) => `P${i}`) } }),
      'profile.positions',
      'Höchstens 20 Positionen mit je höchstens 60 Zeichen.',
    ],
    [plan({ profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 1001 } }), 'profile.maxResults', 'Pro Lauf 1 bis 1000 Profile.'],
    [plan({ profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 0 } }), 'profile.maxResults', 'Pro Lauf 1 bis 1000 Profile.'],
    [plan({ profile: { ...DEFAULT_SEARCH_PROFILE, region: ' ' } }), 'profile.region', 'Bitte eine Region angeben (2 bis 80 Zeichen).'],
    [{ ...plan(), enabled: 'ja' }, 'enabled', 'Bitte angeben, ob die automatische Suche an oder aus ist.'],
    [{ ...plan(), profile: { ...DEFAULT_SEARCH_PROFILE, region: 5 } }, 'profile.region', 'Bitte eine Region angeben.'],
    [{ ...plan(), profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: '10' } }, 'profile.maxResults', 'Bitte angeben, wie viele Profile pro Lauf abgerufen werden.'],
  ];
  for (const [body, field, message] of cases) {
    const response = await req(app, nick, 'PUT', '/api/auto-search/nick', body);
    assert.deepEqual(errorOf(response), { status: 400, code: 'invalid_request', field, message }, JSON.stringify(body));
  }
  // Aus mit leeren Tagen ist erlaubt.
  assert.equal((await req(app, nick, 'PUT', '/api/auto-search/nick', plan({ enabled: false, days: [] }))).statusCode, 200);

  clock.now = Date.UTC(2026, 9, 6, 10, 0); // Di 12:00
  const saved = await save(app, nick, 'nick', plan({ days: [5, 1, 3, 1], time: '06:30', profile: { ...DEFAULT_SEARCH_PROFILE, keywords: [' Bauträger ', ''] } }));
  assert.deepEqual(saved.days, [1, 3, 5]);
  assert.deepEqual(saved.profile.keywords, ['Bauträger']);
  assert.equal(saved.updatedBy, 'Nick');
  assert.ok(saved.updatedAt);
  // Nächster Lauf: Mittwoch 07.10. 06:30 Berlin = 04:30 UTC.
  assert.equal(saved.nextRunAt, Date.UTC(2026, 9, 7, 4, 30));
  assert.deepEqual((await schedules(app, nick)).nick, saved);
  await app.close();
});

// ── Zeitzone ────────────────────────────────────────────────────────────────

test('nextRunAt in Europe/Berlin inkl. Zeitumstellung', () => {
  const all = [1, 2, 3, 4, 5, 6, 7] as const;
  const tz = AUTO_SEARCH_TIME_ZONE;
  // Sommerzeit (UTC+2): Fr 23.10. 14:00 → Sa 24.10. 07:00 = 05:00 UTC.
  assert.equal(nextRunAt(Date.UTC(2026, 9, 23, 12, 0), all, '07:00', tz), Date.UTC(2026, 9, 24, 5, 0));
  // Über die Umstellung am So 25.10.: 07:00 Winterzeit (UTC+1) = 06:00 UTC.
  assert.equal(nextRunAt(Date.UTC(2026, 9, 24, 12, 0), all, '07:00', tz), Date.UTC(2026, 9, 25, 6, 0));
  // Werktags: von Freitagnachmittag auf Montag 26.10. 07:00 (Winterzeit).
  assert.equal(nextRunAt(Date.UTC(2026, 9, 23, 12, 0), [1, 2, 3, 4, 5], '07:00', tz), Date.UTC(2026, 9, 26, 6, 0));
  // Strikt nach jetzt: genau in der Minute → nächste Woche.
  assert.equal(nextRunAt(MONDAY_0700, [1], '07:00', tz), MONDAY_0700 + 7 * 24 * 60 * MINUTE);
  // Doppelte Stunde (02:30 gibt es am 25.10. zweimal): der erste Zeitpunkt, und nur ein Termin.
  assert.equal(nextRunAt(Date.UTC(2026, 9, 24, 12, 0), all, '02:30', tz), Date.UTC(2026, 9, 25, 0, 30));
  assert.equal(dueSlot(Date.UTC(2026, 9, 25, 0, 30), all, '02:30', tz), '2026-10-25 02:30');
  assert.equal(dueSlot(Date.UTC(2026, 9, 25, 1, 30), all, '02:30', tz), '2026-10-25 02:30');
  // Übersprungene Stunde (29.03.2026: 02:00 → 03:00): an diesem Tag kein Lauf.
  assert.equal(nextRunAt(Date.UTC(2026, 2, 28, 12, 0), all, '02:30', tz), Date.UTC(2026, 2, 30, 0, 30));
  assert.equal(nextRunAt(MONDAY_0700, [], '07:00', tz), null);
  // Fällig nur in der geplanten Minute und am geplanten Tag.
  assert.equal(dueSlot(MONDAY_0700 + 59_000, [1], '07:00', tz), '2026-10-05 07:00');
  assert.equal(dueSlot(MONDAY_0700 + MINUTE, [1], '07:00', tz), null);
  assert.equal(dueSlot(MONDAY_0700, [2], '07:00', tz), null);
});

// ── Planer ──────────────────────────────────────────────────────────────────

test('fälliger Lauf legt die Leads für den Gründer an (actor „Automatische Suche“), einmal je Termin', async () => {
  const dataDir = tempDataDir();
  const { app, clock } = autoApp({ dataDir });
  const nick = await login(app, 'nick');
  clock.now = MONDAY_0700 - 10 * MINUTE;
  await save(app, nick, 'nick', plan());
  const before = (await req(app, nick, 'GET', '/api/leads?owner=nick&stage=new')).json() as LeadListResponse;

  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const { lastRun, nextRunAt: next } = (await schedules(app, nick)).nick;
  assert.ok(lastRun?.runId);
  assert.deepEqual({ ...lastRun, runId: null, finishedAt: null }, {
    runId: null,
    startedAt: MONDAY_0700,
    finishedAt: null,
    status: 'done',
    manual: false,
    created: 7,
    message: null,
    focus: 'kapitalanlage_vertrieb',
    // Simulierte KI-Kosten: 1 Vorprüfung (33 Treffer) + 15 Einstufungen mit Claude Opus 5.5, 0,86 €/$.
    costEur: 0.2581,
  });
  assert.equal(next, MONDAY_0700 + 7 * 24 * 60 * MINUTE);

  // Der Lauf ist ein normaler Lauf (Trichter wie von Hand) und schon übergeben.
  const snapshot = await run(app, nick, lastRun.runId);
  assert.equal(snapshot.status, 'done');
  assert.equal(snapshot.handedOff, true);

  const after = (await req(app, nick, 'GET', '/api/leads?owner=nick&stage=new')).json() as LeadListResponse;
  assert.equal(after.total - before.total, 7);
  const fresh = after.leads.filter((lead) => !before.leads.some((old) => old.id === lead.id));
  assert.equal(fresh.length, 7);
  for (const lead of fresh) {
    assert.equal(lead.owner, 'nick');
    const detail = (await req(app, nick, 'GET', `/api/leads/${lead.id}`)).json() as LeadDetailResponse;
    const created = detail.events.find((event) => event.kind === 'created');
    assert.equal(created?.actor, AUTO_SEARCH_ACTOR);
  }

  // Dieselbe Minute noch einmal: kein zweiter Lauf – auch nicht nach einem Neustart.
  clock.now = MONDAY_0700 + 50_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.lastRun?.runId, lastRun.runId);
  await app.close();

  const restarted = autoApp({ dataDir, clock: { now: MONDAY_0700 + 55_000 } });
  await restarted.app.ready();
  await restarted.app.autoSearch.tick();
  await restarted.app.autoSearch.idle();
  assert.equal((await schedules(restarted.app, await login(restarted.app, 'nick'))).nick.lastRun?.runId, lastRun.runId);
  await restarted.app.close();
});

test('LEAD_DISTRIBUTION=balanced: Lauf von Nick verteilt seine Leads auf beide Gründer, Tagesziel zählt alle', async () => {
  const { app, clock } = autoApp({ env: { LEAD_DISTRIBUTION: 'balanced', UNIPILE_ACCOUNT_NICK: 'accNick', UNIPILE_ACCOUNT_JOHANNES: 'accJohannes' } });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', plan());
  const backlog = async (owner: string) => ((await req(app, nick, 'GET', `/api/leads?owner=${owner}&stage=new&limit=1`)).json() as LeadListResponse).total;
  const before = { nick: await backlog('nick'), johannes: await backlog('johannes') };

  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const { lastRun, today } = (await schedules(app, nick)).nick;
  assert.equal(lastRun?.status, 'done');
  assert.equal(lastRun?.created, 7);
  assert.equal(today?.created, 7, 'Tagesziel des Zeitplans zählt auch die verteilten Leads');

  const all = (await req(app, nick, 'GET', '/api/leads?stage=new&limit=500')).json() as LeadListResponse;
  const fresh = all.leads.filter((lead) => lead.origin.kind === 'search' && lead.origin.runId === lastRun!.runId);
  assert.equal(fresh.length, 7);
  // Wenigster Rückstand bekommt den Lead, Gleichstand → der Suchende (Nick).
  const counts = { ...before };
  let toJohannes = 0;
  for (let i = 0; i < 7; i++) {
    const pick = counts.johannes < counts.nick ? 'johannes' : 'nick';
    counts[pick]++;
    if (pick === 'johannes') toJohannes++;
  }
  assert.ok(toJohannes > 0 && toJohannes < 7, `toJohannes ${toJohannes}`);
  assert.equal(fresh.filter((lead) => lead.owner === 'johannes').length, toJohannes);
  assert.deepEqual({ nick: await backlog('nick'), johannes: await backlog('johannes') }, counts);
  for (const lead of fresh) {
    assert.ok(lead.origin.kind === 'search' && lead.origin.auto);
    assert.equal(lead.origin.kind === 'search' ? lead.origin.searchedBy : null, lead.owner === 'johannes' ? 'nick' : undefined);
    const detail = (await req(app, nick, 'GET', `/api/leads/${lead.id}`)).json() as LeadDetailResponse;
    const created = detail.events.find((event) => event.kind === 'created');
    assert.deepEqual([created?.by, created?.actor], ['nick', AUTO_SEARCH_ACTOR]);
  }
  await app.close();
});

test('kein Nachholen: verpasste Minute startet nichts', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', plan());
  for (const at of [MONDAY_0700 - 1000, MONDAY_0700 + MINUTE, MONDAY_0700 + 3 * 60 * MINUTE]) {
    clock.now = at;
    await app.autoSearch.tick();
  }
  await app.autoSearch.idle();
  const schedule = (await schedules(app, nick)).nick;
  assert.equal(schedule.lastRun, null);
  assert.equal(schedule.nextRunAt, MONDAY_0700 + 7 * 24 * 60 * MINUTE);
  // Ausgeschaltet: auch in der Minute nichts.
  await save(app, nick, 'nick', plan({ enabled: false }));
  clock.now = MONDAY_0700 + 7 * 24 * 60 * MINUTE;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.lastRun, null);
  await app.close();
});

test('belegte Suche: wartet und startet, sobald frei – nach 30 Minuten skipped', async () => {
  const adapter = new GatedAdapter();
  const { app, clock } = autoApp({ adapter });
  const nick = await login(app, 'nick');
  const johannes = await login(app, 'johannes');
  await save(app, nick, 'nick', plan());

  // Von Hand gestartete Suche hält die Suche belegt.
  const manual = await req(app, johannes, 'POST', '/api/lead-search/runs', { profile: DEFAULT_SEARCH_PROFILE });
  assert.equal(manual.statusCode, 202, manual.body);
  const manualId = (manual.json() as { run: RunSnapshot }).run.id;

  clock.now = MONDAY_0700 + 5000;
  await app.autoSearch.tick();
  clock.now = MONDAY_0700 + 29 * MINUTE;
  await app.autoSearch.tick();
  assert.equal((await schedules(app, nick)).nick.lastRun, null, 'wartet noch');

  // Frei nach 29 Minuten → der Termin startet beim nächsten Prüfen.
  adapter.release();
  await waitForEnd(app, johannes, manualId);
  clock.now = MONDAY_0700 + 29 * MINUTE + 30_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const lastRun = (await schedules(app, nick)).nick.lastRun;
  assert.equal(lastRun?.status, 'done');
  assert.equal(lastRun?.startedAt, MONDAY_0700);

  // Nächste Woche: belegt bis über 30 Minuten → skipped mit Satz, nichts gestartet.
  adapter.close();
  const blocking = await req(app, johannes, 'POST', '/api/lead-search/runs', { profile: DEFAULT_SEARCH_PROFILE });
  const blockingId = (blocking.json() as { run: RunSnapshot }).run.id;
  const nextWeek = MONDAY_0700 + 7 * 24 * 60 * MINUTE;
  clock.now = nextWeek + 1000;
  await app.autoSearch.tick();
  clock.now = nextWeek + 31 * MINUTE;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.deepEqual((await schedules(app, nick)).nick.lastRun, {
    runId: null,
    startedAt: nextWeek,
    finishedAt: nextWeek + 31 * MINUTE,
    status: 'skipped',
    manual: false,
    created: 0,
    message: AUTO_SEARCH_MESSAGES.skipped,
  });
  adapter.release();
  await waitForEnd(app, johannes, blockingId);
  // Danach startet der verfallene Termin nicht mehr.
  clock.now = nextWeek + 32 * MINUTE;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.lastRun?.status, 'skipped');
  await app.close();
});

test('beide Gründer zur selben Zeit: nacheinander', async () => {
  const { app, clock } = autoApp();
  const admin = await login(app, 'admin');
  await save(app, admin, 'nick', plan());
  await save(app, admin, 'johannes', plan());
  clock.now = MONDAY_0700;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const { nick, johannes } = await schedules(app, admin);
  assert.equal(nick.lastRun?.status, 'done');
  assert.equal(johannes.lastRun?.status, 'done');
  assert.notEqual(nick.lastRun?.runId, johannes.lastRun?.runId);
  const first = await run(app, admin, nick.lastRun!.runId!);
  const second = await run(app, admin, johannes.lastRun!.runId!);
  assert.ok(second.startedAt >= first.finishedAt!, 'zweiter Lauf erst nach dem ersten');
  // Die 7 Übergebenen gehören jetzt Nick – für Johannes sind es Dubletten; er bekommt nur, was sein Lauf neu fand.
  assert.equal(nick.lastRun?.created, 7);
  assert.equal(johannes.lastRun?.created, second.leads.filter((lead) => lead.status === 'qualified' || lead.status === 'ads_active').length);
  assert.ok(second.leads.every((lead) => lead.status !== 'qualified' || !first.leads.some((old) => old.id === lead.id && old.status === 'qualified')));
  await app.close();
});

test('geprüfte Profile gehen beim nächsten Lauf als checked mit – je Gründer', async () => {
  const { app, clock } = autoApp();
  const admin = await login(app, 'admin');
  await save(app, admin, 'nick', plan());
  clock.now = MONDAY_0700;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const firstRun = await run(app, admin, (await schedules(app, admin)).nick.lastRun!.runId!);
  const fetched = firstRun.leads.filter((lead) => lead.profile).map((lead) => lead.id);
  assert.equal(fetched.length, 15);
  // Dazu die zwei, die die KI-Vorprüfung aussortiert hat (ohne Profilabruf).
  const screened = firstRun.leads.filter((lead) => lead.status === 'screened_out').map((lead) => lead.id);
  assert.equal(screened.length, 2);
  assert.deepEqual(new Set(app.autoSearch.store.checked('nick', clock.now)), new Set([...fetched, ...screened]));
  assert.deepEqual(app.autoSearch.store.checked('johannes', clock.now), []);

  // Zweiter Lauf (von Hand): Abgelehnte usw. sind „In einem früheren Lauf bereits geprüft“, nicht neu abgerufen.
  clock.now = MONDAY_0700 + 60 * MINUTE;
  const response = await req(app, admin, 'POST', '/api/auto-search/nick/run');
  assert.equal(response.statusCode, 202, response.body);
  const { runId } = response.json() as { runId: string };
  await waitForEnd(app, admin, runId);
  await app.autoSearch.idle();
  const secondRun = await run(app, admin, runId);
  const created = new Set(firstRun.leads.filter((lead) => lead.status === 'qualified' || lead.status === 'ads_active').map((lead) => lead.id));
  const checkedAgain = secondRun.leads.filter((lead) => lead.note === 'In einem früheren Lauf bereits geprüft').map((lead) => lead.id);
  assert.deepEqual(new Set(checkedAgain), new Set([...fetched.filter((id) => !created.has(id)), ...screened]));
  assert.ok(secondRun.leads.filter((lead) => lead.profile).every((lead) => !fetched.includes(lead.id)), 'kein Profil zweimal abgerufen');

  // Nach AUTO_SEARCH_CHECKED_DAYS Tagen vergessen.
  assert.deepEqual(app.autoSearch.store.checked('nick', clock.now + 91 * 24 * 60 * MINUTE), []);
  await app.close();
});

test('geprüfte Profile gelten für beide Gründer: Johannes ruft nicht ab, was Nick schon geprüft hat', async () => {
  const { app, clock } = autoApp();
  const admin = await login(app, 'admin');
  await save(app, admin, 'nick', plan());
  await save(app, admin, 'johannes', plan({ enabled: false }));
  clock.now = MONDAY_0700;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const nickRun = await run(app, admin, (await schedules(app, admin)).nick.lastRun!.runId!);
  const fetched = nickRun.leads.filter((lead) => lead.profile).map((lead) => lead.id);
  assert.ok(fetched.length > 0);
  const screened = nickRun.leads.filter((lead) => lead.status === 'screened_out').map((lead) => lead.id);
  assert.deepEqual(new Set(app.autoSearch.store.checkedShared(clock.now)), new Set([...fetched, ...screened]));

  clock.now = MONDAY_0700 + 60 * MINUTE;
  const response = await req(app, admin, 'POST', '/api/auto-search/johannes/run');
  assert.equal(response.statusCode, 202, response.body);
  const { runId } = response.json() as { runId: string };
  await waitForEnd(app, admin, runId);
  await app.autoSearch.idle();
  const johannesRun = await run(app, admin, runId);
  assert.ok(johannesRun.leads.filter((lead) => lead.profile).every((lead) => !fetched.includes(lead.id)), 'kein Profil von Nick noch einmal abgerufen');
  assert.ok(johannesRun.leads.some((lead) => lead.note === 'In einem früheren Lauf bereits geprüft'));
  // Je Gründer gemerkt bleibt es trotzdem (Nachvollziehbarkeit), übersprungen wird gemeinsam.
  assert.ok(app.autoSearch.store.checked('johannes', clock.now).every((id) => !fetched.includes(id)));
  await app.close();
});

test('„Jetzt einmal ausführen“: 202 mit runId, 409 busy während eines Laufs, manual im letzten Lauf', async () => {
  const adapter = new GatedAdapter();
  const { app } = autoApp({ adapter });
  const nick = await login(app, 'nick');
  // Ohne gespeicherten Plan: Standardprofil.
  const response = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.equal(response.statusCode, 202, response.body);
  const { runId } = response.json() as { runId: string };
  assert.equal((await schedules(app, nick)).nick.lastRun?.status, 'running');

  const busy = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.deepEqual(errorOf(busy), {
    status: 409,
    code: 'busy',
    message: 'Es läuft bereits eine Suche. Warte, bis sie fertig ist, oder brich sie ab.',
    runId,
  });

  adapter.release();
  await waitForEnd(app, nick, runId);
  await app.autoSearch.idle();
  const lastRun = (await schedules(app, nick)).nick.lastRun;
  assert.equal(lastRun?.runId, runId);
  assert.equal(lastRun?.manual, true);
  assert.equal(lastRun?.status, 'done');
  assert.equal(lastRun?.created, 7);
  assert.equal((await schedules(app, nick)).nick.enabled, false, 'Plan bleibt aus');
  await app.close();
});

test('abgebrochener Lauf → cancelled mit Satz', async () => {
  const adapter = new GatedAdapter();
  const { app } = autoApp({ adapter });
  const nick = await login(app, 'nick');
  const { runId } = (await req(app, nick, 'POST', '/api/auto-search/nick/run')).json() as { runId: string };
  await req(app, nick, 'POST', `/api/lead-search/runs/${runId}/cancel`);
  adapter.release();
  await waitForEnd(app, nick, runId);
  await app.autoSearch.idle();
  const lastRun = (await schedules(app, nick)).nick.lastRun;
  assert.equal(lastRun?.status, 'cancelled');
  assert.equal(lastRun?.message, AUTO_SEARCH_MESSAGES.cancelled);
  await app.close();
});

test('Live nicht startklar: geplanter Lauf failed mit Satz, „Jetzt ausführen“ 400 config', async () => {
  const { app, clock } = autoApp({ env: { LEAD_SEARCH_MODE: 'live' } });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', plan());
  const expected = 'Die Lead-Suche ist noch nicht vollständig eingerichtet: Die Unipile-Adresse fehlt (Einstellungen → LinkedIn (Unipile), z. B. https://api68.unipile.com:19881). Das Unipile-Token fehlt.';

  const now = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.deepEqual(errorOf(now), { status: 400, code: 'config', message: expected });

  clock.now = MONDAY_0700 + 1000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.deepEqual((await schedules(app, nick)).nick.lastRun, {
    runId: null,
    startedAt: MONDAY_0700,
    finishedAt: MONDAY_0700 + 1000,
    status: 'failed',
    manual: false,
    created: 0,
    message: expected,
  });
  await app.close();
});

// ── Nachbesserungen aus dem Review ──────────────────────────────────────────

test('Neustart während eines Laufs: hängendes „running“ wird failed mit Satz', async () => {
  const dataDir = tempDataDir();
  const first = autoApp({ dataDir });
  await first.app.ready();
  first.app.autoSearch.store.setLastRun('nick', {
    runId: '22222222-2222-4222-8222-222222222222',
    startedAt: MONDAY_0700,
    finishedAt: null,
    status: 'running',
    manual: false,
    created: 0,
    message: null,
  });
  await first.app.close();

  const second = autoApp({ dataDir, clock: { now: MONDAY_0700 + 5 * MINUTE } });
  const lastRun = (await schedules(second.app, await login(second.app, 'nick'))).nick.lastRun;
  assert.deepEqual(lastRun, {
    runId: '22222222-2222-4222-8222-222222222222',
    startedAt: MONDAY_0700,
    finishedAt: MONDAY_0700 + 5 * MINUTE,
    status: 'failed',
    manual: false,
    created: 0,
    message: AUTO_SEARCH_MESSAGES.restarted,
  });
  await second.app.close();
});

test('Termin während eines eigenen Laufs desselben Gründers: still erledigt, kein skipped', async () => {
  const adapter = new GatedAdapter();
  const { app, clock } = autoApp({ adapter });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', plan());
  clock.now = MONDAY_0700 - 30_000;
  const { runId } = (await req(app, nick, 'POST', '/api/auto-search/nick/run')).json() as { runId: string };
  clock.now = MONDAY_0700 + 1000;
  await app.autoSearch.tick();
  clock.now = MONDAY_0700 + 40 * MINUTE;
  await app.autoSearch.tick();
  assert.equal((await schedules(app, nick)).nick.lastRun?.status, 'running');
  adapter.release();
  await waitForEnd(app, nick, runId);
  await app.autoSearch.idle();
  const lastRun = (await schedules(app, nick)).nick.lastRun;
  assert.equal(lastRun?.runId, runId);
  assert.equal(lastRun?.manual, true);
  assert.equal(lastRun?.status, 'done');
  await app.close();
});

test('checked: nur Profile mit Endergebnis, nicht offen gebliebene', () => {
  const lead = (id: string, status: LeadStatus, profile = true) => ({ id, status, profile: profile ? {} : null }) as unknown as PipelineLead;
  const snapshot = {
    leads: [
      lead('q', 'qualified'),
      lead('a', 'ads_active'),
      lead('r', 'rejected'),
      lead('d', 'duplicate'),
      lead('i', 'invited'),
      lead('c', 'connected'),
      lead('u', 'unrated'),
      lead('f', 'failed'),
      lead('x', 'deferred'),
      lead('k', 'qualifying'),
      lead('n', 'duplicate', false),
      lead('s', 'screened_out', false),
      lead('w', 'unique', false),
    ],
  } as unknown as RunSnapshot;
  assert.deepEqual(checkedIds(snapshot), ['q', 'a', 'r', 'd', 'i', 'c', 's']);
});

test('kaputter Plan blockiert den anderen Gründer nicht', async () => {
  const dataDir = tempDataDir();
  const adapter = new GatedAdapter();
  const { app, clock } = autoApp({ dataDir, adapter });
  const admin = await login(app, 'admin');
  await save(app, admin, 'nick', plan());
  await save(app, admin, 'johannes', plan());
  // Eine Suche von Hand belegt die Suche – beide Termine warten.
  const manual = await req(app, admin, 'POST', '/api/lead-search/runs', { profile: DEFAULT_SEARCH_PROFILE });
  const manualId = (manual.json() as { run: RunSnapshot }).run.id;
  clock.now = MONDAY_0700;
  await app.autoSearch.tick();

  const raw = new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  raw.prepare("UPDATE auto_search_schedules SET profile = '{kaputt' WHERE founder = 'nick'").run();
  raw.close();

  adapter.release();
  await waitForEnd(app, admin, manualId);
  clock.now = MONDAY_0700 + 2 * MINUTE;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const nickRun = app.autoSearch.store.lastRun('nick');
  assert.equal(nickRun?.status, 'failed');
  assert.equal(nickRun?.message, AUTO_SEARCH_MESSAGES.unexpected);
  assert.equal(app.autoSearch.store.lastRun('johannes')?.status, 'done');
  // Weitere Prüfungen werfen nicht (kaputter Plan wird je Gründer abgefangen).
  await app.autoSearch.tick();
  await app.close();
});

test('Speichern in der fälligen Minute startet keinen Lauf (Anzeige = Verhalten)', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  clock.now = MONDAY_0700 + 15_000;
  const saved = await save(app, nick, 'nick', plan());
  assert.equal(saved.nextRunAt, MONDAY_0700 + 7 * 24 * 60 * MINUTE);
  clock.now = MONDAY_0700 + 30_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.lastRun, null);
  // Eine Minute später geplant → läuft.
  await save(app, nick, 'nick', plan({ time: '07:01' }));
  clock.now = MONDAY_0700 + MINUTE + 5000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.lastRun?.status, 'done');
  await app.close();
});

test('Demo-Reset leert Pläne, Zustand und geprüfte Profile', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', plan());
  clock.now = MONDAY_0700;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.ok(app.autoSearch.store.checked('nick', clock.now).length > 0);
  const reset = await req(app, nick, 'POST', '/api/leads/demo/reset');
  assert.equal(reset.statusCode, 200, reset.body);
  const schedule = (await schedules(app, nick)).nick;
  assert.equal(schedule.enabled, false);
  assert.equal(schedule.lastRun, null);
  assert.equal(schedule.updatedAt, null);
  assert.deepEqual(app.autoSearch.store.checked('nick', clock.now), []);
  await app.close();
});

test('50/50 der Läufe (27.10.): Kapitalanlage und Finanzdienstleister im Wechsel, Bauträger-Läufe zählen nicht', async () => {
  const { nextAutoSearchFocus, focusKeywords } = await import('../../shared/autoSearch.js');
  const counts = { kapitalanlage_vertrieb: 0, finanzdienstleister: 0, bautraeger_projektentwickler: 0 };
  const sequence: string[] = [];
  for (let i = 0; i < 10; i++) {
    const focus = nextAutoSearchFocus(counts);
    counts[focus]++;
    sequence.push(focus === 'kapitalanlage_vertrieb' ? 'K' : focus === 'finanzdienstleister' ? 'F' : 'B');
  }
  assert.equal(sequence.join(''), 'KFKFKFKFKF', 'im Wechsel, beginnend mit Kapitalanlage');
  assert.equal(nextAutoSearchFocus({ kapitalanlage_vertrieb: 2, bautraeger_projektentwickler: 5 }), 'finanzdienstleister', 'alte Bauträger-Läufe zählen nicht');
  assert.equal(nextAutoSearchFocus({}), 'kapitalanlage_vertrieb');

  // Stichwörter des Profils werden aufgeteilt; fehlt eine Seite, gelten die Standardbegriffe.
  const keywords = ['Kapitalanlage', 'Finanzdienstleister', 'Bauträger', 'Immobilienvertrieb', 'Allfinanz'];
  assert.deepEqual(focusKeywords(keywords, 'kapitalanlage_vertrieb'), ['Kapitalanlage', 'Immobilienvertrieb'], 'ohne Bauträger- und Finanz-Begriffe');
  assert.deepEqual(focusKeywords(keywords, 'finanzdienstleister'), ['Finanzdienstleister', 'Allfinanz']);
  assert.deepEqual(focusKeywords(['Kapitalanlage'], 'finanzdienstleister'), ['Finanzdienstleister', 'Finanzdienstleistungen', 'Finanzvertrieb', 'Allfinanz']);
  assert.deepEqual(focusKeywords(['Kapitalanlage Finanzvertrieb'], 'kapitalanlage_vertrieb'), ['Kapitalanlage Finanzvertrieb'], 'Kapitalanlage geht vor');
});

test('Anteil Kapitalanlage per Regler (27.10.): Standard 50, speichern, prüfen, wirkt auf den nächsten Lauf', async () => {
  const { nextAutoSearchFocus } = await import('../../shared/autoSearch.js');
  const sequence = (percent: number) => {
    const counts = { kapitalanlage_vertrieb: 0, finanzdienstleister: 0 };
    let text = '';
    for (let i = 0; i < 10; i++) {
      const focus = nextAutoSearchFocus(counts, percent);
      counts[focus as 'kapitalanlage_vertrieb' | 'finanzdienstleister']++;
      text += focus === 'kapitalanlage_vertrieb' ? 'K' : 'F';
    }
    return text;
  };
  assert.equal(sequence(70), 'KKKFKKFKKF', '70 % – von 10 Läufen 7 Kapitalanlage, aufgerundet');
  assert.equal(sequence(100), 'KKKKKKKKKK');
  assert.equal(sequence(0), 'FFFFFFFFFF');

  const { app } = autoApp();
  const admin = await login(app, 'admin');
  assert.equal((await schedules(app, admin)).nick.kapitalanlagePercent, 50, 'Standard 50');
  const saved = await save(app, admin, 'nick', plan({ kapitalanlagePercent: 0 }));
  assert.equal(saved.kapitalanlagePercent, 0);
  assert.equal(saved.nextFocus, 'finanzdienstleister');
  // Fehlt das Feld, bleibt der gespeicherte Wert.
  assert.equal((await save(app, admin, 'nick', plan())).kapitalanlagePercent, 0);
  for (const bad of [55, 110, -10]) {
    const response = await req(app, admin, 'PUT', '/api/auto-search/nick', plan({ kapitalanlagePercent: bad }));
    assert.equal(response.statusCode, 400, `${bad}`);
    assert.equal(response.json().error.field, 'kapitalanlagePercent');
  }
  await app.close();
});

test('50/50 der Läufe: jeder Lauf sucht nur eine Zielgruppe, gezählt je Gründer, sichtbar im Zeitplan', async () => {
  const { app } = autoApp();
  const admin = await login(app, 'admin');
  await save(app, admin, 'nick', plan());
  const runs: { focus?: string; keywords: string[] }[] = [];
  for (let i = 0; i < 4; i++) {
    const before = (await schedules(app, admin)).nick;
    const response = await req(app, admin, 'POST', '/api/auto-search/nick/run');
    assert.equal(response.statusCode, 202, response.body);
    const { runId } = response.json() as { runId: string };
    await waitForEnd(app, admin, runId);
    await app.autoSearch.idle();
    const after = (await schedules(app, admin)).nick;
    assert.equal(after.lastRun?.focus, before.nextFocus);
    runs.push({ focus: after.lastRun?.focus, keywords: (await run(app, admin, runId)).profile.keywords });
  }
  assert.deepEqual(runs.map((entry) => entry.focus), ['kapitalanlage_vertrieb', 'finanzdienstleister', 'kapitalanlage_vertrieb', 'finanzdienstleister']);
  assert.ok(runs[0].keywords.every((term) => !/bau|projekt|finanz/i.test(term)), 'Kapitalanlage-Lauf ohne Bauträger- und Finanz-Begriffe');
  assert.ok(runs[1].keywords.every((term) => /finanz/i.test(term)), 'Finanzdienstleister-Lauf nur mit Finanz-Begriffen');
  const nick = (await schedules(app, admin)).nick;
  assert.deepEqual(nick.focusCounts, { kapitalanlage_vertrieb: 2, finanzdienstleister: 2, bautraeger_projektentwickler: 0 });
  assert.equal((await schedules(app, admin)).johannes.focusCounts?.kapitalanlage_vertrieb, 0, 'je Gründer');
  await app.close();
});

/** Planer weiterlaufen lassen: Uhr jeweils um die Pause vorstellen, prüfen, warten. */
async function runFollowUps(app: App, clock: { now: number }, times = 6) {
  for (let i = 0; i < times; i++) {
    clock.now += AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES * MINUTE;
    await app.autoSearch.tick();
    await app.autoSearch.idle();
  }
}

test('Tagesziel: weitere Läufe bis x Leads, höchstens y Läufe, mit Pause dazwischen', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  // Ziel 100 bei höchstens 2 Läufen: Die Simulation bringt weniger als 100 → nach 2 Läufen Schluss.
  const saved = await save(app, nick, 'nick', { ...plan(), dailyTarget: 100, maxRounds: 2 });
  assert.equal(saved.dailyTarget, 100);
  assert.equal(saved.maxRounds, 2);
  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  // Folgelauf erst nach der Pause – nicht direkt hinterher.
  assert.equal((await schedules(app, nick)).nick.today?.rounds, 1);
  clock.now += (AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES - 1) * MINUTE;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.today?.rounds, 1, 'Pause noch nicht vorbei');
  await runFollowUps(app, clock);
  const after = (await schedules(app, nick)).nick;
  assert.equal(after.today?.day, '2026-10-05');
  assert.equal(after.today?.rounds, 2);
  assert.equal(after.lastRun?.startedAt, MONDAY_0700 + AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES * MINUTE + 10_000, 'Folgelauf geplant nach der Pause');
  assert.ok(after.today!.created >= 7 && after.today!.created < 100, `created ${after.today?.created}`);
  // Alle übergebenen Leads liegen beim Gründer.
  const leads = (await req(app, nick, 'GET', '/api/leads?owner=nick&limit=500')).json() as LeadListResponse;
  assert.ok(leads.leads.filter((lead) => lead.origin.kind === 'search').length >= after.today!.created);
  assert.equal(after.lastRun?.status, 'done');
  // Speichern ohne die neuen Felder (ältere Oberfläche) behält sie.
  const kept = await save(app, nick, 'nick', plan());
  assert.deepEqual([kept.dailyTarget, kept.maxRounds], [100, 2]);
  await app.close();
});

test('Tagesziel: weiter auch nach einem Lauf ohne Lead – Schluss erst, wenn kein ungeprüftes Profil mehr kommt', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', { ...plan(), dailyTarget: 100, maxRounds: 10 });
  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  await runFollowUps(app, clock, 10);
  // Simulation: 7, dann 5, dann 0 neue Leads (aber noch ungeprüfte Profile) → ein vierter Lauf; der findet nur noch
  // Geprüftes (Suche ausgeschöpft) → Schluss, obwohl 10 Läufe erlaubt wären. Bis 11.10. war schon nach dem dritten Schluss.
  const after = (await schedules(app, nick)).nick;
  const { stopReason, ...today } = after.today ?? {};
  assert.deepEqual(today, { day: '2026-10-05', created: 12, rounds: 4, costEur: 0.5222, profileFetches: 31 });
  // Der Grund steht im Zeitplan (Wunsch des Nutzers 13.10.: „nicht genug Leads gefunden“ – warum?).
  assert.match(stopReason ?? '', /keine ungeprüften Profile mehr/);
  assert.equal(after.lastRun?.created, 0);
  assert.equal(after.lastRun?.status, 'done');
  await app.close();
});

test('Tagesziel erreicht: nur ein Lauf; ohne Ziel wie bisher ein Lauf; „Jetzt ausführen“ zählt mit', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', { ...plan(), dailyTarget: 5, maxRounds: 4 });
  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.deepEqual((await schedules(app, nick)).nick.today, {
    day: '2026-10-05',
    created: 7,
    rounds: 1,
    costEur: 0.2581,
    stopReason: null,
    profileFetches: 15,
  });

  const johannes = await login(app, 'johannes');
  await save(app, johannes, 'johannes', { ...plan(), dailyTarget: 50 });
  const started = await req(app, johannes, 'POST', '/api/auto-search/johannes/run');
  assert.equal(started.statusCode, 202);
  await app.autoSearch.idle();
  const today = (await schedules(app, johannes)).johannes.today;
  assert.equal(today?.rounds, 1, 'Folgelauf erst nach der Pause');

  // dailyTarget: null schaltet das Ziel aus; ungültige Werte → 400 mit Feld.
  assert.equal((await save(app, johannes, 'johannes', { ...plan(), dailyTarget: null })).dailyTarget, null);
  for (const [body, field] of [
    [{ ...plan(), dailyTarget: 0 }, 'dailyTarget'],
    [{ ...plan(), dailyTarget: 101 }, 'dailyTarget'],
    [{ ...plan(), maxRounds: 101 }, 'maxRounds'],
    [{ ...plan(), maxRounds: 1.5 }, 'maxRounds'],
  ] as const) {
    const response = await req(app, johannes, 'PUT', '/api/auto-search/johannes', body);
    assert.deepEqual([response.statusCode, errorOf(response).field], [400, field]);
  }
  await app.close();
});

test('„Jetzt einmal ausführen“ sucht bis zum Tagesziel weiter (22.10.) – auch bei ausgeschaltetem Zeitplan, gezählt ab dem Klick', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  // Tagesziel schon erreicht durch einen Termin: der Klick zählt neu.
  await save(app, nick, 'nick', { ...plan(), dailyTarget: 5, maxRounds: 10 });
  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.today?.created, 7);

  await save(app, nick, 'nick', { ...plan({ enabled: false }), dailyTarget: 10, maxRounds: 10 });
  const started = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.equal(started.statusCode, 202, started.body);
  await app.autoSearch.idle();
  // In der Pause zwischen zwei Läufen sagt der Stand, dass es weitergeht (22.10.).
  const paused = (await schedules(app, nick)).nick;
  assert.equal(paused.lastRun?.status, 'done');
  assert.equal(paused.followUpAt, clock.now + AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES * MINUTE);
  assert.equal(paused.followUpManual, true);
  await runFollowUps(app, clock, 10);
  const after = (await schedules(app, nick)).nick;
  assert.ok((after.today?.rounds ?? 0) >= 3, `nach dem Klick mehrere Läufe (${after.today?.rounds})`);
  assert.equal(after.lastRun?.manual, true, 'Folgeläufe gehören zum Klick');
  assert.equal(after.enabled, false, 'Plan bleibt aus');
  assert.equal(after.followUpAt, null, 'nach dem Stopp nichts mehr eingereiht');
  await app.close();
});

test('„Jetzt einmal ausführen“ ohne Tagesziel: genau ein Lauf', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', { ...plan({ enabled: false }), dailyTarget: null });
  const started = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.equal(started.statusCode, 202, started.body);
  await app.autoSearch.idle();
  await runFollowUps(app, clock, 3);
  assert.equal((await schedules(app, nick)).nick.today?.rounds, 1);
  await app.close();
});

// ── Nachbesserungen 08.10. (Kontingent, KI-Ausfall, Neustart, Mitternacht) ─────

test('Folgelauf in seiner Pause hält den Termin des anderen Gründers nicht auf', async () => {
  const { app, clock } = autoApp();
  const admin = await login(app, 'admin');
  await save(app, admin, 'nick', { ...plan(), dailyTarget: 100, maxRounds: 4 });
  await save(app, admin, 'johannes', plan({ time: '07:01' }));
  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  clock.now = MONDAY_0700 + MINUTE + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const both = await schedules(app, admin);
  assert.equal(both.johannes.lastRun?.status, 'done');
  assert.equal(both.johannes.lastRun?.startedAt, MONDAY_0700 + MINUTE);
  assert.equal(both.nick.today?.rounds, 1, 'Nicks Folgelauf wartet noch auf das Ende der Pause');
  clock.now = MONDAY_0700 + AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES * MINUTE + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, admin)).nick.today?.rounds, 2);
  await app.close();
});

test('Suche überspringt schon geprüfte Profile beim Zählen (Simulation und Live, mit Seitengrenze)', async () => {
  const profile = { ...DEFAULT_SEARCH_PROFILE, keywords: ['Kapitalanlage'], positions: ['Geschäftsführer'], maxResults: 5 };
  const ctx = { signal: new AbortController().signal, runId: 'test', profile };
  // Simulation: ohne `skip` die ersten 5, mit den ersten 5 als geprüft 10 Treffer, davon 5 neue.
  const mock = new MockAdapter(0);
  const plain = await mock.search(profile, { maxHits: 5, onHits: () => {} }, ctx);
  assert.equal(plain.length, 5);
  const deeper = await mock.search(profile, { maxHits: 5, onHits: () => {}, skip: new Set(plain.map((hit) => hit.providerId)) }, ctx);
  assert.equal(deeper.length, 10);
  assert.deepEqual(deeper.slice(0, 5), plain);

  // Live (nachgebautes Unipile): erste Seite nur Geprüfte → nächste Seite derselben Suche.
  for (const searchApi of ['classic', 'sales_navigator'] as const) {
    const unipile = await startFakeUnipile();
    try {
      const config = loadConfig({
        LEAD_SEARCH_MODE: 'live',
        UNIPILE_DSN: unipile.baseUrl,
        UNIPILE_API_KEY: 'unipile-test-key',
        UNIPILE_SEARCH_API: searchApi,
        DATA_DIR: tempDataDir(),
      });
      const adapter = createLiveAdapter(config, { pause: async () => {} });
      const skip = new Set(Array.from({ length: 10 }, (_, i) => `ACoTEST${i + 1}`));
      const hits = await adapter.search(profile, { maxHits: 5, onHits: () => {}, skip }, ctx);
      const fresh = hits.filter((hit) => !skip.has(hit.providerId)).map((hit) => hit.providerId);
      assert.deepEqual(fresh, ['ACoTEST11', 'ACoTEST12', 'ACoTEST13', 'ACoTEST14', 'ACoTEST15'], searchApi);
      const searches = unipile.requests.filter((request) => request.path.endsWith('/linkedin/search')).length;
      // Sales Navigator holt mit `skip` gleich eine volle Seite (25) – eine Anfrage statt Mini-Seiten.
      assert.equal(searches, searchApi === 'classic' ? 2 : 1, `${searchApi}: Seiten`);
      // Ohne `skip` wie bisher: genau die ersten Treffer, eine Seite.
      const before = unipile.requests.length;
      const first = await adapter.search(profile, { maxHits: 5, onHits: () => {} }, ctx);
      assert.equal(first.length, 5);
      assert.equal(unipile.requests.filter((request, index) => index >= before && request.path.endsWith('/linkedin/search')).length, 1);
    } finally {
      await unipile.close();
    }
  }
});

test('Live ohne Anthropic-Schlüssel: geplanter Lauf übersprungen mit Satz und Neuigkeit, nichts gesucht', async () => {
  const live = { LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: 'https://api1.unipile.com:13111', UNIPILE_API_KEY: 'unipile-test-key' };
  const { app, clock } = autoApp({ env: live });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', { ...plan(), dailyTarget: 50 });
  clock.now = MONDAY_0700 + 1000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const schedule = (await schedules(app, nick)).nick;
  assert.deepEqual(schedule.lastRun, {
    runId: null,
    startedAt: MONDAY_0700,
    finishedAt: MONDAY_0700 + 1000,
    status: 'skipped',
    manual: false,
    created: 0,
    message: AUTO_SEARCH_MESSAGES.noAnthropic,
  });
  assert.equal(schedule.today, null, 'kein Lauf gestartet');
  const notes = (await req(app, nick, 'GET', '/api/notifications')).json() as NotificationListResponse;
  assert.ok(notes.notifications.some((note) => note.kind === 'search_failed' && note.text === AUTO_SEARCH_MESSAGES.noAnthropic));
  await app.close();

  // Mit Schlüssel läuft derselbe Termin.
  const withKey = autoApp({ env: { ...live, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const nick2 = await login(withKey.app, 'nick');
  await save(withKey.app, nick2, 'nick', plan());
  withKey.clock.now = MONDAY_0700 + 1000;
  await withKey.app.autoSearch.tick();
  await withKey.app.autoSearch.idle();
  assert.equal((await schedules(withKey.app, nick2)).nick.lastRun?.status, 'done');
  await withKey.app.close();
});

/** Simulation mit einstellbarem LinkedIn-Account-Status für die regelmäßige Unipile-Prüfung. */
class AccountAdapter extends MockAdapter {
  state: LinkedinAccountStatus['state'] = 'reconnect';
  constructor() {
    super(0);
  }
  async accountStatus(): Promise<LinkedinAccountStatus> {
    return { state: this.state, name: null, message: this.state === 'ok' ? '' : 'Der Unipile-Testzeitraum ist abgelaufen.' };
  }
}

test('Unipile laut Prüfung down: geplanter Lauf übersprungen mit Satz, keine zusätzliche Suchmeldung; „Jetzt ausführen“ versucht es', async () => {
  const live = { LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: 'https://api1.unipile.com:13111', UNIPILE_API_KEY: 'unipile-test-key', ANTHROPIC_API_KEY: 'sk-ant-test' };
  const adapter = new AccountAdapter();
  const { app, clock } = autoApp({ env: live, adapter });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', plan());
  await app.unipileWatch.check();
  const before = (await req(app, nick, 'GET', '/api/notifications')).json() as NotificationListResponse;
  assert.ok(before.notifications.some((note) => note.kind === 'unipile_down'), 'Unipile-Meldung steht');

  clock.now = MONDAY_0700 + 1000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const schedule = (await schedules(app, nick)).nick;
  assert.deepEqual(schedule.lastRun, {
    runId: null,
    startedAt: MONDAY_0700,
    finishedAt: MONDAY_0700 + 1000,
    status: 'skipped',
    manual: false,
    created: 0,
    message: AUTO_SEARCH_MESSAGES.unipileDown,
  });
  assert.match(AUTO_SEARCH_MESSAGES.unipileDown, /^Übersprungen: Unipile ist gerade nicht erreichbar – siehe Meldung/);
  assert.equal(schedule.today, null, 'kein Lauf gestartet');
  const notes = (await req(app, nick, 'GET', '/api/notifications')).json() as NotificationListResponse;
  assert.ok(!notes.notifications.some((note) => note.kind === 'search_failed'), 'keine zusätzliche Meldung (und kein Slack)');

  // Von Hand darf es trotzdem versucht werden.
  const manual = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.equal(manual.statusCode, 202, manual.body);
  await waitForEnd(app, nick, manual.json().runId);
  await app.autoSearch.idle();

  // Unipile wieder da → Meldung weg, nächster Termin läuft.
  adapter.state = 'ok';
  await app.unipileWatch.check();
  clock.now = MONDAY_0700 + 7 * 24 * 60 * MINUTE + 1000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  assert.equal((await schedules(app, nick)).nick.lastRun?.status, 'done');
  await app.close();
});

/** Simulation, deren KI-Abruf scheitert (Anthropic nicht erreichbar) – Leads enden als „failed“. */
class AiDownAdapter extends MockAdapter {
  constructor() {
    super(0);
  }
  override async qualify(): Promise<unknown> {
    throw new AdapterError('provider', 'KI nicht erreichbar', 'Anthropic hat nicht geantwortet.', false);
  }
  // Fällt die KI aus, scheitert auch die Vorprüfung – der Lauf geht ohne sie weiter.
  override async prescreen(): Promise<Map<string, PrescreenVerdict>> {
    throw new AdapterError('provider', 'KI nicht erreichbar', 'Anthropic hat nicht geantwortet.', false);
  }
}

test('KI fällt aus: Lauf failed „KI-Bewertung fehlgeschlagen“, Neuigkeit, kein Folgelauf, Profile nicht gemerkt', async () => {
  const { app, clock } = autoApp({ adapter: new AiDownAdapter() });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', { ...plan(), dailyTarget: 50, maxRounds: 4 });
  clock.now = MONDAY_0700 + 1000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  await runFollowUps(app, clock);
  const schedule = (await schedules(app, nick)).nick;
  assert.equal(schedule.lastRun?.status, 'failed');
  assert.equal(schedule.lastRun?.message, AUTO_SEARCH_MESSAGES.aiFailed);
  assert.equal(schedule.lastRun?.created, 0);
  assert.equal(schedule.today?.rounds, 1, 'kein Folgelauf');
  assert.deepEqual(
    app.autoSearch.store.checked('nick', clock.now).length,
    (await run(app, nick, schedule.lastRun!.runId!)).leads.filter((lead) => lead.profile && lead.status === 'duplicate').length,
    'nur Endergebnisse gemerkt',
  );
  const notes = (await req(app, nick, 'GET', '/api/notifications')).json() as NotificationListResponse;
  assert.ok(notes.notifications.some((note) => note.kind === 'search_failed' && note.text === AUTO_SEARCH_MESSAGES.aiFailed));

  // Einzelner KI-Fehler bei sonst bewerteten Leads ist kein Ausfall.
  const lead = (status: LeadStatus, profile = true) => ({ status, profile: profile ? {} : null }) as unknown as PipelineLead;
  assert.equal(mostlyUnrated({ leads: [lead('rejected'), lead('rejected'), lead('failed')] }), false);
  assert.equal(mostlyUnrated({ leads: [lead('rejected'), lead('unrated'), lead('failed')] }), true);
  assert.equal(mostlyUnrated({ leads: [lead('rejected'), lead('failed', false), lead('failed', false)] }), false, 'Profilabruf-Fehler zählen nicht');
  await app.close();
});

test('Keine gemeinsame Tagesgrenze mehr (31.10.): alter Wert wird ignoriert, nur die Grenzen je Account bremsen', async () => {
  // Früher bremste `AUTO_SEARCH_PROFILES_PER_DAY` alle Läufe beider Gründer zusammen – auch wenn die LinkedIn-Accounts
  // noch viel Platz hatten (Nutzer: „gestoppt bei 90, obwohl acht Accounts frei sind“). Ein alter Wert in `.env` wirkt nicht mehr.
  const { app, clock } = autoApp({ env: { AUTO_SEARCH_PROFILES_PER_DAY: '20' } });
  const nick = await login(app, 'nick');
  const admin = await login(app, 'admin');
  const manual = await req(app, admin, 'POST', '/api/lead-search/runs', { profile: DEFAULT_SEARCH_PROFILE });
  assert.equal(manual.statusCode, 202, manual.body);
  await waitForEnd(app, nick, (manual.json() as { run: RunSnapshot }).run.id);
  assert.equal(app.autoSearch.store.profileFetches('2026-10-05'), 15, 'Zähler läuft weiter – nur zur Info');

  await save(app, nick, 'nick', { ...plan(), dailyTarget: 100, maxRounds: 4 });
  clock.now = MONDAY_0700 + 1000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  await runFollowUps(app, clock);
  const schedule = (await schedules(app, nick)).nick;
  const first = await run(app, nick, schedule.lastRun!.runId!);
  assert.equal(first.profile.maxResults, DEFAULT_SEARCH_PROFILE.maxResults, 'maxResults nicht gekürzt');
  assert.ok((schedule.today?.rounds ?? 0) > 1, 'Folgeläufe trotz 20er-Wert');
  assert.ok((schedule.today?.profileFetches ?? 0) > 20);
  assert.equal(schedule.today?.profilesPerDay, undefined);
  assert.doesNotMatch(schedule.today?.stopReason ?? '', /Profilabrufen/);

  // „Jetzt ausführen“ startet weiter.
  const now = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.equal(now.statusCode, 202, now.body);
  await app.autoSearch.idle();
  await app.close();
});

test('Neustart, während ein fälliger Termin wartet: beim Start skipped mit Satz statt still verloren', async () => {
  const dataDir = tempDataDir();
  const adapter = new GatedAdapter();
  const { app, clock } = autoApp({ dataDir, adapter });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', plan());
  // Eine Suche von Hand belegt die Suche – der Termin wartet.
  const manual = await req(app, nick, 'POST', '/api/lead-search/runs', { profile: DEFAULT_SEARCH_PROFILE });
  const manualId = (manual.json() as { run: RunSnapshot }).run.id;
  clock.now = MONDAY_0700 + 1000;
  await app.autoSearch.tick();
  assert.deepEqual(app.autoSearch.store.pending('nick'), { startedAt: MONDAY_0700, day: '2026-10-05' });
  adapter.release();
  await waitForEnd(app, nick, manualId);
  await app.close();

  const second = autoApp({ dataDir, clock: { now: MONDAY_0700 + 3 * MINUTE } });
  const lastRun = (await schedules(second.app, await login(second.app, 'nick'))).nick.lastRun;
  assert.deepEqual(lastRun, {
    runId: null,
    startedAt: MONDAY_0700,
    finishedAt: MONDAY_0700 + 3 * MINUTE,
    status: 'skipped',
    manual: false,
    created: 0,
    message: AUTO_SEARCH_MESSAGES.restartedPending,
  });
  assert.equal(second.app.autoSearch.store.pending('nick'), null);
  // Gestartete Termine hinterlassen keine Markierung.
  await second.app.autoSearch.tick();
  second.clock.now = MONDAY_0700 + 7 * 24 * 60 * MINUTE + 1000;
  await second.app.autoSearch.tick();
  await second.app.autoSearch.idle();
  assert.equal(second.app.autoSearch.store.pending('nick'), null);
  assert.equal(second.app.autoSearch.store.lastRun('nick')?.status, 'done');
  await second.app.close();
});

test('Lauf über Mitternacht: Läufe und Leads zählen für den Tag des Termins, kein Folgelauf am neuen Tag', async () => {
  const adapter = new GatedAdapter();
  const monday2358 = Date.UTC(2026, 9, 5, 21, 58); // Mo 23:58 Berlin
  const { app, clock } = autoApp({ adapter, clock: { now: monday2358 - 10 * MINUTE } });
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', { ...plan({ time: '23:58' }), dailyTarget: 100, maxRounds: 4 });
  clock.now = monday2358 + 1000;
  // Nicht abwarten: tick() wartet auf das Ende des (noch gesperrten) Laufs.
  const ticked = app.autoSearch.tick();
  const runId = (await schedules(app, nick)).nick.lastRun!.runId!;
  assert.equal((await schedules(app, nick)).nick.lastRun?.status, 'running');
  clock.now = monday2358 + 7 * MINUTE; // Di 00:05
  adapter.release();
  await waitForEnd(app, nick, runId);
  await ticked;
  await app.autoSearch.idle();
  await runFollowUps(app, clock);
  assert.deepEqual(app.autoSearch.store.today('nick', '2026-10-05'), {
    day: '2026-10-05',
    created: 7,
    rounds: 1,
    costEur: 0.2581,
    stopReason: 'Gestoppt: Der Tag des Termins ist vorbei.',
  });
  const schedule = (await schedules(app, nick)).nick;
  assert.equal(schedule.today, null, 'am neuen Tag lief noch nichts');
  assert.equal(schedule.lastRun?.runId, runId, 'kein Folgelauf');
  await app.close();
});

test('Stichwörter mit „Kapitalanlage“ bleiben bei Kapitalanlage, auch mit „bau“', () => {
  const keywords = ['Kapitalanlage Neubau', 'Bauträger', 'Kapitalanlageimmobilien Projektentwicklung', 'Immobilienvertrieb'];
  assert.deepEqual(focusKeywords(keywords, 'kapitalanlage_vertrieb'), ['Kapitalanlage Neubau', 'Kapitalanlageimmobilien Projektentwicklung', 'Immobilienvertrieb']);
  assert.deepEqual(focusKeywords(keywords, 'bautraeger_projektentwickler'), ['Bauträger']);
});

test('Bauträger-Begriffe: Entwicklung zählt dazu, Baufinanzierung und „Aufbau Vertrieb“ nicht', () => {
  const keywords = ['Immobilienentwicklung', 'Baufinanzierung', 'Aufbau Vertrieb', 'Bauunternehmen', 'Wohnungsbau', 'Real Estate Development', 'Kapitalanlage Projektentwicklung'];
  assert.deepEqual(focusKeywords(keywords, 'bautraeger_projektentwickler'), ['Immobilienentwicklung', 'Bauunternehmen', 'Wohnungsbau', 'Real Estate Development']);
  assert.deepEqual(focusKeywords(keywords, 'kapitalanlage_vertrieb'), ['Baufinanzierung', 'Aufbau Vertrieb', 'Kapitalanlage Projektentwicklung']);
  assert.deepEqual(focusKeywords(['Baufinanzierung'], 'bautraeger_projektentwickler'), ['Bauträger', 'Projektentwicklung', 'Projektentwickler']);
});

test('Bauträger-Begriffe: „Business Development“ gehört zu Kapitalanlage, Property Development zu Bauträger', () => {
  const keywords = ['Business Development', 'Property Development', 'Immobilien Development'];
  assert.deepEqual(focusKeywords(keywords, 'kapitalanlage_vertrieb'), ['Business Development']);
  assert.deepEqual(focusKeywords(keywords, 'bautraeger_projektentwickler'), ['Property Development', 'Immobilien Development']);
});

test('Bauträger-Begriffe: nicht jedes „Projekt“ – „Projektvertrieb“ gehört zu Kapitalanlage, Projektgesellschaft und Bauprojekt zu Bauträger', () => {
  const keywords = ['Projektvertrieb', 'Projektentwicklung', 'Projektgesellschaft', 'Bauprojekte', 'Projekt-Development'];
  assert.deepEqual(focusKeywords(keywords, 'kapitalanlage_vertrieb'), ['Projektvertrieb']);
  assert.deepEqual(focusKeywords(keywords, 'bautraeger_projektentwickler'), ['Projektentwicklung', 'Projektgesellschaft', 'Bauprojekte', 'Projekt-Development']);
});

test('KI-Tagesbudget: Geld statt Läufe – weiter trotz maxRounds, Schluss beim Budget', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  // maxRounds 1 gilt mit Budget nicht – gezählt wird das Geld (Simulation: ca. 0,26 € je Lauf).
  const saved = await save(app, nick, 'nick', { ...plan(), dailyTarget: 100, maxRounds: 1, dailyBudgetEur: 0.5 });
  assert.equal(saved.dailyBudgetEur, 0.5);
  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  await runFollowUps(app, clock, 6);
  const today = (await schedules(app, nick)).nick.today!;
  assert.ok(today.rounds >= 2, `mehr als ein Lauf trotz maxRounds 1 (${today.rounds})`);
  assert.ok((today.costEur ?? 0) >= 0.5, `Budget ausgeschöpft (${today.costEur})`);
  assert.ok((today.costEur ?? 0) < 0.5 + 0.3, `höchstens ein Lauf über dem Budget (${today.costEur})`);

  // Budget aufgebraucht: „Jetzt ausführen“ meldet es, der nächste Termin desselben Tages wird übersprungen.
  const now = await req(app, nick, 'POST', '/api/auto-search/nick/run');
  assert.equal(now.statusCode, 400);
  assert.equal((now.json() as { error: { message: string } }).error.message, AUTO_SEARCH_MESSAGES.budget(0.5));
  await app.close();
});

test('KI-Tagesbudget: Rest zu klein → der Lauf liest keine Profile, Treffer sind „beim nächsten Lauf dran“', async () => {
  const { app, clock } = autoApp();
  const nick = await login(app, 'nick');
  await save(app, nick, 'nick', { ...plan(), dailyBudgetEur: 1 });
  app.autoSearch.store.addToday('nick', '2026-10-05', { costEur: 0.99 });
  clock.now = MONDAY_0700 + 10_000;
  await app.autoSearch.tick();
  await app.autoSearch.idle();
  const lastRun = (await schedules(app, nick)).nick.lastRun!;
  assert.equal(lastRun.status, 'done');
  assert.equal(lastRun.created, 0);
  const run = (await req(app, nick, 'GET', `/api/lead-search/runs/${lastRun.runId}`)).json() as { run: RunSnapshot };
  const deferred = run.run.leads.filter((lead) => lead.note === 'KI-Tagesbudget erreicht – beim nächsten Lauf dran');
  assert.ok(deferred.length > 0);
  assert.ok(!run.run.leads.some((lead) => lead.profile), 'kein Profil gelesen');
  await app.close();
});

test('KI-Tagesbudget: Prüfung der Eingabe, null schaltet es aus, fehlt es, bleibt es', async () => {
  const { app } = autoApp();
  const nick = await login(app, 'nick');
  for (const value of [0.1, 1001, 10.123, 'x']) {
    const response = await req(app, nick, 'PUT', '/api/auto-search/nick', { ...plan(), dailyBudgetEur: value });
    assert.equal(response.statusCode, 400, String(value));
    assert.equal((response.json() as { error: { field: string } }).error.field, 'dailyBudgetEur');
  }
  assert.equal((await save(app, nick, 'nick', { ...plan(), dailyBudgetEur: 10.1 })).dailyBudgetEur, 10.1);
  assert.equal((await save(app, nick, 'nick', plan())).dailyBudgetEur, 10.1, 'fehlt → bleibt');
  assert.equal((await save(app, nick, 'nick', { ...plan(), dailyBudgetEur: null })).dailyBudgetEur, null);
  await app.close();
});
