import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { fail, resetCockpit, signIn, trackErrors, gotoSettings, openSettingsSection } from './helpers';

/**
 * Vorlagen aus dem Backend (`shared/messages.ts`): Seite unter Einstellungen → Vorlagen (`GET /api/templates`,
 * `PUT /api/templates/:id`, `POST /api/templates/:id/reset`) und die Karten im Tagesstapel, die sie ausfüllen.
 * Die Vorlagen liegen in der Datenbank des Test-Backends – jeder Test setzt sie vorher zurück.
 */
const IDS = ['N1', 'G1', 'G2', 'R1', 'R2', 'S1', 'S2', 'GF1', 'RF1', 'SF1', 'H1', 'F1A', 'F2A', 'F3A', 'F1F', 'F2F', 'F3F'];

async function resetTemplates(request: APIRequestContext) {
  for (const id of IDS) expect((await request.post(`/api/templates/${id}/reset`)).status()).toBe(200);
  // Eigene Vorlagen aus früheren Tests löschen.
  const { templates } = (await (await request.get('/api/templates')).json()) as { templates: { id: string; custom?: boolean }[] };
  for (const template of templates.filter((entry) => entry.custom)) {
    expect((await request.delete(`/api/templates/${encodeURIComponent(template.id)}`)).status()).toBe(200);
  }
}

test.beforeEach(async ({ request }) => {
  await resetCockpit(request);
  await resetTemplates(request);
});
test.afterAll(async ({ request }) => {
  await request.post('/api/auth/login', { data: { username: 'nick', password: process.env.E2E_PASSWORD ?? 'demo' } });
  await resetTemplates(request);
});

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();
const DECISION = /\/api\/leads\/[^/]+\/(events|linkedin\/message)$/;

async function openTemplates(page: Page) {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  await openSettingsSection(page, 'templates');
  await expect(page.getByTestId('templates')).toBeVisible();
}

test('Vorlagen-Seite: alle Vorlagen, bearbeiten, speichern, zurücksetzen', async ({ page }) => {
  const errors = trackErrors(page);
  await openTemplates(page);
  for (const id of IDS) await expect(page.getByTestId(`template-${id}`)).toBeVisible();
  const row = page.getByTestId('template-G2');
  await row.getByTestId('template-toggle-G2').click();
  await expect(row.getByRole('group', { name: 'Platzhalter einfügen' })).toContainText('{{grussformel}}');
  await expect(row).not.toContainText('Angepasst');

  // Bearbeiten → Vorschau zeigt den ausgefüllten Text, Speichern schickt genau ein PUT
  await row.getByTestId('template-text-G2').fill('Hallo {{vorname}}, ein neuer Text für {{firma}}.\n\n{{grussformel}}');
  await row.getByRole('button', { name: 'Vorschau' }).click();
  await expect(row.getByTestId('template-preview-G2')).toContainText('Hallo Anna, ein neuer Text für Muster Immobilien GmbH.');
  await expect(page.getByTestId('templates-message')).toHaveText('1 Änderung');
  const put = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/api/templates/G2'));
  await page.getByTestId('templates-save').click();
  expect((await put).postDataJSON()).toMatchObject({ text: 'Hallo {{vorname}}, ein neuer Text für {{firma}}.\n\n{{grussformel}}' });
  await expect(page.getByTestId('templates-message')).toContainText('Gespeichert');
  await expect(row).toContainText('Angepasst von nick');

  // Bleibt nach dem Neuladen
  await page.reload();
  await signIn(page, 'nick');
  await gotoSettings(page);
  // Die Einstellungen beginnen wie eine App immer auf der ersten Ebene.
  await expect(page.getByTestId('settings-title')).toHaveText('Einstellungen');
  await openSettingsSection(page, 'templates');
  await page.getByTestId('template-toggle-G2').click();
  await expect(page.getByTestId('template-text-G2')).toHaveValue(/ein neuer Text/);

  // Zurücksetzen
  await page.getByTestId('template-reset-G2').click();
  await expect(page.getByTestId('template-G2')).toContainText('Wird zurückgesetzt');
  await page.getByTestId('templates-save').click();
  await expect(page.getByTestId('template-G2')).not.toContainText('Angepasst');
  await expect(page.getByTestId('template-reset-G2')).toHaveCount(0);
  await expect(page.getByTestId('template-text-G2')).not.toHaveValue(/ein neuer Text/);
  expect(errors).toEqual([]);
});

