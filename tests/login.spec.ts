import { expect, test, type Page } from '@playwright/test';
import type { AuthUser, LoginRequest } from '../shared/auth';
import { fail, realSession, trackErrors, resetCockpit } from './helpers';

/** Jeder Test beginnt mit den 30 Demo-Leads (alle Tests teilen sich ein Mock-Backend). */
test.beforeEach(async ({ request }) => resetCockpit(request));

/**
 * Anmeldung gegen eine nachgebaute `/api/auth/*` nach `shared/auth.ts`. Die Lead-Suche läuft weiter gegen das
 * Mock-Backend, antwortet aber ohne Sitzung mit 401 – wie das Backend mit Login.
 */
const USERS: Record<string, AuthUser> = {
  nick: { username: 'nick', name: 'Nick', founder: 'nick' },
  johannes: { username: 'johannes', name: 'Johannes', founder: 'johannes' },
};
const PASSWORD = 'richtig';
const MAX_FAILURES = 3;

/** 401 und 429 gehören zu diesen Tests – der Browser meldet sie als Konsolenfehler. */
const expectedStatus = (text: string) => /status of (401|429)\b/.test(text);

/** Merkt sich im Browser, ob die Demo-Auswahl je auftaucht (z. B. kurz nach dem Anmelden). */
const watchForPicker = (page: Page) =>
  page.evaluate(`(() => {
    window.__sawPicker = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid=login-nick]')) window.__sawPicker = true;
    }).observe(document.body, { childList: true, subtree: true });
  })()`);
const sawPicker = (page: Page) => page.evaluate<boolean>('window.__sawPicker');

async function fakeAuth(page: Page) {
  await realSession(page);

  let session: AuthUser | null = null;
  let failures = 0;
  const logins: LoginRequest[] = [];
  let logouts = 0;
  let logoutOffline = false;

  await page.route('**/api/auth/me', (route) =>
    session ? route.fulfill({ json: { user: session } }) : fail(route, 401, 'unauthorized', 'Bitte melde dich an.'),
  );
  await page.route('**/api/auth/login', (route) => {
    const body = route.request().postDataJSON() as LoginRequest;
    logins.push(body);
    if (failures >= MAX_FAILURES) {
      return fail(route, 429, 'too_many_attempts', 'Zu viele Versuche. Warte 5 Minuten und versuch es dann noch einmal.', {
        headers: { 'Retry-After': '300' },
      });
    }
    const user = USERS[body.username];
    if (!user || body.password !== PASSWORD) {
      failures++;
      return fail(route, 401, 'invalid_credentials', 'Name oder Passwort stimmt nicht.');
    }
    session = user;
    return route.fulfill({ json: { user } });
  });
  await page.route('**/api/auth/logout', (route) => {
    logouts++;
    if (logoutOffline) return route.fulfill({ status: 502, body: 'Bad Gateway' });
    session = null;
    return route.fulfill({ json: { ok: true } });
  });
  // Geschützte Route: ohne Sitzung 401, sonst weiter zum Mock-Backend.
  await page.route('**/api/lead-search/**', (route) =>
    session ? route.fallback() : fail(route, 401, 'unauthorized', 'Bitte melde dich an.'),
  );

  return {
    logins,
    logouts: () => logouts,
    /** Sitzung serverseitig beenden, z. B. abgelaufen. */
    expire: () => {
      session = null;
    },
    /** Abmelden erreicht den Server nicht (502). */
    setLogoutOffline: (value: boolean) => {
      logoutOffline = value;
    },
  };
}

async function fillLogin(page: Page, username: string, password: string) {
  await page.getByLabel('Name').fill(username);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
}

