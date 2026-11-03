import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { AcceptInviteRequest, AuthUser, InviteInfo } from '../shared/auth';
import { fail, realSession, trackErrors, resetCockpit } from './helpers';

/** Jeder Test beginnt mit den 30 Demo-Leads (alle Tests teilen sich ein Mock-Backend). */
test.beforeEach(async ({ request }) => resetCockpit(request));

/**
 * Seite „Konto einrichten“ gegen nachgebaute Einladungs-Routen nach `shared/auth.ts`. Daneben hält `realSession`
 * eine echte Sitzung beim Mock-Backend, damit das Cockpit nach dem Einrichten weiterarbeitet.
 */
const TOKEN = 'eXamPle-Token_123';
const DAY = 24 * 60 * 60 * 1000;
const NICK: AuthUser = { username: 'nick', name: 'Nick', founder: 'nick' };

/** 400, 401, 404 und 429 gehören zu diesen Tests – der Browser meldet sie als Konsolenfehler. */
const expectedStatus = (text: string) => /status of (400|401|404|429)\b/.test(text);

async function fakeInvite(page: Page, { accountExists = false } = {}) {
  await realSession(page);
  let session: AuthUser | null = null;
  let used = false;
  const checks: string[] = [];
  const accepts: AcceptInviteRequest[] = [];
  const invite: InviteInfo = { ...NICK, expiresAt: Date.now() + 7 * DAY, accountExists };

  await page.route('**/api/auth/me', (route) =>
    session ? route.fulfill({ json: { user: session } }) : fail(route, 401, 'unauthorized', 'Bitte melde dich an.'),
  );
  await page.route('**/api/auth/invite/check', (route) => {
    const { token } = route.request().postDataJSON() as { token: string };
    checks.push(token);
    if (token !== TOKEN || used) return fail(route, 404, 'invite_invalid', 'Dieser Link gilt nicht mehr.');
    return route.fulfill({ json: invite });
  });
  await page.route('**/api/auth/invite/accept', (route) => {
    const body = route.request().postDataJSON() as AcceptInviteRequest;
    accepts.push(body);
    if (body.token !== TOKEN || used) return fail(route, 404, 'invite_invalid', 'Dieser Link gilt nicht mehr.');
    if (body.password.length < 10) return fail(route, 400, 'weak_password', 'Das Passwort braucht mindestens 10 Zeichen.');
    used = true;
    session = NICK;
    return route.fulfill({ json: { user: NICK } });
  });

  return {
    checks,
    accepts,
    /** Link inzwischen anderswo benutzt. */
    markUsed: () => {
      used = true;
    },
  };
}

const passwordField = (page: Page) => page.getByLabel('Passwort', { exact: true });
const repeatField = (page: Page) => page.getByLabel('Passwort wiederholen');

