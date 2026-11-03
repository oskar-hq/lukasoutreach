import { expect, test, type Page } from '@playwright/test';
import {
  AUTO_SEARCH_DEFAULTS,
  AUTO_SEARCH_TIME_ZONE,
  type AutoSearchLastRun,
  type AutoSearchSchedule,
  type AutoSearchUpdate,
} from '../shared/autoSearch';
import type { AuthFounderId, AuthUser } from '../shared/auth';
import { DEFAULT_SEARCH_PROFILE } from '../shared/leadSearch';
import { fail, realSession, resetCockpit, signIn, trackErrors, gotoSettings, openSettingsSection } from './helpers';

/** Jeder Test beginnt mit den 30 Demo-Leads (alle Tests teilen sich ein Mock-Backend). */
test.beforeEach(async ({ request }) => resetCockpit(request));

/**
 * Einstellungen → „Automatische Suche“ gegen nachgebaute `/api/auto-search*` nach `shared/autoSearch.ts`
 * (vereinfacht: `nextRunAt` fest, ein Lauf wechselt erst auf Zuruf des Tests von running auf done).
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ADMIN: AuthUser = { username: 'admin', name: 'Admin', founder: null, role: 'admin' };
const ANNA: AuthUser = { username: 'mitarbeiter', name: 'Anna', founder: 'nick', role: 'assistant' };

/** 400 und 409 gehören zu diesen Tests – der Browser meldet sie als Konsolenfehler. */
const expectedStatus = (text: string) => /status of (400|409)\b/.test(text);

/** In drei Tagen – die Oberfläche zeigt dann den Wochentag in deutscher Zeit. */
const NEXT = Date.now() + 3 * DAY;
const berlin = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('de-DE', { timeZone: AUTO_SEARCH_TIME_ZONE, ...options }).format(NEXT);
const NEXT_TIME = berlin({ hour: '2-digit', minute: '2-digit' });
/** „Mittwoch, 07:00“ */
const NEXT_LONG = `${berlin({ weekday: 'long' })}, ${NEXT_TIME}`;
/** „Mi 07:00“ */
const NEXT_SHORT = `${berlin({ weekday: 'long' }).slice(0, 2)} ${NEXT_TIME}`;

function schedule(founder: AuthFounderId, overrides: Partial<AutoSearchSchedule> = {}): AutoSearchSchedule {
  return {
    founder,
    ...AUTO_SEARCH_DEFAULTS,
    days: [...AUTO_SEARCH_DEFAULTS.days],
    profile: { ...DEFAULT_SEARCH_PROFILE },
    nextRunAt: null,
    lastRun: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

type RunAnswer = 'ok' | 'busy' | 'config';

/**
 * Baut `/api/auto-search*` nach. `as` = nachgebautes Konto (`/api/auth/me`); ohne `as` meldet sich der Test
 * echt als nick an, und das Konto sieht nur Nicks Plan.
 */
async function fakeAutoSearch(page: Page, { as, schedules }: { as?: AuthUser; schedules: AutoSearchSchedule[] }) {
  if (as) {
    await realSession(page);
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: as } }));
  }
  const me = as ?? { username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' };
  const state = schedules.map((entry) => structuredClone(entry));
  const puts: { founder: string; body: AutoSearchUpdate }[] = [];
  const runAnswers: RunAnswer[] = [];
  let lists = 0;
  let nextPutError: { status: number; code: string; message: string; field?: string } | null = null;
  let runs = 0;

  await page.route(/\/api\/auto-search(\/[^?]*)?(\?.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (me.role === 'assistant') return fail(route, 403, 'not_allowed', 'Dafür fehlen deinem Konto die Rechte.');
    const visible = () => (me.role === 'admin' ? state : state.filter((entry) => entry.founder === me.founder));

    if (request.method() === 'GET' && path === '/api/auto-search') {
      lists++;
      return route.fulfill({ json: { schedules: visible(), timeZone: AUTO_SEARCH_TIME_ZONE } });
    }
    const [, , , founder, action] = path.split('/');
    const target = visible().find((entry) => entry.founder === founder);
    if (!target) return fail(route, 403, 'not_allowed', 'Dafür fehlen deinem Konto die Rechte.');

    if (request.method() === 'PUT' && !action) {
      const body = request.postDataJSON() as AutoSearchUpdate;
      puts.push({ founder, body });
      if (nextPutError) {
        const error = nextPutError;
        nextPutError = null;
        return fail(route, error.status, error.code, error.message, { field: error.field });
      }
      Object.assign(target, body, { nextRunAt: body.enabled ? NEXT : null, updatedAt: Date.now(), updatedBy: me.name });
      return route.fulfill({ json: target });
    }
    if (request.method() === 'POST' && action === 'run') {
      const answer = runAnswers.shift() ?? 'ok';
      if (answer === 'busy') return route.fulfill({ status: 409, json: { error: { code: 'busy', message: 'Es läuft schon eine Suche – versuch es gleich noch einmal.', runId: 'run-x' } } });
      if (answer === 'config') return fail(route, 400, 'config', 'Live-Modus ist noch nicht eingerichtet: UNIPILE_API_KEY fehlt.');
      const runId = `run-${++runs}`;
      target.lastRun = { runId, startedAt: Date.now(), finishedAt: null, status: 'running', manual: true, created: 0, message: null };
      return route.fulfill({ status: 202, json: { runId } });
    }
    return fail(route, 404, 'not_found', 'Unbekannt.');
  });

  return {
    puts,
    lists: () => lists,
    answerRun: (...answers: RunAnswer[]) => runAnswers.push(...answers),
    failNextPut: (status: number, code: string, message: string, field?: string) => {
      nextPutError = { status, code, message, field };
    },
    finishRun: (founder: AuthFounderId, created: number) => {
      const target = state.find((entry) => entry.founder === founder)!;
      target.lastRun = { ...(target.lastRun as AutoSearchLastRun), status: 'done', finishedAt: Date.now(), created };
    },
  };
}

