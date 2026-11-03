import { expect, test, type Page } from '@playwright/test';
import {
  SETTING_GROUPS,
  SETTINGS,
  type SettingGroup,
  type SettingKey,
  type SettingsHistoryEntry,
  type SettingsResponse,
  type SettingState,
  type SettingsUpdateRequest,
  type SettingValue,
} from '../shared/settings';
import { fail, signIn, trackErrors, resetCockpit, gotoSettings, openSetting, openSettingsSection } from './helpers';

/** Jeder Test beginnt mit den 30 Demo-Leads (alle Tests teilen sich ein Mock-Backend). */
test.beforeEach(async ({ request }) => resetCockpit(request));

/**
 * Seite „Einstellungen“ gegen nachgebaute `/api/settings/*` nach `shared/settings.ts` (vereinfacht: Version,
 * Passwort, Probe, Verlauf). Anmeldung und alles andere laufen gegen das Mock-Backend.
 */
const PASSWORD = 'richtig';
const ENV: Partial<Record<SettingKey, SettingValue>> = {
  MAX_RESULTS: 15,
  UNIPILE_DSN: 'https://api68.unipile.com:19881',
  UNIPILE_API_KEY: 'env-unipile-key-1234',
  AUTH_COOKIE_SECURE: false,
  TRUST_PROXY_HOPS: 1,
  DATA_DIR: '/data',
  PORT: 8787,
};

/** 400, 403 und 409 gehören zu diesen Tests – der Browser meldet sie als Konsolenfehler. */
const expectedStatus = (text: string) => /status of (400|403|409)\b/.test(text);

const hint = (value: SettingValue | undefined) => (typeof value === 'string' && value.length >= 12 ? value.slice(-4) : null);

async function fakeSettings(page: Page, { safeMode = false } = {}) {
  const software: Partial<Record<SettingKey, SettingValue>> = {};
  const history: SettingsHistoryEntry[] = [];
  let version = 1;
  let trial: SettingsResponse['trial'] = null;
  let conflictOnce = false;
  const puts: SettingsUpdateRequest[] = [];

  const stateOf = (key: SettingKey): SettingState => {
    const definition = SETTINGS.find((entry) => entry.key === key)!;
    const own = key in software && !safeMode;
    const effective = own ? software[key] : ENV[key];
    const fallbackSource = key in ENV ? 'env' : 'default';
    const base: SettingState = { key, source: own ? 'software' : key in ENV ? 'env' : 'default', fallbackSource };
    if (safeMode && key in software) {
      base.stored = definition.type === 'secret' ? { secret: { set: !!software[key], hint: hint(software[key]) } } : { value: software[key] };
    }
    if (definition.type === 'secret') {
      return { ...base, secret: { set: !!effective, hint: hint(effective) }, fallbackSecret: { set: !!ENV[key], hint: hint(ENV[key]) } };
    }
    return { ...base, value: effective ?? null, fallback: ENV[key] ?? null };
  };
  const response = (): SettingsResponse => ({
    settings: SETTINGS.map((definition) => stateOf(definition.key)),
    trial,
    safeMode,
    version,
    serverTime: Date.now(),
    clientIp: '203.0.113.7',
  });

  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: response() });
    const body = route.request().postDataJSON() as SettingsUpdateRequest;
    puts.push(body);
    if (conflictOnce) {
      conflictOnce = false;
      version++;
      return fail(route, 409, 'settings_changed', 'Inzwischen hat jemand anderes gespeichert.');
    }
    if (body.version !== version) return fail(route, 409, 'settings_changed', 'Inzwischen hat jemand anderes gespeichert.');
    const keys = Object.keys(body.changes) as SettingKey[];
    const definitions = keys.map((key) => SETTINGS.find((entry) => entry.key === key)!);
    if (safeMode && keys.some((key) => body.changes[key] !== null)) return fail(route, 409, 'setting_read_only', 'Im Notfallmodus nur löschen.');
    const maxResults = body.changes.MAX_RESULTS;
    if (typeof maxResults === 'number' && maxResults > 1000) return fail(route, 400, 'invalid_setting', 'Höchstens 1000.', { field: 'MAX_RESULTS' });
    if (definitions.some((definition) => definition.reauth) && body.password !== PASSWORD) {
      return fail(route, 403, 'reauth_failed', 'Das Passwort stimmt nicht.');
    }
    for (const key of keys) {
      const value = body.changes[key];
      const secret = SETTINGS.find((entry) => entry.key === key)!.type === 'secret';
      history.unshift({
        at: Date.now(),
        username: 'nick',
        key,
        action: value === null ? 'reset' : definitions.find((d) => d.key === key)!.trial ? 'trial' : 'set',
        ...(secret ? {} : { from: software[key] ?? null, to: value }),
      });
      if (value === null) delete software[key];
      else software[key] = value as SettingValue;
    }
    if (definitions.some((definition) => definition.trial)) {
      trial = { keys: keys.filter((key) => SETTINGS.find((entry) => entry.key === key)!.trial), revertsAt: Date.now() + 300_000, username: 'nick' };
    }
    version++;
    return route.fulfill({ json: response() });
  });
  await page.route('**/api/settings/trial/confirm', (route) => {
    trial = null;
    version++;
    return route.fulfill({ json: response() });
  });
  await page.route('**/api/settings/trial/revert', (route) => {
    trial = null;
    version++;
    return route.fulfill({ json: response() });
  });
  await page.route('**/api/settings/test', (route) => route.fulfill({ json: { ok: true, message: 'Verbunden: LinkedIn-Account Nick' } }));
  await page.route('**/api/settings/history', (route) => route.fulfill({ json: { entries: history } }));

  return {
    puts,
    software,
    /** Nächster PUT scheitert, weil inzwischen jemand anderes gespeichert hat. */
    conflictNext: () => {
      conflictOnce = true;
    },
  };
}

