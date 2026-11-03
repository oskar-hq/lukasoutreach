import { expect, test, type Page } from '@playwright/test';
import type { AccountInfo, AuthUser, CreateInviteRequest, InviteInfo } from '../shared/auth';
import { fail, realSession, settledBox, trackErrors, resetCockpit } from './helpers';

/** Jeder Test beginnt mit den 30 Demo-Leads (alle Tests teilen sich ein Mock-Backend). */
test.beforeEach(async ({ request }) => resetCockpit(request));

/**
 * Seite „Konten“ gegen nachgebaute `/api/accounts*` nach `shared/auth.ts` („Rollen und Rechte“, vereinfacht).
 * Das angemeldete Konto kommt aus einem nachgebauten `/api/auth/me`; daneben hält `realSession` eine echte Sitzung
 * (Testkonto nick) beim Mock-Backend, damit das übrige Cockpit (Aufgaben, Lead-Suche) antwortet.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NICK: AuthUser = { username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' };
const ADMIN: AuthUser = { username: 'admin', name: 'Admin', founder: null, role: 'admin' };
const ANNA: AuthUser = { username: 'mitarbeiter', name: 'Anna', founder: 'nick', role: 'assistant' };

/** 400, 403, 404 und 409 gehören zu diesen Tests – der Browser meldet sie als Konsolenfehler. */
const expectedStatus = (text: string) => /status of (400|403|404|409)\b/.test(text);

function startAccounts(): AccountInfo[] {
  return [
    { username: 'admin', name: 'Admin', role: 'admin', founder: null, demo: true },
    { username: 'oskar', name: 'Oskar', role: 'admin', founder: null },
    { username: 'johannes', name: 'Johannes', role: 'founder', founder: 'johannes', demo: true },
    { username: 'nick', name: 'Nick', role: 'founder', founder: 'nick', demo: true },
    { username: 'ben', name: 'Ben', role: 'assistant', founder: 'johannes' },
    { username: 'lena', name: 'Lena', role: 'assistant', founder: 'nick' },
    { username: 'mitarbeiter', name: 'Anna', role: 'assistant', founder: 'nick', demo: true },
    { username: 'tom', name: 'Tom', role: 'assistant', founder: 'nick', pending: true, inviteExpiresAt: Date.now() + 3 * DAY },
  ];
}

/** Baut `/api/auth/me` und `/api/accounts*` nach. `as` ist das angemeldete Konto. */
async function fakeAccounts(page: Page, as: AuthUser) {
  await realSession(page);
  let me = as;
  let accounts = startAccounts();
  const invites: CreateInviteRequest[] = [];
  const removed: string[] = [];
  let nextError: { status: number; code: string; message: string } | null = null;
  let tokens = 0;
  let listed = 0;

  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: me } }));
  await page.route(/\/api\/accounts(\/[^?]*)?(\?.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // Jede Einladung zählt – auch eine, die gleich scheitert.
    if (request.method() === 'POST') invites.push(request.postDataJSON() as CreateInviteRequest);
    if (nextError) {
      const error = nextError;
      nextError = null;
      return fail(route, error.status, error.code, error.message);
    }
    // Admins und Gründer sehen und verwalten alle Konten (Entscheidung 06.10.: nie auf die Shell).
    const visible = () => accounts;

    if (request.method() === 'GET' && path === '/api/accounts') {
      listed++;
      if (me.role === 'assistant') return fail(route, 403, 'not_allowed', 'Dafür fehlen deinem Konto die Rechte.');
      return route.fulfill({ json: { accounts: visible() } });
    }
    if (request.method() === 'POST' && path === '/api/accounts/invite') {
      const body = request.postDataJSON() as CreateInviteRequest;
      const existing = accounts.find((account) => account.username === body.username);
      if (body.reset) {
        if (!existing || existing.pending) return fail(route, 404, 'not_found', 'Dieses Konto gibt es nicht.');
        return route.fulfill({ json: { token: `reset-token-${++tokens}`, username: body.username, expiresAt: Date.now() + 24 * HOUR } });
      }
      if (existing && !existing.pending) return fail(route, 409, 'account_exists', `Den Anmeldenamen „${body.username}“ gibt es schon.`);
      const expiresAt = Date.now() + 7 * DAY;
      const founder = body.founder ?? null;
      accounts = accounts.filter((account) => account.username !== body.username);
      accounts.push({ username: body.username, name: body.name!, role: body.role!, founder, pending: true, inviteExpiresAt: expiresAt });
      return route.fulfill({ json: { token: `invite-token-${++tokens}`, username: body.username, expiresAt } });
    }
    if (request.method() === 'DELETE') {
      const username = decodeURIComponent(path.split('/').pop()!);
      removed.push(username);
      accounts = accounts.filter((account) => account.username !== username);
      return route.fulfill({ json: { ok: true } });
    }
    return fail(route, 404, 'not_found', 'Unbekannt.');
  });

  return {
    invites,
    removed,
    /** Nächste Anfrage an `/api/accounts*` scheitert mit diesem Fehler. */
    failNext: (status: number, code: string, message: string) => {
      nextError = { status, code, message };
    },
    /** So oft wurde die Liste schon geholt. */
    listed: () => listed,
    /** Ab jetzt meldet `/api/auth/me` ein anderes Konto (z. B. Rolle geändert). */
    becomes: (user: AuthUser) => {
      me = user;
    },
  };
}