async function openAutoSearch(page: Page, { signInAsNick = true } = {}) {
  await page.goto('/?ping=off');
  if (signInAsNick) await signIn(page, 'nick');
  else await expect(page.getByTestId('home')).toBeVisible();
  await gotoSettings(page);
  await openSettingsSection(page, 'auto');
  await expect(page.getByTestId('auto-search')).toBeVisible();
}

const day = (page: Page, value: number) => page.getByTestId(`auto-day-${value}`);

test('Gründer: sieht nur den eigenen Plan mit Standardwerten, Speichern schickt den ganzen Plan', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAutoSearch(page, { schedules: [schedule('nick')] });
  await openAutoSearch(page);

  // Kein Gründer-Wechsel, Standardwerte: aus, werktags 07:00, Profil der Lead-Suche.
  await expect(page.getByRole('tablist', { name: 'Plan von' })).toHaveCount(0);
  await expect(page.getByTestId('auto-next')).toHaveText('Aus');
  await expect(page.getByTestId('auto-last')).toHaveText('noch keiner');
  await expect(page.getByTestId('auto-enabled')).toHaveAttribute('aria-checked', 'false');
  for (const value of [1, 2, 3, 4, 5]) await expect(day(page, value)).toHaveAttribute('aria-pressed', 'true');
  for (const value of [6, 7]) await expect(day(page, value)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('auto-time')).toHaveValue('07:00');
  await page.getByTestId('auto-profile-toggle').click();
  await expect(page.getByTestId('auto-keywords')).toContainText('Kapitalanlage');
  await expect(page.getByTestId('auto-region')).toHaveValue('Deutschland');
  await expect(page.getByTestId('auto-max-results-input')).toHaveValue('15');
  await expect(page.getByTestId('auto-message')).toHaveCount(0);

  // Ändern: Hinweis auf ungespeicherte Änderungen.
  await page.getByTestId('auto-enabled').click();
  await expect(page.getByTestId('auto-message')).toContainText('Ungespeicherte Änderungen');
  await day(page, 1).click();
  await day(page, 6).click();
  await page.getByTestId('auto-time').fill('06:30');
  await page.getByTestId('auto-max-results-input').fill('20');
  await page.getByTestId('auto-region').fill('  Bayern ');
  // Wieder auf den alten Stand → keine Änderung mehr.
  await page.getByTestId('auto-enabled').click();
  await page.getByTestId('auto-enabled').click();

  // ⌘/Strg+↵ im Feld speichert.
  await page.getByTestId('auto-region').press('ControlOrMeta+Enter');
  await expect(page.getByTestId('auto-message')).toHaveText(`Gespeichert – nächster Lauf ${NEXT_LONG}.`);
  expect(fake.puts).toEqual([
    {
      founder: 'nick',
      body: { enabled: true, days: [2, 3, 4, 5, 6], time: '06:30', secondTime: null, profile: { ...DEFAULT_SEARCH_PROFILE, region: 'Bayern', maxResults: 20 }, dailyTarget: null, maxRounds: 4, dailyBudgetEur: 10, kapitalanlagePercent: 50 },
    },
  ]);
  await expect(page.getByTestId('auto-next')).toHaveText(NEXT_LONG);
  // Die Bestätigung verschwindet nach kurzer Zeit.
  await expect(page.getByTestId('auto-message')).toHaveCount(0, { timeout: 8_000 });

  // Ausschalten mit ↵ (Fokus nicht in einem Feld).
  await page.getByTestId('auto-enabled').click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auto-message')).toHaveText('Gespeichert – die automatische Suche ist aus.');
  await expect(page.getByTestId('auto-next')).toHaveText('Aus');
  expect(fake.puts[1].body.enabled).toBe(false);
  expect(errors).toEqual([]);
});