async function openSettings(page: Page) {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  await expect(page.getByTestId('settings-title')).toHaveText('Einstellungen');
}

const field = (page: Page, key: SettingKey) => page.getByTestId(`setting-${key}`);

/** Jede Gruppe ist ein eigener Bereich der Untermenüs – Werte stehen dort auf kleinen Unterseiten (`openSetting`). */
const openGroup = (page: Page, group: SettingGroup | 'history' | 'templates' | 'overview') => openSettingsSection(page, group);

test('Einstellungen: Wert ändern, speichern, Quelle und Verlauf', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeSettings(page);
  await openSettings(page);

  await expect(page.getByTestId('settings-cat-connections')).toHaveText('Verbindungen');
  // Geheimnis aus der .env: nur die letzten Zeichen, nie der Wert.
  await expect(field(page, 'UNIPILE_API_KEY').getByTestId('secret-status')).toHaveText('Gesetzt · endet auf …1234');
  await expect(page.getByText('env-unipile-key-1234')).toHaveCount(0);
  // Nur über die .env: mit Begründung, ohne Eingabe.
  await expect(field(page, 'DATA_DIR')).toContainText('nur über die .env änderbar');
  await expect(field(page, 'DATA_DIR').locator('input')).toHaveCount(0);
  // Woher ein Wert kommt (.env), steht nicht mehr am Feld.
  await expect(field(page, 'MAX_RESULTS').getByTestId('setting-source')).toHaveCount(0);

  // Zu groß: Prüfung schon im Browser, keine Anfrage.
  await openSetting(page, 'MAX_RESULTS');
  await field(page, 'MAX_RESULTS').locator('input').fill('1001');
  await page.getByTestId('settings-save').click();
  await expect(field(page, 'MAX_RESULTS').getByRole('alert')).toHaveText('Höchstens 1000.');
  expect(fake.puts).toHaveLength(0);

  await field(page, 'MAX_RESULTS').locator('input').fill('20');
  await expect(page.getByTestId('settings-message')).toHaveText('1 Änderung');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)).toEqual({ changes: { MAX_RESULTS: 20 }, version: 1 });
  await expect(field(page, 'MAX_RESULTS').getByTestId('setting-reset')).toHaveText('Zurück zu .env (15)');
  await expect(field(page, 'MAX_RESULTS').getByTestId('setting-source')).toHaveCount(0);

  // Zurück zur .env.
  await field(page, 'MAX_RESULTS').getByTestId('setting-reset').click();
  await expect(field(page, 'MAX_RESULTS').getByTestId('setting-pending-reset')).toBeVisible();
  await page.getByTestId('settings-save').click();
  await expect(field(page, 'MAX_RESULTS').getByTestId('setting-reset')).toHaveCount(0);
  expect(fake.puts.at(-1)?.changes).toEqual({ MAX_RESULTS: null });

  await openGroup(page, 'history');
  await expect(page.getByTestId('history-entry')).toHaveCount(2);
  await expect(page.getByTestId('history-entry').first()).toContainText('zurückgesetzt');
  expect(errors).toEqual([]);
});