async function openAccounts(page: Page, user: AuthUser) {
  await page.goto('/?ping=off');
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByRole('button', { name: /^Konto: / }).click();
  await page.getByTestId('menu-accounts').click();
  await expect(page.getByTestId('accounts-list')).toBeVisible();
  // Eigenes Konto mit „du“ gekennzeichnet.
  await expect(page.getByTestId(`account-${user.username}`).getByTestId('account-own')).toHaveText('du');
}

const row = (page: Page, username: string) => page.getByTestId(`account-${username}`);

test('Gründer: verwaltet alle Konten wie ein Admin, Link erscheint und lässt sich kopieren', async ({ page, context }) => {
  const errors = trackErrors(page, expectedStatus);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fake = await fakeAccounts(page, NICK);
  await openAccounts(page, NICK);

  // Alle Konten – auch Admins, den anderen Gründer und dessen Mitarbeiter.
  await expect(page.getByTestId('accounts-list').locator('li')).toHaveCount(8);
  await expect(row(page, 'ben').getByTestId('account-role')).toHaveText('Mitarbeiter für Johannes');
  await expect(row(page, 'oskar').getByTestId('account-remove')).toBeVisible();
  await expect(row(page, 'lena').getByTestId('account-role')).toHaveText('Mitarbeiter für Nick');
  await expect(row(page, 'mitarbeiter').getByTestId('account-status')).toHaveText('Testkonto');
  await expect(row(page, 'tom').getByTestId('account-status')).toContainText('Eingeladen · Link gültig bis');
  // Keine Aktionen für Testkonten und das eigene Konto.
  await expect(row(page, 'nick').getByTestId('account-remove')).toHaveCount(0);
  await expect(row(page, 'mitarbeiter').getByTestId('account-remove')).toHaveCount(0);
  await expect(row(page, 'lena').getByTestId('account-renew')).toHaveText('Neuer Passwort-Link');
  await expect(row(page, 'tom').getByTestId('account-renew')).toHaveText('Neuen Link erzeugen');
  await expect(row(page, 'tom').getByTestId('account-remove')).toHaveText('Einladung zurückziehen');

  // ↵ öffnet das Formular – mit Rollenwahl wie beim Admin.
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('invite-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Konto einladen' })).toBeVisible();
  await expect(page.getByTestId('invite-role')).toBeVisible();
  // Nur Gründer laden Gründer ein (Sicherheitsprüfung 08.10.).
  await expect(page.getByTestId('invite-role').getByRole('radio')).toHaveText(['Admin', 'Gründer', 'Mitarbeiter']);
  await expect(page.getByTestId('invite-username-input')).toBeFocused();

  // Ungültiger Anmeldename: Meldung am Feld, nichts geschickt.
  await page.getByTestId('invite-username-input').fill('Anna Berg');
  await page.getByTestId('invite-name-input').fill('Anna');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('invite-username-error')).toContainText('Der Anmeldename braucht 2–40 Zeichen');
  await expect(page.getByTestId('invite-username-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('invite-username-input')).toBeFocused();
  expect(fake.invites).toEqual([]);

  // Ein Gründer darf auch ein Admin-Konto einladen (founder = null).
  await page.getByTestId('invite-role').getByRole('radio', { name: 'Admin' }).click();
  // Großbuchstaben und Leerzeichen am Rand sind in Ordnung (trim + lowercase).
  await page.getByTestId('invite-username-input').fill('  Anna.Berg ');
  await page.getByTestId('invite-username-input').press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(fake.invites).toEqual([{ username: 'anna.berg', name: 'Anna', role: 'admin', founder: null }]);

  const result = page.getByTestId('link-result');
  await expect(result).toBeVisible();
  await expect(result.getByRole('heading')).toHaveText('Link für Anna');
  const origin = new URL(page.url()).origin;
  await expect(page.getByTestId('link-url')).toHaveText(`${origin}/einladung#invite-token-1`);
  await expect(page.getByTestId('link-validity')).toContainText('Gilt 7 Tage und nur einmal');
  await expect(result).toContainText('wer ihn hat, kann das Konto einrichten');
  await expect(page.getByTestId('link-copy')).toBeFocused();
  await page.getByTestId('link-copy').click();
  await expect(page.getByTestId('link-copy')).toHaveText('Kopiert');
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`${origin}/einladung#invite-token-1`);

  // Die Liste zeigt den neuen Eintrag als eingeladen.
  await expect(row(page, 'anna.berg').getByTestId('account-status')).toContainText('Eingeladen');
  // Der Link liegt nicht im Browser-Speicher.
  const stored = await page.evaluate<string>('JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })');
  expect(stored).not.toContain('invite-token');

  // Seite verlassen und wiederkommen: Der Link ist weg.
  await page.getByTestId('nav-home').click();
  await page.getByRole('button', { name: /^Konto: / }).click();
  await page.getByTestId('menu-accounts').click();
  await expect(page.getByTestId('accounts-list')).toBeVisible();
  await expect(page.getByTestId('link-result')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Admin: wählt Rolle (ohne Gründer-Konten) und Gründer, Erklärung je Rolle', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAccounts(page, ADMIN);
  await openAccounts(page, ADMIN);

  // Admin sieht alle Konten in einer Liste: nach Rolle, dann nach Name.
  await expect(page.getByTestId('accounts-list').locator('li')).toHaveCount(8);
  await expect(page.getByTestId('accounts-list').getByTestId('account-role')).toHaveText([
    'Admin',
    'Admin',
    'Gründer',
    'Gründer',
    'Mitarbeiter für Nick',
    'Mitarbeiter für Johannes',
    'Mitarbeiter für Nick',
    'Mitarbeiter für Nick',
  ]);
  await expect(row(page, 'ben').getByTestId('account-role')).toHaveText('Mitarbeiter für Johannes');
  await expect(row(page, 'oskar').getByTestId('account-remove')).toBeVisible();

  await page.getByTestId('accounts-invite').click();
  await expect(page.getByRole('heading', { name: 'Konto einladen' })).toBeVisible();
  const roles = page.getByTestId('invite-role');
  // Gründer-Konten legen nur Gründer an – der Admin sieht die Rolle nicht.
  await expect(roles.getByRole('radio')).toHaveText(['Admin', 'Mitarbeiter']);
  await expect(roles.getByRole('radio', { name: 'Mitarbeiter' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('invite-founders')).toBeVisible();

  // Admin: keine Gründerwahl, eigene Erklärung.
  await roles.getByRole('radio', { name: 'Admin' }).click();
  await expect(page.getByTestId('invite-founder')).toHaveCount(0);
  await expect(page.getByTestId('invite-role-hint')).toContainText('verwaltet Einstellungen und Konten');
  await roles.getByRole('radio', { name: 'Mitarbeiter' }).click();
  await expect(page.getByText('Arbeitet für')).toBeVisible();

  // Mitarbeiter ohne Gründer: Meldung, nichts geschickt.
  await page.getByTestId('invite-username-input').fill('mara');
  await page.getByTestId('invite-name-input').fill('Mara');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('invite-founder-error')).toHaveText('Wähl aus, für wen das Konto arbeitet – auch beide.');
  expect(fake.invites).toEqual([]);
  // Fokus liegt in der Gründerwahl (Checkboxen); Leertaste wählt.
  await expect(page.getByTestId('invite-founders-nick')).toBeFocused();
  await page.getByTestId('invite-founders-johannes').check();
  await page.getByTestId('invite-name-input').press('Enter');
  await expect(page.getByTestId('link-result')).toBeVisible();
  expect(fake.invites).toEqual([{ username: 'mara', name: 'Mara', role: 'assistant', founder: 'johannes' }]);

  // Mitarbeiter für beide Gründer: founder = erster gewählter, founders = alle.
  await page.getByTestId('accounts-invite').click();
  await page.getByTestId('invite-founders-nick').check();
  await page.getByTestId('invite-founders-johannes').check();
  await page.getByTestId('invite-username-input').fill('mia');
  await page.getByTestId('invite-name-input').fill('Mia');
  await page.getByTestId('invite-name-input').press('Enter');
  await expect(page.getByTestId('link-url')).toContainText('#invite-token-2');
  expect(fake.invites[1]).toEqual({ username: 'mia', name: 'Mia', role: 'assistant', founder: 'nick', founders: ['nick', 'johannes'] });

  // Admin-Konto: founder ist null.
  await page.getByTestId('accounts-invite').click();
  await page.getByTestId('invite-role').getByRole('radio', { name: 'Admin' }).click();
  await page.getByTestId('invite-username-input').fill('chef');
  await page.getByTestId('invite-name-input').fill('Chef');
  await page.getByTestId('invite-name-input').press('Enter');
  await expect(page.getByTestId('link-url')).toContainText('#invite-token-3');
  expect(fake.invites[2]).toEqual({ username: 'chef', name: 'Chef', role: 'admin', founder: null });
  expect(errors).toEqual([]);
});

test('Fehler vom Backend: 409 am Anmeldenamen, 403 als Satz, Esc schließt', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAccounts(page, NICK);
  await openAccounts(page, NICK);

  await page.getByTestId('accounts-invite').click();
  // Gründer laden für sich selbst ein – Nick ist schon gewählt.
  await expect(page.getByTestId('invite-founders-nick')).toBeChecked();
  await page.getByTestId('invite-username-input').fill('lena');
  await page.getByTestId('invite-name-input').fill('Lena');
  await page.getByTestId('invite-name-input').press('Enter');
  await expect(page.getByTestId('invite-username-error')).toHaveText('Den Anmeldenamen „lena“ gibt es schon.');
  await expect(page.getByTestId('invite-username-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('invite-username-input')).toBeFocused();
  await expect(page.getByTestId('link-result')).toHaveCount(0);

  // Tippen nimmt die Meldung weg.
  await page.getByTestId('invite-username-input').fill('lena2');
  await expect(page.getByTestId('invite-username-error')).toHaveCount(0);

  fake.failNext(403, 'not_allowed', 'Not allowed');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('invite-form-error')).toHaveText('Dafür fehlen deinem Konto die Rechte.');
  await expect(page.getByTestId('invite-dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('invite-dialog')).toHaveCount(0);
  await expect(page.getByTestId('accounts-invite')).toBeFocused();
  expect(fake.invites.map((invite) => invite.username)).toEqual(['lena', 'lena2']);
  expect(errors).toEqual([]);
});

test('Entfernen mit Bestätigung, Einladung zurückziehen, neuer Passwort-Link', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAccounts(page, NICK);
  await openAccounts(page, NICK);

  // Esc bricht ab, nichts passiert.
  await row(page, 'lena').getByTestId('account-remove').click();
  const dialog = page.getByTestId('remove-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lena entfernen?' })).toBeVisible();
  await expect(page.getByTestId('remove-confirm')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'lena').getByTestId('account-remove')).toBeFocused();
  expect(fake.removed).toEqual([]);

  // Fehler bleibt im Dialog stehen.
  await row(page, 'lena').getByTestId('account-remove').click();
  fake.failNext(400, 'invalid_request', 'Testkonten lassen sich nicht entfernen.');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('remove-error')).toHaveText('Testkonten lassen sich nicht entfernen.');

  // ↵ bestätigt, der Eintrag verschwindet.
  await page.getByTestId('remove-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'lena')).toHaveCount(0);
  expect(fake.removed).toEqual(['lena']);
  await expect(page.getByTestId('accounts-announcement')).toHaveText('Konto von Lena entfernt.');
  await expect(page.getByTestId('accounts-invite')).toBeFocused();

  // Offene Einladung: neuer Link mit denselben Daten, dann zurückziehen.
  await row(page, 'tom').getByTestId('account-renew').click();
  await expect(page.getByTestId('link-result').getByRole('heading')).toHaveText('Link für Tom');
  expect(fake.invites).toEqual([{ username: 'tom', name: 'Tom', role: 'assistant', founder: 'nick' }]);
  await row(page, 'tom').getByTestId('account-remove').click();
  await expect(page.getByRole('heading', { name: 'Einladung für Tom zurückziehen?' })).toBeVisible();
  await page.getByTestId('remove-confirm').click();
  await expect(row(page, 'tom')).toHaveCount(0);
  // Der Link des zurückgezogenen Kontos verschwindet mit.
  await expect(page.getByTestId('link-result')).toHaveCount(0);
  expect(fake.removed).toEqual(['lena', 'tom']);

  // Nach dem Entfernen lässt sich wieder einladen.
  await page.getByTestId('accounts-invite').click();
  // Gründer laden für sich selbst ein – Nick ist schon gewählt.
  await expect(page.getByTestId('invite-founders-nick')).toBeChecked();
  await page.getByTestId('invite-username-input').fill('lena');
  await page.getByTestId('invite-name-input').fill('Lena');
  await page.getByTestId('invite-name-input').press('Enter');
  await expect(row(page, 'lena').getByTestId('account-status')).toContainText('Eingeladen');
  expect(errors).toEqual([]);
});