test('Prüfung vor dem Speichern und Serverfehler am Feld', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAutoSearch(page, { schedules: [schedule('nick')] });
  await openAutoSearch(page);
  const save = page.getByTestId('auto-save');

  // An ohne Tag.
  await page.getByTestId('auto-enabled').click();
  for (const value of [1, 2, 3, 4, 5]) await day(page, value).click();
  await save.click();
  await expect(page.getByTestId('auto-days-error')).toHaveText('Wähle mindestens einen Tag.');
  await expect(day(page, 1)).toBeFocused();
  await day(page, 3).click();
  await expect(page.getByTestId('auto-days-error')).toHaveCount(0);

  // Uhrzeit leer.
  await page.getByTestId('auto-time').fill('');
  await save.click();
  await expect(page.getByTestId('auto-time-error')).toHaveText('Bitte eine Uhrzeit wie 07:00 angeben.');
  await expect(page.getByTestId('auto-time')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('auto-time')).toBeFocused();
  await page.getByTestId('auto-time').fill('08:15');

  // 0 und 1001 Profile (Grenze seit 11.10. 1000 statt 25).
  await page.getByTestId('auto-profile-toggle').click();
  for (const count of ['0', '1001']) {
    await page.getByTestId('auto-max-results-input').fill(count);
    await save.click();
    await expect(page.getByTestId('auto-max-results-error')).toHaveText('Pro Lauf 1 bis 1000 Profile.');
    await expect(page.getByTestId('auto-max-results-input')).toBeFocused();
  }
  // − holt in den erlaubten Bereich zurück.
  await page.getByTestId('auto-max-results').getByRole('button', { name: 'Weniger' }).click();
  await expect(page.getByTestId('auto-max-results-input')).toHaveValue('1000');
  await expect(page.getByTestId('auto-max-results-error')).toHaveCount(0);

  // Keine Stichwörter.
  const keywords = page.getByTestId('auto-keywords');
  for (let i = 0; i < DEFAULT_SEARCH_PROFILE.keywords.length; i++) await keywords.getByRole('button', { name: /entfernen$/ }).first().click();
  await save.click();
  await expect(page.getByTestId('auto-keywords-error')).toHaveText('Mindestens ein Stichwort.');
  await keywords.locator('input').fill('Bauträger');
  await keywords.locator('input').press('Enter');
  expect(fake.puts).toEqual([]);

  // Server lehnt ab – mit Feld: Meldung am Feld.
  fake.failNextPut(400, 'invalid_request', 'Diese Uhrzeit geht nicht.', 'time');
  await save.click();
  await expect(page.getByTestId('auto-time-error')).toHaveText('Diese Uhrzeit geht nicht.');
  await expect(page.getByTestId('auto-message')).toContainText('Ungespeicherte Änderungen');
  // Ändern blendet die Servermeldung aus.
  await page.getByTestId('auto-time').fill('08:30');
  await expect(page.getByTestId('auto-time-error')).toHaveCount(0);

  // Ohne Feld: Meldung unten.
  fake.failNextPut(403, 'not_allowed', 'Dafür fehlen deinem Konto die Rechte.');
  await save.click();
  await expect(page.getByTestId('auto-message')).toHaveText('Dafür fehlen deinem Konto die Rechte.');

  await save.click();
  await expect(page.getByTestId('auto-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)!.body).toEqual({
    enabled: true,
    days: [3],
    time: '08:30',
    secondTime: null,
    profile: { ...DEFAULT_SEARCH_PROFILE, keywords: ['Bauträger'], maxResults: 1000 },
    // Ältere Zeitpläne ohne Tagesziel: die Oberfläche schickt die Standardwerte mit (noch nie gespeichert → 10 € Budget).
    dailyTarget: null,
    maxRounds: 4,
    dailyBudgetEur: 10,
    kapitalanlagePercent: 50,
  });
  expect(errors.filter((text) => !/status of 403\b/.test(text))).toEqual([]);
});

