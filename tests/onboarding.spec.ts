import { expect, test, type Page } from '@playwright/test';
import type { AuthUser } from '../shared/auth';
import type { SettingsResponse, SettingsUpdateRequest } from '../shared/settings';
import { E2E_PASSWORD, realSession, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Registrierung, Freigabe und Einarbeitung (Vertrag shared/auth.ts → „Registrierung und Einarbeitung“).
 * Der erste Test läuft gegen das echte Mock-Backend (Testkonten an → nie „erstes Konto“), der zweite baut
 * `/api/auth/*` und die Einstellungen nach, um die Einrichtung für das allererste Konto zu zeigen.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

const PASSWORD = 'ein-langes-passwort';

test('Registrieren → warten → Gründer gibt für beide frei → Einarbeitung → Umschalter', async ({ page, browser }) => {
  const errors = trackErrors(page);
  const username = `team${Date.now().toString(36)}`;
  try {
    // Link fürs Team: /registrieren öffnet gleich das Formular.
    await page.goto('/registrieren');
    await expect(page.getByTestId('register-form')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Konto anlegen.' })).toBeVisible();
    await page.getByTestId('register-name').fill('Mara Test');
    // Der Anmeldename folgt dem Namen, bis man ihn selbst ändert.
    await expect(page.getByTestId('register-username')).toHaveValue('mara.test');
    await page.getByTestId('register-username').fill(username);
    await page.getByTestId('register-password').fill('kurz');
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('register-password-error')).toContainText('mindestens 10 Zeichen');
    await page.getByTestId('register-password').fill(PASSWORD);
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('waiting-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danke, Mara Test.' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    // Gründer im eigenen Browser: Neuigkeit an der Glocke führt zu Konten, Freigabe für Nick und Johannes.
    const context = await browser.newContext();
    const nick = await context.newPage();
    await nick.goto('/');
    await signIn(nick, 'nick');
    await expect(nick.getByTestId('notifications-dot')).toBeVisible();
    await nick.getByTestId('notifications-bell').click();
    const notice = nick.getByTestId('notification-item').filter({ hasText: 'Mara Test hat sich registriert' });
    await expect(notice).toContainText('Neu');
    await notice.getByRole('button').click();
    const waiting = nick.getByTestId(`waiting-${username}`);
    await expect(waiting).toContainText('Mara Test');
    await waiting.getByTestId('waiting-approve').click();
    await expect(nick.getByTestId('approve-dialog')).toBeVisible();
    await expect(nick.getByTestId('approve-role').getByRole('radio', { name: /Mitarbeiter/ })).toHaveAttribute('aria-checked', 'true');
    // Nick gibt frei → er selbst ist vorgewählt; Johannes dazu.
    await expect(nick.getByTestId('approve-founders-nick')).toBeChecked();
    await nick.getByTestId('approve-founders-johannes').check();
    await expect(nick.getByTestId('approve-founders-hint')).toContainText('Beide gewählt');
    await nick.getByTestId('approve-confirm').click();
    await expect(nick.getByTestId('approve-dialog')).toHaveCount(0);
    await expect(nick.getByTestId(`account-${username}`).getByTestId('account-role')).toHaveText('Mitarbeiter für Nick und Johannes');
    await expect(nick.getByTestId('accounts-waiting')).toHaveCount(0);
    await context.close();

    // Die Warteseite geht von selbst weiter – zur Einarbeitung.
    await expect(page.getByTestId('work-intro')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('intro-title')).toHaveText('Jeden Morgen liegt ein Stapel bereit.');
    await expect(page.getByText('Du arbeitest für Nick und Johannes')).toBeVisible();
    for (const title of ['Eine Aufgabe, zwei Entscheidungen.', 'Mit der Tastatur geht es doppelt so schnell.', 'Antworten schreibst du mit Vorschlag.']) {
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('intro-title')).toHaveText(title);
    }
    await expect(page.getByTestId('intro-next')).toContainText('Ersten Stapel öffnen');
    await page.getByTestId('intro-next').click();
    await expect(page.getByTestId('home')).toBeVisible();

    // Mitarbeiter für beide: oben wechseln, wessen Aufgaben zu sehen sind.
    await page.getByRole('button', { name: /^Konto: / }).click();
    const switcher = page.getByTestId('admin-founder');
    await expect(switcher.getByRole('radio')).toHaveText(['Nick', 'Johannes']);
    await switcher.getByRole('radio', { name: 'Johannes' }).click();
    await expect(page.getByTestId('home')).toBeVisible();
    await page.getByRole('button', { name: /^Konto: / }).click();
    await expect(page.getByTestId('account-role')).toContainText('sendet für Johannes');

    // Neu laden: Einarbeitung kommt nicht wieder.
    await page.reload();
    await expect(page.getByTestId('home')).toBeVisible();
    await expect(page.getByTestId('work-intro')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    // Aufräumen: Konto bzw. Registrierung wieder entfernen (alle Tests teilen ein Backend).
    const admin = await browser.newContext();
    const login = await admin.request.post('/api/auth/login', { data: { username: 'nick', password: E2E_PASSWORD } });
    expect(login.status()).toBe(200);
    await admin.request.delete(`/api/accounts/${username}`);
    await admin.close();
  }
});

/** Schlüssel des nachgebauten Einrichtungs-Links (`/registrieren#setup=…`). */
const SETUP_TOKEN = 'e2e-einrichtung';

/** Nachgebautes erstes Konto: `/api/auth/*` und Einstellungen – das übrige Cockpit läuft über eine echte Sitzung. */
async function fakeFirstAccount(page: Page) {
  await realSession(page);
  let me: AuthUser | null = null;
  const updates: SettingsUpdateRequest[] = [];
  const tests: string[] = [];
  const settings = (): SettingsResponse => ({ settings: [], trial: null, safeMode: false, version: updates.length + 1, serverTime: Date.now(), clientIp: '127.0.0.1' });

  await page.route('**/api/auth/me', (route) =>
    me ? route.fulfill({ json: { user: me } }) : route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Bitte melde dich an.' } } }),
  );
  await page.route('**/api/auth/setup', (route) => route.fulfill({ json: { firstAccount: me === null } }));
  await page.route('**/api/auth/register', (route) => {
    const body = route.request().postDataJSON() as { username: string; name: string; setupToken?: string };
    // Wie das Backend: erstes Konto nur mit dem Schlüssel aus dem Einrichtungs-Link.
    if (body.setupToken !== SETUP_TOKEN) {
      return route.fulfill({ status: 403, json: { error: { code: 'setup_required', message: 'Das erste Konto legst du nur über den Einrichtungs-Link an.' } } });
    }
    me = { username: body.username, name: body.name, founder: 'nick', role: 'founder', onboarding: 'setup' };
    return route.fulfill({ json: { user: me } });
  });
  await page.route('**/api/auth/onboarding/done', (route) => {
    me = { ...me!, onboarding: null };
    return route.fulfill({ json: { user: me } });
  });
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'PUT') updates.push(route.request().postDataJSON() as SettingsUpdateRequest);
    return route.fulfill({ json: settings() });
  });
  await page.route('**/api/settings/test', (route) => {
    const { service } = route.request().postDataJSON() as { service: string };
    tests.push(service);
    return route.fulfill({ json: { ok: true, message: service === 'unipile' ? 'Verbunden: 1 LinkedIn-Account gefunden.' : 'Verbunden.' } });
  });
  const uploads: string[] = [];
  await page.route('**/api/lead-search/tracking', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const fileName = decodeURIComponent(route.request().headers()['x-file-name'] ?? '');
    uploads.push(fileName);
    return route.fulfill({
      json: { tracking: { count: 312, fileName, updatedAt: Date.now(), bySetter: { Nick: 200, Johannes: 112 }, sheets: ['Oktober'] } },
    });
  });
  const autoSearch: Record<string, unknown>[] = [];
  const schedule = {
    founder: 'nick',
    enabled: false,
    days: [1, 2, 3, 4, 5],
    time: '07:00',
    profile: { keywords: ['Kapitalanlage'], positions: ['Geschäftsführer'], region: 'Deutschland', maxResults: 15 },
    nextRunAt: null,
    lastRun: null,
    updatedAt: null,
    updatedBy: null,
    dailyTarget: null,
    maxRounds: 4,
    today: null,
  };
  await page.route('**/api/auto-search', (route) => route.fulfill({ json: { schedules: [schedule], timeZone: 'Europe/Berlin' } }));
  await page.route('**/api/auto-search/nick', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    autoSearch.push(body);
    return route.fulfill({ json: { ...schedule, ...body } });
  });
  return { updates, tests, uploads, autoSearch };
}