test('Schlüssel ersetzen nur mit Passwort; der Wert erscheint danach nie wieder', async ({ page }) => {
  const errors = trackErrors(page, expectedStatus);
  const fake = await fakeSettings(page);
  await openSettings(page);

  await openSetting(page, 'ANTHROPIC_API_KEY');
  await field(page, 'ANTHROPIC_API_KEY').getByTestId('secret-replace').click();
  await field(page, 'ANTHROPIC_API_KEY').getByTestId('secret-input').fill('sk-ant-neuer-schluessel-9876');
  await page.getByTestId('settings-save').click();

  // Falsches Passwort: Meldung im Dialog, nichts gespeichert.
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByLabel('Passwort', { exact: true }).fill('falsch');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-dialog-error')).toHaveText('Das Passwort stimmt nicht.');
  expect(fake.software.ANTHROPIC_API_KEY).toBeUndefined();

  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByTestId('settings-dialog-confirm').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
  await expect(field(page, 'ANTHROPIC_API_KEY').getByTestId('secret-status')).toHaveText('Gesetzt · endet auf …9876');
  expect(fake.puts.at(-1)).toMatchObject({ changes: { ANTHROPIC_API_KEY: 'sk-ant-neuer-schluessel-9876' }, password: PASSWORD });
  await expect(page.getByText('sk-ant-neuer-schluessel-9876')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Unipile-Adresse ändern verlangt den Token neu; fremde Adressen werden abgelehnt', async ({ page }) => {
  const fake = await fakeSettings(page);
  await openSettings(page);
  const dsn = field(page, 'UNIPILE_DSN').locator('input');

  await openSetting(page, 'UNIPILE_DSN');
  await dsn.fill('https://angreifer.example');
  await page.getByTestId('settings-save').click();
  await expect(field(page, 'UNIPILE_DSN').getByRole('alert')).toHaveText('Die Adresse muss auf .unipile.com enden.');

  await dsn.fill('https://api99.unipile.com:13443');
  await page.getByTestId('settings-save').click();
  await expect(field(page, 'UNIPILE_API_KEY').getByRole('alert')).toContainText('neu eingeben');
  expect(fake.puts).toHaveLength(0);

  await field(page, 'UNIPILE_API_KEY').getByTestId('secret-replace').click();
  await field(page, 'UNIPILE_API_KEY').getByTestId('secret-input').fill('neuer-unipile-token-5555');
  await page.getByTestId('settings-save').click();
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByTestId('settings-dialog-confirm').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)?.changes).toEqual({ UNIPILE_DSN: 'https://api99.unipile.com:13443', UNIPILE_API_KEY: 'neuer-unipile-token-5555' });
});