test('Neuer Passwort-Link: 24 Stunden, Fehler unter dem Eintrag', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAccounts(page, ADMIN);
  await openAccounts(page, ADMIN);

  fake.failNext(404, 'not_found', 'Dieses Konto gibt es nicht mehr.');
  await row(page, 'oskar').getByTestId('account-renew').click();
  await expect(row(page, 'oskar').getByTestId('account-error')).toHaveText('Dieses Konto gibt es nicht mehr.');

  await row(page, 'oskar').getByTestId('account-renew').click();
  await expect(row(page, 'oskar').getByTestId('account-error')).toHaveCount(0);
  const result = page.getByTestId('link-result');
  await expect(result.getByRole('heading')).toHaveText('Neues Passwort für Oskar');
  await expect(page.getByTestId('link-validity')).toContainText('Gilt 24 Stunden und nur einmal');
  await expect(page.getByTestId('link-url')).toContainText('/einladung#reset-token-1');
  expect(fake.invites).toEqual([
    { username: 'oskar', reset: true },
    { username: 'oskar', reset: true },
  ]);

  // Ausblenden schickt den Fokus zur Haupt-Aktion.
  await page.getByTestId('link-dismiss').click();
  await expect(result).toHaveCount(0);
  await expect(page.getByTestId('accounts-invite')).toBeFocused();
  expect(errors).toEqual([]);
});