test('Erstes Konto ohne Einrichtungs-Link: Hinweis, wo der Link steht – kein Formular', async ({ page }) => {
  const errors = trackErrors(page);
  await fakeFirstAccount(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Willkommen.' })).toBeVisible();
  await expect(page.getByTestId('register-setup-missing')).toContainText('Einrichtungs-Link');
  await expect(page.getByTestId('register-setup-missing')).toContainText('docker compose logs backend | grep Einrichtung');
  await expect(page.getByTestId('register-form')).toHaveCount(0);
  await expect(page.getByTestId('login-form')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Erstes Konto: Gründer-Konto erstellen → Einrichtung mit Schlüsseln → Cockpit', async ({ page }) => {
  const errors = trackErrors(page);
  const fake = await fakeFirstAccount(page);
  await page.goto(`/registrieren#setup=${SETUP_TOKEN}`);
  // Der Schlüssel verschwindet sofort aus der Adresse (Verlauf, Screenshots).
  await expect(page).toHaveURL(/\/registrieren$/);

  await expect(page.getByRole('heading', { name: 'Willkommen.' })).toBeVisible();
  await expect(page.getByTestId('register-intro')).toContainText('automatisch Gründer');
  await expect(page.getByTestId('login-form')).toHaveCount(0);
  await page.getByTestId('register-name').fill('Oskar');
  await page.getByTestId('register-password').fill(PASSWORD);
  await page.getByTestId('register-submit').click();

  // Überblick
  await expect(page.getByTestId('setup-wizard')).toBeVisible();
  await expect(page.getByText('Sechs Dienste machen das Cockpit lebendig.')).toBeVisible();
  await expect(page.getByTestId('setup-overview').getByRole('listitem')).toHaveCount(6);
  await page.keyboard.press('Enter');

  // LinkedIn ist Pflicht: Weiter erst nach dem Test.
  await expect(page.getByTestId('setup-service-title')).toHaveText('LinkedIn über Unipile verbinden');
  await expect(page.getByTestId('setup-next')).toBeDisabled();
  await expect(page.getByTestId('setup-skip')).toHaveCount(0);
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('setup-error')).toContainText('DSN');
  await page.getByTestId('setup-UNIPILE_DSN').fill('api1.unipile.com:13111');
  await page.getByTestId('setup-UNIPILE_API_KEY').fill('geheimes-token-1234');
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('setup-ok')).toContainText('1 LinkedIn-Account gefunden');
  await expect(page.getByTestId('setup-progress')).toHaveText('1 von 6 verbunden');
  // Gespeichert mit dem Passwort aus der Registrierung – keine zweite Abfrage.
  expect(fake.updates).toEqual([{ changes: { UNIPILE_DSN: 'api1.unipile.com:13111', UNIPILE_API_KEY: 'geheimes-token-1234' }, password: PASSWORD, version: 1 }]);
  await page.getByTestId('setup-next').click();

  // KI: eintragen und testen, der Rest später.
  await expect(page.getByTestId('setup-service-title')).toHaveText('Die KI bewertet deine Leads');
  await page.getByTestId('setup-ANTHROPIC_API_KEY').fill('sk-ant-test-schluessel');
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('setup-ok')).toBeVisible();
  await page.getByTestId('setup-next').click();
  for (let i = 0; i < 4; i++) await page.getByTestId('setup-skip').click();
  expect(fake.tests).toEqual(['unipile', 'anthropic']);

  // Tagesziel: große Zahl, Ziffernblock, „Weiter“ erst ab 1.
  await expect(page.getByTestId('setup-target')).toBeVisible();
  await expect(page.getByTestId('setup-target-value')).toHaveText('0');
  await expect(page.getByTestId('setup-target-next')).toBeDisabled();
  await page.getByTestId('setup-target-key-2').click();
  await page.getByTestId('setup-target-key-0').click();
  await expect(page.getByTestId('setup-target-value')).toHaveText('20');
  await page.getByTestId('setup-target-key-back').click();
  await page.keyboard.press('5');
  await expect(page.getByTestId('setup-target-value')).toHaveText('25');
  // Geld statt Suchläufe (11.10.): Standard 10 €, „+“ erhöht in 1-€-Schritten bis 20 €.
  await page.getByTestId('setup-budget-plus').click();
  await expect(page.getByText('KI-Budget höchstens 11 € pro Tag')).toBeVisible();
  await page.getByTestId('setup-target-next').click();
  await expect.poll(() => fake.autoSearch.length).toBe(1);
  expect(fake.autoSearch[0]).toMatchObject({ enabled: true, days: [1, 2, 3, 4, 5], time: '07:00', dailyTarget: 25, dailyBudgetEur: 11 });

  // Bisherige Leads: dieselbe Excel-Liste wie bei der Lead-Suche (Tracking-Liste). Nachgebaut, damit die geteilte
  // Simulation keine Dubletten-Liste bekommt.
  await expect(page.getByTestId('setup-history')).toBeVisible();
  await expect(page.getByTestId('setup-history-next')).toHaveText('Ohne Liste weiter');
  await page.getByTestId('setup-history-file').setInputFiles({ name: 'notizen.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(page.getByTestId('setup-history-error')).toHaveText('Bitte eine Excel-Datei (.xlsx) wählen.');
  expect(fake.uploads).toEqual([]);
  await page.getByTestId('setup-history-file').setInputFiles({ name: 'Outreach Tracking.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('xlsx') });
  await expect(page.getByTestId('setup-history-ok')).toContainText('312 Profile übernommen');
  await expect(page.getByTestId('setup-history-ok')).toContainText('Outreach Tracking.xlsx · Nick 200 · Johannes 112');
  expect(fake.uploads).toEqual(['Outreach Tracking.xlsx']);
  await page.getByTestId('setup-history-next').click();

  // Fertig: Link fürs Team, dann ins Cockpit.
  await expect(page.getByTestId('setup-done')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alles bereit.' })).toBeVisible();
  await expect(page.getByTestId('setup-done-target')).toHaveText('25 Leads pro Tag · höchstens 11 € KI-Budget');
  await expect(page.getByTestId('setup-done-history')).toHaveText('312 bisherige Leads');
  await expect(page.getByTestId('setup-register-link')).toHaveValue(/\/registrieren$/);
  await page.getByTestId('setup-finish').click();
  await expect(page.getByTestId('home')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Anmeldung: Link zum Registrieren und zurück', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await page.getByTestId('login-to-register').click();
  await expect(page.getByTestId('register-form')).toBeVisible();
  await expect(page).toHaveURL(/\/registrieren$/);
  await page.getByTestId('register-to-login').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