test('Admin wählt den Gründer und speichert dessen Plan, letzter Lauf mit Satz', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAutoSearch(page, {
    as: ADMIN,
    schedules: [
      schedule('nick', {
        lastRun: { runId: 'run-a', startedAt: Date.now() - 2 * DAY, finishedAt: Date.now() - 2 * DAY, status: 'failed', manual: false, created: 0, message: 'LinkedIn hat den Zugang verweigert – verbinde den Account neu.' },
      }),
      schedule('johannes', {
        enabled: true,
        days: [1, 3, 5],
        time: '07:00',
        nextRunAt: NEXT,
        updatedAt: Date.now() - 3 * HOUR,
        updatedBy: 'Johannes',
        lastRun: { runId: null, startedAt: Date.now() - DAY, finishedAt: Date.now() - DAY, status: 'skipped', manual: false, created: 0, message: 'Ausgelassen – 30 Minuten lang lief eine andere Suche.' },
      }),
    ],
  });
  await openAutoSearch(page, { signInAsNick: false });

  const picker = page.getByRole('tablist', { name: 'Plan von' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('tab', { name: 'Nick' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('auto-last')).toContainText('LinkedIn hat den Zugang verweigert – verbinde den Account neu.');
  await expect(page.getByTestId('auto-next')).toHaveText('Aus');

  await picker.getByRole('tab', { name: 'Johannes' }).click();
  await expect(page.getByTestId('auto-next')).toHaveText(NEXT_LONG);
  await expect(page.getByTestId('auto-last')).toContainText('Ausgelassen – 30 Minuten lang lief eine andere Suche.');
  for (const value of [1, 3, 5]) await expect(day(page, value)).toHaveAttribute('aria-pressed', 'true');

  // Entwurf bleibt beim Wechseln erhalten.
  await page.getByTestId('auto-profile-toggle').click();
  await page.getByTestId('auto-region').fill('Österreich');
  await picker.getByRole('tab', { name: 'Nick' }).click();
  await expect(page.getByTestId('auto-region')).toHaveValue('Deutschland');
  await expect(page.getByTestId('auto-message')).toHaveCount(0);
  await picker.getByRole('tab', { name: 'Johannes' }).click();
  await expect(page.getByTestId('auto-region')).toHaveValue('Österreich');
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-message')).toContainText('Gespeichert');
  expect(fake.puts).toEqual([
    { founder: 'johannes', body: { enabled: true, days: [1, 3, 5], time: '07:00', secondTime: null, profile: { ...DEFAULT_SEARCH_PROFILE, region: 'Österreich' }, dailyTarget: null, maxRounds: 4, dailyBudgetEur: 10, kapitalanlagePercent: 50 } },
  ]);
  expect(errors).toEqual([]);
});

test('Jetzt einmal ausführen: belegt, nicht eingerichtet, dann Lauf bis „5 neue Leads“', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAutoSearch(page, { schedules: [schedule('nick')] });
  fake.answerRun('busy', 'config', 'ok');
  await openAutoSearch(page);
  const run = page.getByTestId('auto-run');
  const note = page.getByTestId('auto-run-message');

  await run.click();
  await expect(note).toHaveText('Es läuft schon eine Suche – versuch es gleich noch einmal.');
  await run.click();
  await expect(note).toHaveText('Live-Modus ist noch nicht eingerichtet: UNIPILE_API_KEY fehlt.');

  await run.click();
  await expect(note).toHaveText('Läuft – die Leads kommen danach in den Tagesstapel.');
  await expect(page.getByTestId('auto-last')).toContainText('Läuft gerade …');
  await expect(page.getByTestId('auto-to-search')).toBeVisible();
  await expect(run).toBeDisabled();

  // Nach dem nächsten Nachladen (alle 5 s) ist der Lauf fertig.
  fake.finishRun('nick', 5);
  await expect(page.getByTestId('auto-last')).toContainText('(von Hand) · 5 neue Leads im Tagesstapel', { timeout: 12_000 });
  await expect(page.getByTestId('auto-last')).toContainText(/heute|gestern/);
  await expect(note).toHaveCount(0);
  await expect(run).toBeEnabled();

  // Kein Lauf mehr → kein Nachladen mehr.
  const before = fake.lists();
  await page.waitForTimeout(6_000);
  expect(fake.lists()).toBe(before);
  expect(errors).toEqual([]);
});

test('Läuft gerade: Link zur Lead-Suche, Nachladen endet beim Verlassen', async ({ page }) => {
  const fake = await fakeAutoSearch(page, {
    schedules: [schedule('nick', { lastRun: { runId: 'run-9', startedAt: Date.now(), finishedAt: null, status: 'running', manual: false, created: 0, message: null } })],
  });
  await openAutoSearch(page);
  await expect(page.getByTestId('auto-last')).toContainText('Läuft gerade …');
  await page.getByTestId('auto-to-search').click();
  await expect(page.getByTestId('auto-search')).toHaveCount(0);
  await expect(page.getByTestId('start-search').or(page.getByTestId('run-view')).first()).toBeVisible();
  const before = fake.lists();
  await page.waitForTimeout(6_000);
  expect(fake.lists()).toBe(before);
});

test('Startseite: Hinweis auf den nächsten Lauf nur bei eingeschaltetem Plan', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  await fakeAutoSearch(page, { schedules: [schedule('nick', { enabled: true, nextRunAt: NEXT })] });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('home-details-toggle').click();
  await expect(page.getByTestId('home-auto-search')).toHaveText(`Automatische Suche: nächster Lauf ${NEXT_SHORT}`);
  expect(errors).toEqual([]);
});