test('Einladung: Passwort festlegen, danach direkt im Cockpit', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const invite = await fakeInvite(page);
  await page.goto(`/einladung?ping=off#${TOKEN}`);

  await expect(page.getByRole('heading', { name: 'Willkommen, Nick.' })).toBeVisible();
  // Das Token verschwindet sofort aus der Adresse.
  expect(new URL(page.url()).hash).toBe('');
  expect(new URL(page.url()).pathname).toBe('/einladung');
  await expect(page.getByTestId('invite-username')).toHaveValue('nick');
  await expect(passwordField(page)).toBeFocused();
  // Das Token geht nur im Body an den Server.
  expect(invite.checks).toEqual([TOKEN]);

  // Zu kurz: Meldung, nichts abgeschickt.
  await passwordField(page).fill('kurz');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('invite-error')).toHaveText('Das Passwort braucht mindestens 10 Zeichen.');
  await expect(passwordField(page)).toHaveAttribute('aria-invalid', 'true');

  // Enter im ersten Feld führt ins zweite, ohne Fehler.
  await passwordField(page).fill('ein langes Passwort');
  await page.keyboard.press('Enter');
  await expect(repeatField(page)).toBeFocused();
  await expect(page.getByTestId('invite-error')).toHaveCount(0);

  // Nicht gleich: Meldung, zweites Feld leer.
  await repeatField(page).fill('ein anderes Passwort');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('invite-error')).toHaveText('Die beiden Passwörter sind nicht gleich.');
  await expect(repeatField(page)).toHaveValue('');
  expect(invite.accepts).toHaveLength(0);

  // Eigener Name: vorbelegt aus der Einladung, leer geht nicht.
  await expect(page.getByTestId('invite-name')).toHaveValue('Nick');
  await page.getByTestId('invite-name').fill('  ');
  await repeatField(page).fill('ein langes Passwort');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('invite-error')).toHaveText('Bitte gib deinen Namen ein (1 bis 60 Zeichen).');
  await expect(page.getByTestId('invite-name')).toBeFocused();
  expect(invite.accepts).toHaveLength(0);

  await page.getByTestId('invite-name').fill('Nick Schulz');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('start-focus')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Konto: Nick' })).toBeVisible();
  expect(invite.accepts).toEqual([{ token: TOKEN, password: 'ein langes Passwort', remember: true, name: 'Nick Schulz' }]);
  // Token ist aus der Adresse verschwunden, Parameter bleiben.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).hash).toBe('');
  expect(new URL(page.url()).search).toBe('?ping=off');
  expect(errors).toEqual([]);
});

test('Einladung für ein bestehendes Konto: neues Passwort, ohne „angemeldet bleiben“', async ({ page }) => {
  const invite = await fakeInvite(page, { accountExists: true });
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Hallo Nick.' })).toBeVisible();
  await expect(page.getByTestId('invite-submit')).toContainText('Passwort speichern');
  await passwordField(page).fill('neues Passwort 2026');
  await repeatField(page).fill('neues Passwort 2026');
  await page.getByTestId('invite-remember').uncheck();
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('start-focus')).toBeVisible();
  expect(invite.accepts.at(-1)?.remember).toBe(false);
});