test('Auf einen Blick: nur was fehlt, Klick springt zum Feld', async ({ page }) => {
  await fakeSettings(page);
  await openSettings(page);
  // Erste Ebene: Auf einen Blick und alle Bereiche unter drei Überschriften – keine Zwischenebene.
  for (const id of ['connections', 'outreach', 'system']) await expect(page.getByTestId(`settings-cat-${id}`)).toBeVisible();
  await expect(page.getByTestId('settings-nav').locator('button[data-testid^="settings-nav-"]')).toHaveCount(15);
  await openGroup(page, 'overview');
  const overview = page.getByTestId('settings-overview');
  await expect(overview.getByTestId('settings-todo')).toContainText('KI-Schlüssel fehlt');
  await expect(overview.getByTestId('settings-keys')).toHaveCount(0);
  await expect(overview.getByTestId('settings-limits')).toHaveCount(0);
  await overview.getByTestId('settings-todo').getByRole('button', { name: /KI-Schlüssel fehlt/ }).click();
  // KI-Bewertung ist eine einfache Seite: die Werte stehen direkt da, zurück geht es an den Anfang.
  await expect(page.getByTestId('settings-section-title')).toHaveText('KI-Bewertung');
  await expect(field(page, 'ANTHROPIC_API_KEY')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-title')).toHaveText('Einstellungen');
});

test('Rückfrage und Passwort; kein Modus-Schalter (echter Betrieb)', async ({ page }) => {
  const fake = await fakeSettings(page);
  await openSettings(page);
  await expect(page.getByTestId('setting-LEAD_SEARCH_MODE')).toHaveCount(0);
  await expect(page.getByTestId('setting-MOCK_SPEED')).toHaveCount(0);
  await expect(page.getByTestId('setting-AUTH_DEMO_ACCOUNTS')).toHaveCount(0);
  // Kein Hinweis auf eine Simulation – außer den Namen der erfundenen Accounts in der Account-Liste (lädt seit 28.10. sofort).
  await expect(page.getByText(/Simulation(?! *\))/)).toHaveCount(0);
  await openSetting(page, 'LINKEDIN_ACTIONS');
  // Schalter direkt auf der Seite: Umlegen fragt sofort nach Bestätigung und Passwort.
  await field(page, 'LINKEDIN_ACTIONS').getByRole('switch').click();
  await expect(page.getByTestId('settings-dialog')).toContainText('sendet das Cockpit echt');
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByTestId('settings-dialog-confirm').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)?.changes).toEqual({ LINKEDIN_ACTIONS: 'on' });
});

test('Server-Wert nur auf Probe: Restzeit, Client-IP, Behalten', async ({ page }) => {
  const fake = await fakeSettings(page);
  await openSettings(page);
  await openSetting(page, 'TRUST_PROXY_HOPS');
  await expect(field(page, 'TRUST_PROXY_HOPS')).toContainText('Der Server sieht dich gerade als 203.0.113.7.');

  // Zusammen mit anderen Werten nicht erlaubt.
  await field(page, 'TRUST_PROXY_HOPS').locator('input').fill('2');
  await openSetting(page, 'MAX_RESULTS');
  await field(page, 'MAX_RESULTS').locator('input').fill('18');
  await expect(page.getByTestId('settings-row-server.more')).toContainText('geändert');
  // Andere Seite offen: Der Fehler wechselt auf die Unterseite des Werts und setzt den Fokus ins Feld.
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-section-title')).toHaveText('Erweitert');
  await expect(field(page, 'TRUST_PROXY_HOPS').getByRole('alert')).toContainText('allein speichern');
  await expect(field(page, 'TRUST_PROXY_HOPS').locator('input')).toBeFocused();
  await openSetting(page, 'MAX_RESULTS');
  await field(page, 'MAX_RESULTS').getByRole('button', { name: 'Änderung verwerfen' }).click();

  await page.getByTestId('settings-save').click();
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByTestId('settings-dialog-confirm').click();
  await expect(page.getByTestId('trial-banner')).toContainText('„Proxys vor dem Backend“ gilt auf Probe – noch 4:');
  await page.getByTestId('trial-confirm').click();
  await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  await expect(page.getByTestId('settings-message')).toContainText('Behalten');
  expect(fake.puts.at(-1)?.changes).toEqual({ TRUST_PROXY_HOPS: 2 });
});

test('Gleichzeitig gespeichert: Hinweis, Seite neu geladen, Entwurf bleibt', async ({ page }) => {
  const fake = await fakeSettings(page);
  await openSettings(page);
  fake.conflictNext();
  await openSetting(page, 'MAX_RESULTS');
  await field(page, 'MAX_RESULTS').locator('input').fill('22');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-message')).toContainText('jemand anderes gespeichert');
  await expect(field(page, 'MAX_RESULTS').locator('input')).toHaveValue('22');
  // Zweiter Versuch mit neuer Version klappt.
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)).toEqual({ changes: { MAX_RESULTS: 22 }, version: 2 });
});