test('Anmelden mit Name und Passwort, angemeldet bleiben und abmelden', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const auth = await fakeAuth(page);
  await page.goto('/?ping=off');

  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByTestId('login-nick')).toHaveCount(0);
  await expect(page.getByTestId('login-notice')).toHaveCount(0);
  await expect(page.getByLabel('Name')).toBeFocused();
  await expect(page.getByTestId('login-remember')).toBeChecked();

  // Leeres Formular wird gar nicht erst abgeschickt; nur das betroffene Feld gilt als ungültig.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('login-error')).toHaveText('Bitte gib deinen Namen ein.');
  await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Passwort', { exact: true })).toHaveAttribute('aria-invalid', 'false');
  expect(auth.logins).toHaveLength(0);

  // Enter im Namensfeld springt ins Passwortfeld – ohne Fehlermeldung.
  await page.getByLabel('Name').fill('nick');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Passwort', { exact: true })).toBeFocused();
  await expect(page.getByTestId('login-error')).toHaveCount(0);
  expect(auth.logins).toHaveLength(0);

  // Falsches Passwort: Meldung vom Backend, Passwortfeld leer und fokussiert.
  await fillLogin(page, 'nick', 'falsch');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('login-error')).toHaveText('Name oder Passwort stimmt nicht.');
  await expect(page.getByLabel('Passwort', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Passwort', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');

  // Richtig, Name mit Großbuchstaben und Leerzeichen – Enter meldet an. Die Demo-Auswahl blitzt dabei nicht auf.
  await watchForPicker(page);
  await fillLogin(page, ' Nick ', PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('start-focus')).toBeVisible();
  expect(await sawPicker(page)).toBe(false);
  // Standard „Alle“ (01.11.): Aufgaben beider Gründer (Nick allein: 14)
  await expect(page.getByTestId('open-count')).toHaveText('28');
  expect(auth.logins.at(-1)).toEqual({ username: 'nick', password: PASSWORD, remember: true });

  // Neuladen: Sitzung gilt weiter, kein Formular.
  await page.reload();
  await expect(page.getByTestId('start-focus')).toBeVisible();
  await expect(page.getByTestId('login-form')).toHaveCount(0);

  await page.getByRole('button', { name: 'Konto: Nick' }).click();
  await expect(page.getByTestId('signed-in-as')).toHaveText('Angemeldet als nick');
  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('');
  expect(auth.logouts()).toBe(1);

  // Nach dem Abmelden bleibt man auch nach Neuladen abgemeldet.
  await page.reload();
  await expect(page.getByTestId('login-form')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Johannes landet direkt bei seinen Aufgaben, ohne „angemeldet bleiben“', async ({ page }) => {
  const auth = await fakeAuth(page);
  await page.goto('/?ping=off');
  await fillLogin(page, 'johannes', PASSWORD);
  await page.getByTestId('login-remember').uncheck();
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('start-focus')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Konto: Johannes' })).toBeVisible();
  expect(auth.logins.at(-1)?.remember).toBe(false);
});

test('Zu viele Fehlversuche: verständliche Meldung', async ({ page }) => {
  const auth = await fakeAuth(page);
  await page.goto('/?ping=off');
  for (let i = 0; i < MAX_FAILURES; i++) {
    await fillLogin(page, 'nick', `falsch-${i}`);
    await page.getByTestId('login-submit').click();
    // Erst weiter, wenn dieser Versuch beantwortet ist – die Meldung steht ab dem zweiten Mal schon vorher da.
    await expect.poll(() => auth.logins.length).toBe(i + 1);
    await expect(page.getByTestId('login-submit')).toBeEnabled();
    await expect(page.getByLabel('Passwort', { exact: true })).toHaveValue('');
    await expect(page.getByTestId('login-error')).toHaveText('Name oder Passwort stimmt nicht.');
  }
  await fillLogin(page, 'nick', PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText(/^Zu viele Versuche/);
  await expect(page.getByTestId('login-form')).toBeVisible();
  // Gesperrt heißt nicht „Eingabe falsch“: kein Feld wird als ungültig markiert.
  await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'false');
  await expect(page.getByLabel('Passwort', { exact: true })).toHaveAttribute('aria-invalid', 'false');
  expect(auth.logins).toHaveLength(MAX_FAILURES + 1);
});

