import { expect, test, type Page } from '@playwright/test';
import { findLead, resetCockpit, signIn } from './helpers';

/**
 * Rollen (`shared/auth.ts` → „Rollen und Rechte“) gegen das Mock-Backend mit den Testkonten:
 * `admin` (ohne Gründer, trägt nur ein) und `mitarbeiter` („Anna“, arbeitet für Nick, ohne Einstellungen).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

async function login(page: Page, account: 'nick' | 'admin' | 'mitarbeiter') {
  await page.goto('/?ping=off&undo=0');
  await signIn(page, account);
}

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();

async function openMenu(page: Page) {
  await page.getByRole('button', { name: /^Konto:/ }).click();
}

test('Admin: Aufgaben eines Gründers ansehen, wechseln und nur eintragen', async ({ page }) => {
  await login(page, 'admin');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Admin.');
  await expect(page.getByTestId('working-for')).toHaveText('Aufgaben von Nick');
  await expect(page.getByTestId('open-count')).toHaveText('14');
  // Auch in der Simulation sendet ein Admin nie über LinkedIn.
  await expect(page.getByTestId('protocol-hint')).toContainText('Als Admin trägst du nur ein');

  await openMenu(page);
  await expect(page.getByTestId('nav-settings')).toBeVisible();
  await expect(page.getByTestId('account-role')).toContainText('Trägt nur ein');
  await expect(page.getByTestId('menu-accounts')).toBeVisible();
  await page.getByTestId('admin-founder').getByRole('radio', { name: 'Johannes' }).click();
  await expect(page.getByTestId('working-for')).toHaveText('Aufgaben von Johannes');
  // Die Wahl gilt auch nach dem Neuladen.
  await page.reload();
  await signIn(page, 'admin');
  await expect(page.getByTestId('working-for')).toHaveText('Aufgaben von Johannes');
  await openMenu(page);
  await page.getByTestId('admin-founder').getByRole('radio', { name: 'Nick' }).click();
  await expect(page.getByTestId('working-for')).toHaveText('Aufgaben von Nick');

  // Eintragen: gebucht für Nick, im Verlauf steht, wer es war.
  await page.getByTestId('start-lead').click();
  await expect(currentCard(page).getByRole('button', { name: /Anfrage eintragen/ })).toBeVisible();
  const name = (await currentCard(page).getByTestId('lead-name').textContent())!;
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'nick', name)).stage).toBe('invited');
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-leads').click();
  await page.getByText(name).first().click();
  await expect(page.getByRole('dialog').getByTestId('event-actor').first()).toHaveText('von Admin für Nick');
});

test('Mitarbeiter: arbeitet für Nick, sendet in seinem Namen, keine Einstellungen und keine Konten', async ({ page }) => {
  await login(page, 'mitarbeiter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Anna.');
  await expect(page.getByTestId('working-for')).toHaveText('Aufgaben von Nick');
  await expect(page.getByTestId('reset-button')).toHaveCount(0);
  // Simulation: Gesendet wird über Nicks LinkedIn-Account.
  await expect(page.getByTestId('linkedin-status')).toContainText('Gesendet wird über den LinkedIn-Account von Nick');

  await openMenu(page);
  await expect(page.getByTestId('nav-settings')).toHaveCount(0);
  await expect(page.getByTestId('account-role')).toHaveText('Mitarbeiter · sendet für Nick');
  await expect(page.getByTestId('menu-accounts')).toHaveCount(0);
  await expect(page.getByTestId('admin-founder')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('start-lead').click();
  await expect(currentCard(page).getByRole('button', { name: /Vernetzen/ })).toBeVisible();
  const name = (await currentCard(page).getByTestId('lead-name').textContent())!;
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'nick', name)).stage).toBe('invited');

  // Das Backend sperrt die Einstellungen auch direkt.
  const settings = await page.request.get('/api/settings');
  expect(settings.status()).toBe(403);
});

test('Gründer: wie bisher, mit Kontenverwaltung und ohne Hinweis „Aufgaben von“', async ({ page }) => {
  await login(page, 'nick');
  await expect(page.getByTestId('working-for')).toHaveCount(0);
  await openMenu(page);
  await expect(page.getByTestId('nav-settings')).toBeVisible();
  await expect(page.getByTestId('menu-accounts')).toBeVisible();
  await expect(page.getByTestId('admin-founder')).toHaveCount(0);
});

test('Ganzer Weg ohne Nachbau: Admin lädt Mitarbeiterin ein, sie richtet das Konto ein und arbeitet für Johannes', async ({ page, browser }) => {
  const username = `e2e-anna-${Date.now().toString(36)}`;
  await login(page, 'admin');
  await openMenu(page);
  await page.getByTestId('menu-accounts').click();
  await expect(page.getByTestId('accounts-list')).toBeVisible();
  await page.getByTestId('accounts-invite').click();
  const dialog = page.getByTestId('invite-dialog');
  await dialog.getByTestId('invite-username-input').fill(username);
  await dialog.getByTestId('invite-name-input').fill('Anna Test');
  await dialog.getByRole('radio', { name: 'Mitarbeiter' }).click();
  await dialog.getByTestId('invite-founders-johannes').check();
  await dialog.getByTestId('invite-create').click();
  const link = (await page.getByTestId('link-url').textContent())!.trim();
  expect(link).toMatch(/\/einladung#[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId(`account-${username}`).getByTestId('account-status')).toContainText('Eingeladen');

  // Neuer Link für die offene Einladung ersetzt den alten (das Backend antwortet nicht mit 409).
  await page.getByTestId('link-dismiss').click();
  await page.getByTestId(`account-${username}`).getByTestId('account-renew').click();
  const renewed = (await page.getByTestId('link-url').textContent())!.trim();
  expect(renewed).not.toBe(link);

  // Die Mitarbeiterin öffnet den neuen Link in ihrem eigenen Browser.
  const context = await browser.newContext();
  const anna = await context.newPage();
  await anna.goto(renewed.replace(/^https?:\/\/[^/]+/, ''));
  await anna.getByLabel('Passwort', { exact: true }).fill('ein-langes-passwort');
  await anna.getByLabel('Passwort wiederholen').fill('ein-langes-passwort');
  await anna.getByTestId('invite-submit').click();
  // Neues Konto: erst die Einarbeitung.
  await expect(anna.getByTestId('work-intro')).toBeVisible();
  await expect(anna.getByText('Du arbeitest für Johannes.')).toBeVisible();
  await anna.getByTestId('intro-skip').click();
  await expect(anna.getByTestId('home')).toBeVisible();
  await expect(anna.getByTestId('working-for')).toHaveText('Aufgaben von Johannes');
  await anna.getByRole('button', { name: /^Konto:/ }).click();
  await expect(anna.getByTestId('nav-settings')).toHaveCount(0);
  await context.close();

  // Der alte Link gilt nicht mehr.
  const stale = await page.request.post('/api/auth/invite/check', { data: { token: link.split('#')[1] } });
  expect(stale.status()).toBe(404);

  // Admin entfernt das Konto wieder.
  await page.reload();
  await signIn(page, 'admin');
  await openMenu(page);
  await page.getByTestId('menu-accounts').click();
  await page.getByTestId(`account-${username}`).getByTestId('account-remove').click();
  await page.getByTestId('remove-confirm').click();
  await expect(page.getByTestId(`account-${username}`)).toHaveCount(0);
});

test('Gründer verwaltet alle Konten und lädt jede Rolle ein (nie auf die Shell)', async ({ page }) => {
  await login(page, 'nick');
  await openMenu(page);
  await page.getByTestId('menu-accounts').click();
  await expect(page.getByTestId('accounts-list')).toBeVisible();
  // Nick sieht alle Konten – auch Johannes und den Admin.
  await expect(page.getByTestId('account-mitarbeiter')).toBeVisible();
  await expect(page.getByTestId('account-johannes')).toBeVisible();
  await expect(page.getByTestId('account-admin')).toBeVisible();
  await page.getByTestId('accounts-invite').click();
  const dialog = page.getByTestId('invite-dialog');
  await expect(dialog.getByTestId('invite-role').getByRole('radio')).toHaveText(['Admin', 'Gründer', 'Mitarbeiter']);

  // Admin-Konto einladen: Das echte Backend nimmt es an und zeigt den Link.
  const username = `chef${Date.now() % 100000}`;
  await dialog.getByTestId('invite-role').getByRole('radio', { name: 'Admin' }).click();
  await dialog.getByTestId('invite-username-input').fill(username);
  await dialog.getByTestId('invite-name-input').fill('Chef');
  await dialog.getByTestId('invite-name-input').press('Enter');
  await expect(page.getByTestId('link-result')).toBeVisible();
  await expect(page.getByTestId(`account-${username}`).getByTestId('account-role')).toHaveText('Admin');
  // Aufräumen: Einladung zurückziehen.
  await page.getByTestId(`account-${username}`).getByTestId('account-remove').click();
  await page.getByTestId('remove-confirm').click();
  await expect(page.getByTestId(`account-${username}`)).toHaveCount(0);
});

test('Admin wechselt den Gründer mit offener Entscheidung: Sie wird vorher gespeichert', async ({ page }) => {
  // Rückgängig-Fenster 5 s – die Entscheidung ist beim Wechsel noch nicht gesendet.
  await page.goto('/?ping=off');
  await signIn(page, 'admin');
  await page.getByTestId('start-lead').click();
  const name = (await currentCard(page).getByTestId('lead-name').textContent())!;
  await page.keyboard.press('Enter');
  await page.getByTestId('progress').waitFor();
  await page.keyboard.press('Escape');
  await openMenu(page);
  await page.getByTestId('admin-founder').getByRole('radio', { name: 'Johannes' }).click();
  await expect(page.getByTestId('working-for')).toHaveText('Aufgaben von Johannes');
  expect((await findLead(page, 'nick', name)).stage).toBe('invited');
});

test('Mitarbeiter: Leads anderer Gründer nur ansehen, eigene Buchungen zeigen „von Anna für Nick“', async ({ page }) => {
  await login(page, 'mitarbeiter');
  await page.getByTestId('start-lead').click();
  const name = (await currentCard(page).getByTestId('lead-name').textContent())!;
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'nick', name)).stage).toBe('invited');
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-leads').click();
  await page.getByText(name).first().click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByTestId('event-actor').first()).toHaveText('von Anna für Nick');
  await expect(panel.getByTestId('lead-read-only')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Ein Lead von Johannes: nur lesen (Leads-Ansicht auf „Alle“).
  await page.getByRole('tab', { name: 'Alle' }).click();
  const other = (await (await page.request.get('/api/leads?owner=johannes&limit=1')).json()) as { leads: { id: string; person: { firstName: string; lastName: string } }[] };
  const johannesLead = other.leads[0];
  await page.getByText(`${johannesLead.person.firstName} ${johannesLead.person.lastName}`).first().click();
  await expect(page.getByRole('dialog').getByTestId('lead-read-only')).toContainText('gehört Johannes');
  // Und das Backend lehnt Buchungen dort ab.
  const denied = await page.request.post(`/api/leads/${johannesLead.id}/events`, { data: { action: 'note', text: 'x' } });
  expect(denied.status()).toBe(403);
});

test('Gründer bucht selbst: kein „von …“ im Verlauf', async ({ page }) => {
  await login(page, 'nick');
  await page.getByTestId('start-lead').click();
  const name = (await currentCard(page).getByTestId('lead-name').textContent())!;
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'nick', name)).stage).toBe('invited');
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-leads').click();
  await page.getByText(name).first().click();
  await page.getByRole('dialog').getByTestId('lead-tab-history').click();
  await expect(page.getByRole('dialog').getByText('Vernetzungsanfrage gesendet von Nick')).toBeVisible();
  await expect(page.getByRole('dialog').getByTestId('event-actor')).toHaveCount(0);
});
