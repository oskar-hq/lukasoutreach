import { expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { SettingKey } from '../shared/settings';
import { navItem, sectionOfPage, subpageOf, type SettingsSection } from '../src/components/settings/settingsNav';

/**
 * Sammelt Fehler aus Seite und Konsole. Antworten der Anmeldung sind erwartet und zählen nicht:
 * 401 ohne Sitzung, 404 solange das Backend keinen Login hat. `ignore` blendet weitere Meldungen aus.
 */
export function trackErrors(page: Page, ignore?: (text: string, url: string) => boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location().url;
    const path = new URL(url, 'http://localhost').pathname;
    if (path.startsWith('/api/auth/')) return;
    if (ignore?.(message.text(), url)) return;
    errors.push(message.text());
  });
  return errors;
}

/** Passwort der Testkonten (`AUTH_DEMO_ACCOUNTS=true`, siehe `shared/auth.ts`). Nur für Tests gegen echte Konten ändern. */
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'demo';

/** true, solange das Backend noch keinen Login hat (`/api/auth/me` → 404) – dann gibt es die Demo-Auswahl. */
export async function demoLogin(page: Page): Promise<boolean> {
  const response = await page.request.get('/api/auth/me');
  return response.status() === 404;
}

/**
 * Meldet als Gründer an – über die Demo-Karten oder, sobald das Backend den Login hat, über das Formular.
 * Ist die Sitzung schon offen (z. B. nach Neuladen), passiert nichts. Nach dem Abmelden erst warten, bis die
 * Startseite verschwunden ist – während sie ausblendet, sähe sie wie eine offene Sitzung aus.
 */
/**
 * Anmelden. Standard im Cockpit ist seit 01.11. „Alle“; die meisten Tests prüfen aber den eigenen Stapel und wählen
 * deshalb vorher „Meine“ (wie ein Gründer, der umgeschaltet hat). `scope: 'default'` lässt die Wahl unberührt.
 */
export async function signIn(page: Page, founder: 'nick' | 'johannes' | 'admin' | 'mitarbeiter', scope: 'mine' | 'default' = 'mine') {
  if (scope === 'mine' && (founder === 'nick' || founder === 'johannes')) {
    await page.evaluate((key) => globalThis.localStorage.setItem(key, 'mine'), `cockpit.stackScope.v2.${founder}`).catch(() => undefined);
  }
  const card = page.getByTestId(`login-${founder}`);
  const form = page.getByTestId('login-form');
  const home = page.getByTestId('home');
  await expect(card.or(form).or(home)).toBeVisible();
  if (await form.isVisible()) {
    await page.getByLabel('Name').fill(founder);
    await page.getByLabel('Passwort', { exact: true }).fill(E2E_PASSWORD);
    await page.getByTestId('login-submit').click();
  } else if (await card.isVisible()) {
    await card.click();
  }
  await expect(home).toBeVisible();
}

/**
 * Simulation zurück auf die 30 Demo-Leads (`POST /api/leads/demo/reset`). Alle Tests laufen nacheinander gegen
 * dasselbe Mock-Backend – ohne Zurücksetzen bekäme jeder Test die Entscheidungen der vorigen mit. Läuft über einen
 * eigenen Request-Kontext, damit der Browser dabei nicht angemeldet wird.
 */
export async function resetCockpit(request: APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: { username: 'nick', password: E2E_PASSWORD } });
  expect([200, 404]).toContain(login.status());
  const reset = await request.post('/api/leads/demo/reset');
  expect(reset.status()).toBe(200);
}

/** Lead aus der Datenbank (über die Sitzung des Browsers) – zum Prüfen, was wirklich gespeichert ist. */
export async function findLead(page: Page, owner: 'nick' | 'johannes', name: string) {
  const response = await page.request.get(`/api/leads?owner=${owner}&limit=2000`);
  expect(response.status()).toBe(200);
  const { leads } = (await response.json()) as { leads: { id: string; stage: string; followUpsSent: number; snoozedUntil?: number | null; person: { firstName: string; lastName: string } }[] };
  const lead = leads.find((candidate) => `${candidate.person.firstName} ${candidate.person.lastName}` === name);
  if (!lead) throw new Error(`Lead ${name} nicht gefunden`);
  return lead;
}

/** Fehlerantwort im Format `ApiErrorBody` für nachgebaute Routen (`field` z. B. bei `invalid_setting`). */
export const fail = (
  route: Route,
  status: number,
  code: string,
  message: string,
  options: { headers?: Record<string, string>; field?: string } = {},
) => route.fulfill({ status, json: { error: { code, message, ...(options.field ? { field: options.field } : {}) } }, headers: options.headers });

/**
 * Echte Sitzung beim Mock-Backend (Testkonto), damit die Lead-Suche hinter nachgebauten Auth-Routen antwortet,
 * auch wenn das Backend die Sitzung verlangt. `page.request` teilt die Cookies mit dem Browser, läuft aber nicht
 * durch `page.route`. 404: Backend ohne Login.
 */
export async function realSession(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { username: 'nick', password: E2E_PASSWORD } });
  expect([200, 404]).toContain(response.status());
}

/** Öffnet die Einstellungen – im Avatar-Menü (früher Zahnrad in der Leiste). */
export async function gotoSettings(page: Page) {
  const account = page.getByRole('button', { name: /^Konto: / });
  await expect(account).toBeVisible();
  const entry = page.getByTestId('nav-settings');
  if (!(await entry.isVisible())) await account.click();
  await entry.click();
}

/**
 * Wechselt in den Einstellungen in einen Bereich: erst zurück zur ersten Ebene (dort stehen alle Bereiche), dann
 * der Bereich. Danach steht die Liste des Bereichs da (Unterseiten, Stand, Verbindungstests).
 */
export async function openSettingsSection(page: Page, section: SettingsSection) {
  const title = page.getByTestId('settings-title');
  for (let i = 0; i < 4 && !((await title.isVisible()) && (await title.textContent()) === 'Einstellungen'); i++) {
    await page.getByTestId('settings-back').click();
  }
  const search = page.getByTestId('settings-search');
  if (await search.inputValue()) await search.fill('');
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId('settings-section-title')).toHaveText(navItem(section).label);
}

/** Öffnet die Unterseite, auf der ein Wert steht (Bereich → Zeile). */
export async function openSetting(page: Page, key: SettingKey) {
  const target = subpageOf(key);
  const section = sectionOfPage(target);
  await openSettingsSection(page, section);
  // Die wichtigen Werte (und Software-Update) stehen direkt auf der Seite – ohne Unterseite.
  if (section !== target.group || target.inline) return;
  await page.getByTestId(`settings-row-${target.id}`).click();
  await expect(page.getByTestId(`settings-page-${target.id}`)).toBeVisible();
}

/** Position eines Elements, sobald es nicht mehr animiert (zwei Messungen hintereinander gleich). */
export async function settledBox(locator: Locator) {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const box = await locator.boundingBox();
    const key = JSON.stringify(box);
    if (box && key === last) return box;
    last = key;
    await locator.page().waitForTimeout(100);
  }
  throw new Error('Element kommt nicht zur Ruhe');
}

/** Öffnet die KI – seit 25.10. kein eigener Tab mehr, sondern „KI fragen“ oben im Dashboard. */
export async function openAssistant(page: Page) {
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('dashboard-ask').click();
  await expect(page.getByTestId('assistant-view')).toBeVisible();
}