test('Abgelaufene Sitzung führt zurück zur Anmeldung und danach weiter', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const auth = await fakeAuth(page);
  await page.goto('/?ping=off');
  await fillLogin(page, 'nick', PASSWORD);
  await page.keyboard.press('Enter');
  await page.getByTestId('nav-search').click();
  await expect(page.getByTestId('start-search')).toBeEnabled();

  auth.expire();
  await page.getByTestId('start-search').click();
  await page.getByTestId('start-search-confirm').click();

  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByTestId('login-notice')).toHaveText('Deine Sitzung ist abgelaufen. Melde dich bitte erneut an.');
  // Name ist schon eingetragen, das Passwortfeld hat den Fokus und verweist auf den Grund.
  await expect(page.getByLabel('Name')).toHaveValue('nick');
  await expect(page.getByLabel('Passwort', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Passwort', { exact: true })).toHaveAccessibleDescription(/Sitzung ist abgelaufen/);
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('start-focus')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Backend ohne Login (404): die Demo-Auswahl bleibt', async ({ page }) => {
  await realSession(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 404, json: { message: 'Route GET:/api/auth/me not found', error: 'Not Found', statusCode: 404 } }),
  );
  await page.goto('/?ping=off');
  await expect(page.getByTestId('login-nick')).toBeVisible();
  await expect(page.getByTestId('login-form')).toHaveCount(0);
  await page.getByTestId('login-nick').click();
  await expect(page.getByTestId('start-focus')).toBeVisible();
  await page.getByRole('button', { name: 'Konto: Nick' }).click();
  await expect(page.getByRole('button', { name: 'Abmelden / Gründer wechseln' })).toBeVisible();
});

test('Abmelden ohne Server: Fehlermeldung, die Sitzung bleibt', async ({ page }) => {
  const auth = await fakeAuth(page);
  await page.goto('/?ping=off');
  await fillLogin(page, 'nick', PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('start-focus')).toBeVisible();

  auth.setLogoutOffline(true);
  await page.getByRole('button', { name: 'Konto: Nick' }).click();
  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await expect(page.getByTestId('logout-error')).toContainText('Abmelden hat nicht geklappt');
  await expect(page.getByTestId('start-focus')).toBeVisible();
  await expect(page.getByTestId('login-form')).toHaveCount(0);

  // Zweiter Versuch mit erreichbarem Server meldet ab.
  auth.setLogoutOffline(false);
  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  expect(auth.logouts()).toBe(2);
});

test('Server beim Start nicht erreichbar: Hinweis, danach geht es von selbst weiter', async ({ page }) => {
  await fakeAuth(page);
  let down = true;
  // Zuletzt registrierte Route gewinnt: solange `down`, antwortet /me mit 502, danach die nachgebaute Anmeldung.
  await page.route('**/api/auth/me', (route) => (down ? route.fulfill({ status: 502, body: 'Bad Gateway' }) : route.fallback()));
  await page.goto('/?ping=off');
  await expect(page.getByTestId('login-notice')).toHaveText('Der Server ist gerade nicht erreichbar. Versuch es gleich noch einmal.');
  await page.getByLabel('Name').fill('nick');

  down = false;
  await page.evaluate("window.dispatchEvent(new Event('online'))");
  await expect(page.getByTestId('login-notice')).toHaveCount(0);
  // Das Formular bleibt stehen, Eingaben gehen nicht verloren.
  await expect(page.getByLabel('Name')).toHaveValue('nick');
});

test('Demo-Auswahl offen, Backend bekommt den Login: zurück zur Anmeldung', async ({ page }) => {
  await realSession(page);
  let withLogin = false;
  await page.route('**/api/auth/me', (route) =>
    withLogin
      ? fail(route, 401, 'unauthorized', 'Bitte melde dich an.')
      : route.fulfill({ status: 404, json: { message: 'Route GET:/api/auth/me not found', error: 'Not Found', statusCode: 404 } }),
  );
  await page.route('**/api/lead-search/**', (route) => (withLogin ? fail(route, 401, 'unauthorized', 'Bitte melde dich an.') : route.fallback()));
  await page.goto('/?ping=off');
  await page.getByTestId('login-nick').click();
  await page.getByTestId('nav-search').click();
  await expect(page.getByTestId('start-search')).toBeEnabled();

  withLogin = true;
  await page.getByTestId('start-search').click();
  await page.getByTestId('start-search-confirm').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByTestId('login-nick')).toHaveCount(0);
});

test('Anmeldeseite passt auf ein Handy (390 px) ohne seitliches Scrollen', async ({ page }) => {
  await fakeAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ping=off');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toBeInViewport();
  // Läuft im Browser – als Text übergeben, weil die Testdateien ohne DOM-Typen geprüft werden.
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(overflow).toBeLessThanOrEqual(0);
});