test('Vorlagen-Seite: Fehler werden vor dem Senden erkannt, Server-Fehler an der Vorlage', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 400\b/.test(text));
  const puts: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/templates/')) puts.push(request);
  });
  await openTemplates(page);

  // Unbekannter Platzhalter
  await page.getByTestId('template-toggle-G1').click();
  await page.getByTestId('template-text-G1').fill('Hallo {{vornam}},\n\n{{grussformel}}');
  await expect(page.getByTestId('template-error-G1')).toContainText('{{vornam}}');
  await expect(page.getByTestId('template-text-G1')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('templates-save').click();
  await expect(page.getByTestId('templates-message')).toContainText('Bitte erst korrigieren: Erstnachricht · Greenfield A');
  await expect(page.getByTestId('template-text-G1')).toBeFocused();

  // Notiz zur Vernetzungsanfrage: höchstens 300 Zeichen
  await page.getByTestId('template-toggle-N1').click();
  await page.getByTestId('template-text-N1').fill('x'.repeat(301));
  await expect(page.getByTestId('template-count-N1')).toHaveText('301 / 300');
  await expect(page.getByTestId('template-error-N1')).toContainText('300');
  expect(puts).toHaveLength(0);

  // Verwerfen räumt auf
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(page.getByTestId('template-error-G1')).toHaveCount(0);

  // Server lehnt ab → Satz an der Vorlage
  await page.route('**/api/templates/F1A', (route) => fail(route, 400, 'invalid_template', 'Der Server mag diesen Text nicht.'));
  await page.getByTestId('template-toggle-F1A').click();
  await page.getByTestId('template-text-F1A').fill('Hallo {{vorname}}, kurz nachgehakt.\n\n{{grussformel}}');
  await page.getByTestId('templates-save').click();
  await expect(page.getByTestId('template-error-F1A')).toHaveText('Der Server mag diesen Text nicht.');
  await expect(page.getByTestId('templates-message')).toContainText('nicht gespeichert');
  expect(errors).toEqual([]);
});

test('Vorlagen laden scheitert: Erneut versuchen', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 500\b/.test(text));
  let broken = true;
  await page.route('**/api/templates', (route) => (broken ? fail(route, 500, 'error', 'Kaputt') : route.fallback()));
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  await openSettingsSection(page, 'templates');
  await expect(page.getByTestId('templates-load-error')).toBeVisible();
  broken = false;
  await page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(page.getByTestId('template-G1')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Karten füllen die Vorlagen des Servers aus und melden ihre ID', async ({ page, request }) => {
  const errors = trackErrors(page);
  // Alle Erstnachrichten markieren – welche Zielgruppe die Karte hat, entscheidet der Lead.
  for (const id of ['G1', 'G2', 'R1', 'R2', 'S1', 'S2']) {
    const response = await request.put(`/api/templates/${id}`, { data: { text: `Hallo {{vorname}}, Testmarke ${id}.\n\n{{grussformel}}` } });
    expect(response.status()).toBe(200);
  }
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-first').click();
  const card = currentCard(page);
  const picker = card.getByRole('tablist', { name: 'Template wählen' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('tab').first()).toContainText('A');
  // Leads mit Hiring-Signal bieten zuerst die Recruiting-Vorlage H1 an (eigener Test in hiring.spec.ts) – weiterblättern.
  for (let i = 0; i < 5 && /Verstärkung/.test(await currentCard(page).getByRole('textbox').first().inputValue()); i++) {
    const id = await currentCard(page).getAttribute('data-card-id');
    await page.getByTestId('defer').click();
    await expect(currentCard(page)).not.toHaveAttribute('data-card-id', id!);
  }
  const editor = currentCard(page).getByRole('textbox').first();
  const first = (await editor.inputValue()).match(/Testmarke ([GRS]1)/)![1];
  const second = first.replace('1', '2');
  await expect(editor).toHaveValue(new RegExp(`Testmarke ${first}\\.\\n\\nViele Grüße\\nNick$`));

  // Taste 2 wählt die zweite Vorlage – gemeldet wird ihre ID
  await page.keyboard.press('2');
  await expect(editor).toHaveValue(new RegExp(`Testmarke ${second}`));
  const sent = page.waitForRequest((r) => r.method() === 'POST' && DECISION.test(new URL(r.url()).pathname));
  await page.keyboard.press('Enter');
  expect((await sent).postDataJSON()).toMatchObject({ label: second });
  expect(errors).toEqual([]);
});

test('Follow-up: Varianten aus dem Server, eigene Nachricht ohne Vorlage', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-followup').click();
  const card = currentCard(page);
  const picker = card.getByRole('tablist', { name: 'Follow-up-Variante' });
  // Je Stufe die Vorlage des Kunden (A) und seit 02.11. auch die für Finanzdienstleister (B) + „Eigene Nachricht“.
  await expect(picker.getByRole('tab')).toHaveCount(3);
  await expect(picker.getByRole('tab').first()).toContainText('A · ');

  // Variante A (↵) → Label F…A
  let sent = page.waitForRequest((r) => r.method() === 'POST' && DECISION.test(new URL(r.url()).pathname));
  await page.keyboard.press('Enter');
  expect((await sent).postDataJSON().label).toMatch(/^F[123]A$/);

  // Nächste Follow-up-Karte: eigene Nachricht (Taste 3) → ohne Label
  await expect(currentCard(page).getByRole('tablist', { name: 'Follow-up-Variante' })).toBeVisible();
  await page.keyboard.press('3');
  await currentCard(page).getByRole('textbox').first().fill('Hallo, nur kurz von mir.');
  sent = page.waitForRequest((r) => r.method() === 'POST' && DECISION.test(new URL(r.url()).pathname));
  await currentCard(page).getByRole('button', { name: /Senden|eintragen/ }).last().click();
  expect((await sent).postDataJSON().label).toBeUndefined();
  expect(errors).toEqual([]);
});