test('Abgelaufener oder benutzter Link: Hinweis und zur Anmeldung', async ({ page }) => {
  const invite = await fakeInvite(page);
  invite.markUsed();
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Dieser Link gilt nicht mehr.' })).toBeVisible();
  await expect(page.getByTestId('invite-message')).toContainText('abgelaufen oder wurde schon benutzt');
  await page.getByTestId('invite-to-login').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('Link wird während des Ausfüllens anderswo benutzt: Hinweis statt Formular', async ({ page }) => {
  const invite = await fakeInvite(page);
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByTestId('invite-form')).toBeVisible();
  invite.markUsed();
  await passwordField(page).fill('ein langes Passwort');
  await repeatField(page).fill('ein langes Passwort');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Dieser Link gilt nicht mehr.' })).toBeVisible();
});

test('Ohne Token (unvollständig oder nach Neuladen): „Öffne den Link noch einmal“, keine Anfrage', async ({ page }) => {
  const invite = await fakeInvite(page);
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByTestId('invite-form')).toBeVisible();
  // Neuladen: Das Token ist absichtlich nicht mehr da – der Link gilt aber weiter.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Öffne den Link noch einmal.' })).toBeVisible();
  await expect(page.getByTestId('invite-message')).toContainText('aus Sicherheitsgründen');
  await page.waitForLoadState('networkidle');
  expect(invite.checks).toEqual([TOKEN]);

  // Derselbe Link noch einmal im selben Tab (nur das Fragment ändert sich): wird erkannt und geprüft.
  await page.evaluate(`location.hash = '${TOKEN}'`);
  await expect(page.getByTestId('invite-form')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(invite.checks).toEqual([TOKEN, TOKEN]);
});

test('Token bleibt nicht im Verlauf (Adresse ersetzt, nicht neu angelegt)', async ({ page }) => {
  await fakeInvite(page);
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByTestId('invite-form')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  // 2 Einträge: about:blank (Start von Playwright) und diese Seite. Mit pushState wären es 3, und Zurück
  // brächte die Adresse mit Token wieder.
  expect(await page.evaluate<number>('history.length')).toBe(2);
});

test('Vom Formular zurück zur Anmeldung', async ({ page }) => {
  await fakeInvite(page);
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await page.getByTestId('invite-cancel').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('Backend ohne Einladungen (404 ohne Code): verständlicher Hinweis', async ({ page }) => {
  await realSession(page);
  await page.route('**/api/auth/invite/check', (route) =>
    route.fulfill({ status: 404, json: { message: 'Route POST:/api/auth/invite/check not found', error: 'Not Found', statusCode: 404 } }),
  );
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Noch nicht möglich.' })).toBeVisible();
});

test('Älteres Backend mit Pflicht-Sitzung (401 auf check): verständlicher Hinweis', async ({ page }) => {
  await realSession(page);
  await page.route('**/api/auth/invite/check', (route) => fail(route, 401, 'unauthorized', 'Bitte melde dich an.'));
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Noch nicht möglich.' })).toBeVisible();
});

test('Server nicht erreichbar: erneut versuchen', async ({ page }) => {
  await fakeInvite(page);
  let down = true;
  // Zuletzt registrierte Route gewinnt: solange `down`, antwortet check mit 502.
  await page.route('**/api/auth/invite/check', (route) => (down ? route.fulfill({ status: 502, body: 'Bad Gateway' }) : route.fallback()));
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByTestId('invite-message')).toContainText('nicht erreichbar');
  down = false;
  await page.getByTestId('invite-retry').click();
  await expect(page.getByTestId('invite-form')).toBeVisible();
});

test('Seite „Konto einrichten“ passt auf ein Handy (390 px) ohne seitliches Scrollen', async ({ page }) => {
  await fakeInvite(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/einladung?ping=off#${TOKEN}`);
  await expect(page.getByTestId('invite-form')).toBeVisible();
  // Läuft im Browser – als Text übergeben, weil die Testdateien ohne DOM-Typen geprüft werden.
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(overflow).toBeLessThanOrEqual(0);
});

test('Echter Einladungslink vom Mock-Backend: einrichten, abmelden, normal anmelden, Link danach ungültig', async ({ page, baseURL }) => {
  const errors = trackErrors(page);
  // Eigener Name je Lauf – nie nick/johannes (Vertrag). Gleicher DATA_DIR wie das E2E-Backend in playwright.config.ts.
  const username = `e2e-${Date.now().toString(36)}`;
  const link = execFileSync('npx', ['tsx', 'src/accountsCli.ts', 'invite', username, 'johannes', 'E2E Test'], {
    cwd: 'server',
    env: { ...process.env, DATA_DIR: '../test-results/e2e-data', AUTH_COOKIE_SECURE: 'false', PUBLIC_URL: baseURL },
    encoding: 'utf8',
  }).trim();
  const token = new URL(link).hash.slice(1);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await page.goto(`/einladung?ping=off#${token}`);
  await expect(page.getByRole('heading', { name: 'Willkommen, E2E Test.' })).toBeVisible();
  await expect(page.getByTestId('invite-username')).toHaveValue(username);
  const password = 'ein echtes Testpasswort';
  await passwordField(page).fill(password);
  await repeatField(page).fill(password);
  await page.keyboard.press('Enter');
  // Neues Konto: erst die kurze Einarbeitung (Vertrag „Registrierung und Einarbeitung“), überspringen geht.
  await expect(page.getByTestId('work-intro')).toBeVisible();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('start-focus')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Konto: E2E Test' })).toBeVisible();

  // Abmelden und mit dem neuen Passwort normal anmelden.
  await page.getByRole('button', { name: 'Konto: E2E Test' }).click();
  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await page.getByLabel('Name').fill(username);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('start-focus')).toBeVisible();

  // Der Link gilt nur einmal.
  await page.goto(`/einladung?ping=off#${token}`);
  await expect(page.getByRole('heading', { name: 'Dieser Link gilt nicht mehr.' })).toBeVisible();
  expect(errors).toEqual([]);
});