test('Ohne Zwischenablage: Link wird markiert', async ({ page }) => {
  await page.addInitScript('Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })');
  await fakeAccounts(page, NICK);
  await openAccounts(page, NICK);
  await row(page, 'lena').getByTestId('account-renew').click();
  await page.getByTestId('link-copy').click();
  await expect(page.getByTestId('link-selected')).toBeVisible();
  expect(await page.evaluate<string>('String(window.getSelection())')).toContain('/einladung#reset-token-1');
});

test('Liste lädt nicht: Meldung und erneut versuchen', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAccounts(page, NICK);
  await page.goto('/?ping=off');
  await expect(page.getByTestId('home')).toBeVisible();
  // Erst nach dem Start: Das Konto-Menü fragt beim Öffnen der Startseite nach wartenden Registrierungen.
  await expect.poll(() => fake.listed()).toBeGreaterThan(0);
  fake.failNext(403, 'not_allowed', 'Not allowed');
  await page.getByRole('button', { name: /^Konto: / }).click();
  await page.getByTestId('menu-accounts').click();
  await expect(page.getByTestId('accounts-load-error')).toHaveText('Dafür fehlen deinem Konto die Rechte.');
  await expect(page.getByTestId('accounts-invite')).toBeDisabled();
  await page.getByTestId('accounts-retry').click();
  await expect(page.getByTestId('accounts-list')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Mitarbeiter: kein Menüeintrag, die Seite zeigt nur einen Satz', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeAccounts(page, ANNA);
  await page.goto('/?ping=off');
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByRole('button', { name: /^Konto: / }).click();
  await expect(page.getByTestId('signed-in-as')).toBeVisible();
  await expect(page.getByTestId('menu-accounts')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Rolle wechselt während die Seite offen ist (z. B. Admin hat das Konto geändert): nur noch ein Satz.
  fake.becomes(NICK);
  await page.reload();
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByRole('button', { name: /^Konto: / }).click();
  await page.getByTestId('menu-accounts').click();
  await expect(page.getByTestId('accounts-list')).toBeVisible();
  fake.becomes(ANNA);
  // Sitzung wird beim Zurückkehren in den Tab neu geprüft (frühestens nach einer Minute).
  await page.evaluate('(() => { const now = Date.now; Date.now = () => now() + 120000; document.dispatchEvent(new Event("visibilitychange")); })()');
  await expect(page.getByTestId('accounts-not-allowed')).toHaveText('Konten verwalten Gründer und Admins. Braucht jemand Zugang, sag Nick Bescheid.');
  await expect(page.getByTestId('accounts-invite')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Konten passen auf ein Handy (390 px) ohne seitliches Scrollen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeAccounts(page, ADMIN);
  await openAccounts(page, ADMIN);
  const overflow = () => page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(await overflow()).toBeLessThanOrEqual(0);

  await row(page, 'oskar').getByTestId('account-renew').click();
  await expect(page.getByTestId('link-result')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);

  await page.getByTestId('accounts-invite').click();
  await expect(page.getByTestId('invite-dialog')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Der Dialog passt in die Breite.
  const box = await page.getByTestId('invite-dialog').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);

  // Bottom-Sheet: kurzes Ziehen am Griff federt zurück, ein Zug nach unten schließt.
  const grabber = page.getByTestId('sheet-grabber');
  const handle = await settledBox(grabber);
  const startX = handle.x + handle.width / 2;
  const startY = handle.y + handle.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 12, { steps: 4 });
  await page.waitForTimeout(150); // Finger steht still → kein Schwung
  await page.mouse.up();
  await expect(page.getByTestId('invite-dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 400, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('invite-dialog')).toHaveCount(0);
});

/** Einladungsseite: zeigt, was für ein Konto der Link einrichtet. */
async function fakeInviteCheck(page: Page, invite: Omit<InviteInfo, 'expiresAt' | 'accountExists'>) {
  await page.route('**/api/auth/me', (route) => fail(route, 401, 'unauthorized', 'Bitte melde dich an.'));
  await page.route('**/api/auth/invite/check', (route) =>
    route.fulfill({ json: { ...invite, expiresAt: Date.now() + 7 * DAY, accountExists: false } satisfies InviteInfo }),
  );
}

test('Einladungsseite: Admin-Konto', async ({ page }) => {
  await fakeInviteCheck(page, { username: 'chef', name: 'Chef', founder: null, role: 'admin' });
  await page.goto('/einladung?ping=off#token-admin');
  await expect(page.getByRole('heading', { name: 'Willkommen, Chef.' })).toBeVisible();
  await expect(page.getByTestId('invite-account-kind')).toHaveText('Admin-Konto');
});

test('Einladungsseite: Mitarbeiter für Nick, auch ohne `role` (älteres Backend) als Gründer', async ({ page }) => {
  await fakeInviteCheck(page, { username: 'anna', name: 'Anna', founder: 'nick', role: 'assistant' });
  await page.goto('/einladung?ping=off#token-anna');
  await expect(page.getByRole('heading', { name: 'Willkommen, Anna.' })).toBeVisible();
  await expect(page.getByTestId('invite-account-kind')).toHaveText('Mitarbeiter für Nick');

  await page.unroute('**/api/auth/invite/check');
  await fakeInviteCheck(page, { username: 'johannes', name: 'Johannes', founder: 'johannes' });
  await page.goto('/einladung?ping=off#token-johannes');
  await expect(page.getByRole('heading', { name: 'Willkommen, Johannes.' })).toBeVisible();
  await expect(page.getByTestId('invite-account-kind')).toHaveText('Gründer-Konto · Johannes');
});