test('Ohne Vorlagen bleibt die Erstnachricht nutzbar – Erneut laden behält den Text', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 500\b/.test(text));
  let broken = true;
  await page.route('**/api/templates', (route) => (broken ? fail(route, 500, 'error', 'Kaputt') : route.fallback()));
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-first').click();
  const card = currentCard(page);
  await expect(card.getByTestId('templates-unavailable')).toContainText('nicht geladen');
  await card.getByRole('textbox').first().fill('Hallo, freie Nachricht.');
  await expect(card.getByRole('button', { name: /Senden|eintragen/ }).last()).toBeEnabled();

  // Vorlagen kommen zurück – der getippte Text bleibt, als „Eigene Nachricht“ neben den Vorlagen
  broken = false;
  await card.getByRole('button', { name: 'Erneut laden' }).click();
  const picker = card.getByRole('tablist', { name: 'Template wählen' });
  await expect(picker.getByRole('tab', { name: /Eigene Nachricht/ })).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByRole('textbox').first()).toHaveValue('Hallo, freie Nachricht.');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && DECISION.test(new URL(r.url()).pathname));
  await page.keyboard.press('Enter');
  expect((await sent).postDataJSON().label).toBeUndefined();
  expect(errors).toEqual([]);
});

test('Vorlagen-Seite: Platzhalter mit Ziffern oder Unterstrich gelten als unbekannt', async ({ page }) => {
  await openTemplates(page);
  await page.getByTestId('template-toggle-G1').click();
  await page.getByTestId('template-text-G1').fill('Hallo {{vor_name}} von {{firma2}}');
  await expect(page.getByTestId('template-error-G1')).toContainText('{{vor_name}}');
  await expect(page.getByTestId('template-error-G1')).toContainText('{{firma2}}');
});

test('Vorlagen passen auf ein Handy (390 px) ohne seitliches Scrollen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTemplates(page);
  await expect(page.getByTestId('template-G1')).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(390);
});

test('Eigene Vorlagen: anlegen (Buchstabe C), auf der Karte wählbar, löschen – die letzte bleibt', async ({ page }) => {
  const errors = trackErrors(page);
  await openTemplates(page);
  const section = page.getByTestId('templates-followup_1');
  // Vernetzungsanfrage hat nur A – nicht löschbar.
  await page.getByTestId('template-toggle-N1').click();
  await expect(page.getByTestId('template-remove-N1')).toHaveCount(0);

  await page.getByTestId('template-add-followup_1').click();
  const added = section.locator('article').last();
  // Je Follow-up-Stufe eine Standardvorlage für Kapitalanlage und seit 27.10. eine für Finanzdienstleister → die eigene ist C.
  await expect(added).toContainText('C');
  await expect(added).toContainText('Neue Vorlage');
  // Leer speichern geht nicht
  await page.getByTestId('templates-save').click();
  await expect(page.getByTestId('templates-message')).toContainText('Bitte erst korrigieren: Follow-up 1 C');
  await added.locator('textarea').fill('Hallo {{vorname}}, Variante C aus dem Test.');
  await added.locator('input').fill('Dritte Variante');
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/templates');
  await page.getByTestId('templates-save').click();
  expect((await created).status()).toBe(201);
  await expect(page.getByTestId('templates-message')).toContainText('Gespeichert');
  await expect(section.locator('article')).toHaveCount(3);
  await expect(section.locator('article').last()).toContainText('Dritte Variante');

  // Karte: Seit 02.11. zeigt sie alle Vorlagen der Stufe (Kapitalanlage, Finanzdienstleister, eigene) – die eigene ist
  // dort C, „Eigene Nachricht“ rückt auf 4 (die Karte kann Stufe 1–3 sein – C überall).
  for (const category of ['followup_2', 'followup_3']) {
    expect((await page.request.post('/api/templates', { data: { category, name: 'Dritte Variante', text: 'Hallo {{vorname}}, C.' } })).status()).toBe(201);
  }
  await page.goto('/?ping=off&undo=0');
  await page.getByTestId('start-followup').click();
  const picker = currentCard(page).getByRole('tablist', { name: 'Follow-up-Variante' });
  await expect(picker.getByRole('tab')).toHaveCount(4);
  await expect(picker.getByRole('tab').nth(2)).toContainText('C · Dritte Variante');

  // Löschen
  await page.goto('/?ping=off');
  await gotoSettings(page);
  await openSettingsSection(page, 'templates');
  const custom = page.getByTestId('templates-followup_1').locator('article').last();
  await custom.locator('button[aria-expanded]').first().click();
  await custom.getByRole('button', { name: 'Löschen' }).click();
  await expect(custom).toContainText('Wird gelöscht');
  await page.getByTestId('templates-save').click();
  await expect(page.getByTestId('templates-message')).toContainText('Gespeichert');
  await expect(page.getByTestId('templates-followup_1').locator('article')).toHaveCount(2);
  expect(errors).toEqual([]);
});