test('Verbindungstest zeigt das Ergebnis, aber nur mit gespeicherten Werten', async ({ page }) => {
  await fakeSettings(page);
  await openSettings(page);
  const button = page.getByTestId('test-unipile').getByRole('button', { name: 'Verbindung testen' });
  // Ungespeicherte Änderung in der Gruppe: Test würde die alten Werte prüfen – erst speichern.
  await openSetting(page, 'UNIPILE_DSN');
  await field(page, 'UNIPILE_DSN').locator('input').fill('https://api99.unipile.com:13443');
  await expect(button).toBeDisabled();
  await expect(page.getByTestId('test-unipile')).toContainText('Erst speichern, dann testen');
  await expect(field(page, 'UNIPILE_DSN').getByTestId('setting-source')).toHaveText('geändert');
  await field(page, 'UNIPILE_DSN').getByRole('button', { name: 'Änderung verwerfen' }).click();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('test-unipile').getByTestId('test-result')).toHaveText('Verbunden: LinkedIn-Account Nick');
  await expect(page.getByTestId('settings-announcement')).toHaveText('Verbunden: LinkedIn-Account Nick');
});

test('Schlüssel entfernen überdeckt auch den Wert aus der .env', async ({ page }) => {
  const fake = await fakeSettings(page);
  await openSettings(page);
  const key = field(page, 'UNIPILE_API_KEY');
  await openSetting(page, 'UNIPILE_API_KEY');
  await key.getByTestId('secret-remove').click();
  await expect(key.getByTestId('secret-pending-remove')).toContainText('auch ein Schlüssel aus der .env gilt dann nicht mehr');
  // Verwerfen bringt den alten Stand zurück.
  await key.getByRole('button', { name: 'Änderung verwerfen' }).click();
  await expect(key.getByTestId('secret-status')).toHaveText('Gesetzt · endet auf …1234');

  await key.getByTestId('secret-remove').click();
  await page.getByTestId('settings-save').click();
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByTestId('settings-dialog-confirm').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)?.changes).toEqual({ UNIPILE_API_KEY: '' });
  await expect(key.getByTestId('secret-status')).toHaveText('Nicht gesetzt');
});

test('Notfallmodus: Hinweis, gespeicherte Werte nur löschen', async ({ page }) => {
  const fake = await fakeSettings(page, { safeMode: true });
  fake.software.MAX_RESULTS = 3;
  await openSettings(page);
  await expect(page.getByTestId('safe-mode')).toContainText('Notfallmodus ist an');
  await expect(page.getByTestId('settings-nav-badge-leadSearch')).toHaveText('Prüfen');
  await openSetting(page, 'MAX_RESULTS');
  await expect(field(page, 'MAX_RESULTS')).toContainText('In der Software gespeichert, aber ignoriert: 3');
  await expect(field(page, 'MAX_RESULTS').locator('input')).toHaveCount(0);
  await field(page, 'MAX_RESULTS').getByTestId('setting-delete-stored').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  expect(fake.puts.at(-1)?.changes).toEqual({ MAX_RESULTS: null });
});

test('Einstellungen passen auf ein Handy (390 px) ohne seitliches Scrollen', async ({ page }) => {
  await fakeSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  test.setTimeout(180_000);
  await openSettings(page);
  // Läuft im Browser – als Text übergeben, weil die Testdateien ohne DOM-Typen geprüft werden.
  const overflow = () => page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Jeder Bereich und jede Unterseite.
  for (const group of SETTING_GROUPS) {
    await openGroup(page, group);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const rows = page.getByTestId(`group-${group}`).locator('[data-testid^="settings-row-"]:visible');
    const ids = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')!));
    for (const id of ids) {
      await page.getByTestId(id).click();
      expect(await overflow(), id).toBeLessThanOrEqual(0);
      await page.getByTestId('settings-back').click();
    }
  }
});