test('Startseite: kein Hinweis bei ausgeschaltetem Plan', async ({ page }) => {
  await fakeAutoSearch(page, { schedules: [schedule('nick')] });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count').or(page.getByTestId('home-search')).first()).toBeVisible();
  await page.getByTestId('home-details-toggle').click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('home-auto-search')).toHaveCount(0);
});

test('Startseite: Mitarbeiter fragen den Zeitplan gar nicht ab', async ({ page }) => {
  const fake = await fakeAutoSearch(page, { as: ANNA, schedules: [schedule('nick', { enabled: true, nextRunAt: NEXT })] });
  await page.goto('/?ping=off');
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('open-count').or(page.getByTestId('home-search')).first()).toBeVisible();
  await page.getByTestId('home-details-toggle').click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('home-auto-search')).toHaveCount(0);
  expect(fake.lists()).toBe(0);
});

test('Automatische Suche passt auf ein Handy (390 px) ohne seitliches Scrollen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeAutoSearch(page, {
    as: ADMIN,
    schedules: [schedule('nick'), schedule('johannes', { enabled: true, nextRunAt: NEXT })],
  });
  await openAutoSearch(page, { signInAsNick: false });
  const overflow = () => page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByTestId('auto-enabled').click();
  await expect(page.getByTestId('auto-save')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Alle sieben Tage in einer Zeile.
  const first = await day(page, 1).boundingBox();
  const last = await day(page, 7).boundingBox();
  expect(last!.y).toBe(first!.y);
  expect(last!.x + last!.width).toBeLessThanOrEqual(390);
});

test('Zweiter Termin am Tag: 2. Uhrzeit wird mitgeschickt, leer = aus', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAutoSearch(page, { schedules: [schedule('nick', { enabled: true, nextRunAt: NEXT })] });
  await openAutoSearch(page);
  await expect(page.getByTestId('auto-second-time')).toHaveValue('');
  await page.getByTestId('auto-second-time').fill('14:00');
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)!.body.secondTime).toBe('14:00');

  await page.getByTestId('auto-second-time').fill('');
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)!.body.secondTime).toBeNull();
  expect(errors).toEqual([]);
});

test('KI-Tagesbudget statt Suchläufen: Standard 10 €, 0 = ohne Budget, dann wieder Suchläufe', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAutoSearch(page, { schedules: [schedule('nick', { enabled: true, nextRunAt: NEXT })] });
  await openAutoSearch(page);
  // Noch nie gespeichert → mit 10 € vorbelegt, die Zahl der Suchläufe spielt dann keine Rolle.
  await expect(page.getByTestId('auto-daily-budget-input')).toHaveValue('10');
  await expect(page.getByTestId('auto-max-rounds')).toHaveCount(0);
  await page.getByTestId('auto-daily-budget-input').fill('25');
  await page.getByTestId('auto-daily-target-input').fill('20');
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)!.body).toMatchObject({ dailyTarget: 20, dailyBudgetEur: 25 });
  await expect(page.getByTestId('auto-daily-status')).toContainText('bis 20 qualifizierte Leads da sind oder das KI-Budget von 25,00 € aufgebraucht ist');

  // 0 = ohne Budget: wie früher höchstens x Suchläufe.
  await page.getByTestId('auto-daily-budget-input').fill('0');
  await expect(page.getByTestId('auto-max-rounds')).toBeVisible();
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)!.body.dailyBudgetEur).toBeNull();
  expect(errors).toEqual([]);
});

test('Zielgruppen-Mix (27.10.): Regler Kapitalanlage ↔ Finanzdienstleister, Standard 50 %, gespeichert als kapitalanlagePercent', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAutoSearch(page, { schedules: [schedule('nick', { enabled: true, nextRunAt: NEXT })] });
  await openAutoSearch(page);
  const slider = page.getByTestId('auto-mix-slider');
  await expect(slider).toHaveValue('50');
  await expect(page.getByTestId('auto-mix-ka')).toHaveText('50 %');
  await expect(page.getByTestId('auto-mix-fdl')).toHaveText('50 %');
  await slider.fill('70');
  await expect(page.getByTestId('auto-mix-ka')).toHaveText('70 %');
  await expect(page.getByTestId('auto-mix-fdl')).toHaveText('30 %');
  await expect(page.getByTestId('auto-message')).toContainText('Ungespeicherte Änderungen');
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)!.body.kapitalanlagePercent).toBe(70);
  // Pfeiltasten in 10er-Schritten.
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('auto-mix-ka')).toHaveText('60 %');
  expect(errors).toEqual([]);
});

test('Tagesziel nicht erreicht: Grund und Profilabrufe stehen unter dem Tagesziel', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const stopReason =
    'Gestoppt: Das Tageslimit von 100 Profilabrufen ist erreicht (beide Gründer zusammen, Suchen von Hand zählen mit). Für dein Tagesziel reichen eher 150 – einstellen unter Einstellungen → Lead-Suche → „Profile pro Tag“.';
  await fakeAutoSearch(page, {
    schedules: [
      schedule('nick', {
        enabled: true,
        nextRunAt: NEXT,
        dailyTarget: 40,
        dailyBudgetEur: 6,
        today: { day: '2026-10-13', created: 36, rounds: 6, costEur: 0.05, stopReason, profileFetches: 100, profilesPerDay: 100 },
      }),
    ],
  });
  await openAutoSearch(page);
  await expect(page.getByTestId('auto-daily-status')).toContainText('Heute: 36 von 40 Leads, 6 Läufe, 0,05 € von 6,00 € KI-Budget, 100 von 100 Profilabrufen (beide Gründer).');
  await expect(page.getByTestId('auto-stop-reason')).toHaveText(stopReason);
  // Oben die Summe des Tages – „Letzter Lauf“ ist nur der jüngste Lauf (Wunsch des Nutzers 15.10.).
  await expect(page.getByTestId('auto-today')).toHaveText('6 Läufe · 36 von 40 Leads');
  expect(errors).toEqual([]);
});

test('Pause zwischen zwei Läufen (22.10.): „Sucht weiter“ mit Uhrzeit statt des nächsten Termins', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const followUpAt = Date.now() + 4 * 60_000;
  const time = new Intl.DateTimeFormat('de-DE', { timeZone: AUTO_SEARCH_TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(followUpAt);
  await fakeAutoSearch(page, {
    schedules: [
      schedule('nick', {
        enabled: true,
        nextRunAt: NEXT,
        dailyTarget: 40,
        followUpAt,
        followUpManual: true,
        lastRun: { runId: 'run-a', startedAt: Date.now() - 5 * 60_000, finishedAt: Date.now() - 60_000, status: 'done', manual: true, created: 1, message: null },
      }),
    ],
  });
  await openAutoSearch(page);
  const next = page.getByTestId('auto-next');
  await expect(next.getByTestId('auto-follow-up')).toHaveText(`Sucht weiter – heute, ${time}`);
  await expect(next).toContainText('Pause zwischen zwei Läufen · bis 40 Leads · von Hand gestartet');
  expect(errors).toEqual([]);
});