test('Untermenüs: Bereich → Unterseite, Stand, Entwurf bleibt beim Wechseln, Suche bis zum Wert', async ({ page }) => {
  await fakeSettings(page);
  await openSettings(page);
  await expect(page.getByTestId('settings-overview')).toBeHidden();

  // Erste Ebene: alle Bereiche direkt, je mit ein paar Wörtern, was darin steckt.
  await expect(page.getByTestId('settings-nav-leadSearch')).toContainText('Profile pro Lauf');
  await page.getByTestId('settings-nav-leadSearch').click();
  await expect(page.getByTestId('settings-section-title')).toHaveText('Lead-Suche');
  // Bereich: die wichtigen Werte direkt, der Rest unter „Erweitert“.
  await expect(field(page, 'MAX_RESULTS').locator('input')).toHaveValue('15');
  await expect(field(page, 'SEARCH_HITS_PER_RUN')).toBeHidden();
  await field(page, 'MAX_RESULTS').locator('input').fill('20');
  await expect(field(page, 'MAX_RESULTS').getByTestId('setting-source')).toHaveText('geändert');
  await page.getByTestId('settings-row-leadSearch.more').click();
  await expect(page.getByTestId('settings-section-title')).toHaveText('Erweitert');
  await expect(field(page, 'SEARCH_HITS_PER_RUN')).toBeVisible();
  await page.getByTestId('settings-back').click();
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('settings-nav-badge-leadSearch')).toHaveText('geändert');

  // In einen anderen Bereich und zurück: Der Entwurf bleibt, die Listen zeigen ihn weiter an.
  await openGroup(page, 'templates');
  await expect(field(page, 'MAX_RESULTS')).toBeHidden();
  await expect(page.getByTestId('settings-message')).toHaveCount(0);
  await openSetting(page, 'MAX_RESULTS');
  await expect(field(page, 'MAX_RESULTS').locator('input')).toHaveValue('20');
  await expect(page.getByTestId('settings-message')).toHaveText('1 Änderung');

  // Die Suche findet Bereiche und die Unterseite eines Werts – ein Klick führt direkt hin.
  await openGroup(page, 'overview');
  await page.getByTestId('settings-back').click();
  await page.getByTestId('settings-search').fill('Zeitzone');
  await expect(page.getByTestId('settings-nav').getByRole('button')).toHaveText([/Erweitert/]);
  await page.getByTestId('settings-result-linkedin.more').click();
  await expect(page.getByTestId('settings-section-title')).toHaveText('Erweitert');
  await expect(field(page, 'LINKEDIN_TIMEZONE')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-title')).toHaveText('Einstellungen');
  await page.getByTestId('settings-search').fill('gibtesnicht');
  await expect(page.getByTestId('settings-nav')).toContainText('Nichts gefunden für „gibtesnicht“.');
});

test('Firmendaten: Clay-Felder erst mit Quelle Clay', async ({ page }) => {
  await fakeSettings(page);
  await openSettings(page);
  await openGroup(page, 'clay');
  const group = page.getByTestId('group-clay');
  await expect(field(page, 'TREG_TOKEN')).toBeVisible();
  await expect(field(page, 'CLAY_WEBHOOK_URL')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Treg testen' })).toBeVisible();

  // Quelle umstellen: die Felder wechseln direkt auf der Seite.
  await field(page, 'ENRICHMENT_PROVIDER').getByRole('radio', { name: 'Clay' }).click();
  await expect(field(page, 'CLAY_WEBHOOK_URL')).toBeVisible();
  await expect(field(page, 'TREG_TOKEN')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Treg testen' })).toHaveCount(0);
});

test('KI-Modell per Auswahl statt Code (echtes Mock-Backend): Liste, speichern, eigene ID', async ({ page }) => {
  const errors = trackErrors(page);
  await openSettings(page);
  await openSetting(page, 'ANTHROPIC_MODEL');
  const select = field(page, 'ANTHROPIC_MODEL').getByTestId('model-select');
  await expect(select).toBeEnabled();
  // Anzeigename statt Code, Quelle sichtbar (Simulation: eingebaute Liste).
  await expect(select.locator('option', { hasText: 'Claude Sonnet 5.5' })).toHaveCount(1);
  await expect(field(page, 'ANTHROPIC_MODEL').getByTestId('model-source')).toContainText(/eingebaute Liste/i);
  await select.selectOption('claude-sonnet-5-5');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  const saved = await page.evaluate(async () => (await (await fetch('/api/settings')).json()) as { settings: Array<{ key: string; value: unknown }> });
  expect(saved.settings.find((entry) => entry.key === 'ANTHROPIC_MODEL')?.value).toBe('claude-sonnet-5-5');

  // Eigene Modell-ID, die die Liste nicht kennt.
  await select.selectOption({ label: 'Andere Modell-ID …' });
  await expect(field(page, 'ANTHROPIC_MODEL').getByTestId('model-input')).toBeVisible();

  // Aufräumen: zurück zum Standard.
  const reset = await page.evaluate(async () =>
    (await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { ANTHROPIC_MODEL: null } }) })).status,
  );
  expect(reset).toBe(200);
  expect(errors).toEqual([]);
});
