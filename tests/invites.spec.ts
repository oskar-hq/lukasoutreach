import { expect, test } from '@playwright/test';
import { resetCockpit, signIn, trackErrors, gotoSettings, openSetting } from './helpers';

/**
 * Teammeeting 05.11. (Vertrag shared/linkedin.ts → Anfragen von Hand …): Zähler auf der Startseite, Anfragen-Modus je
 * Gründer-Account, Dashboard → Vernetzen mit Statistik, Überprüfung und neuen Kontakten – gegen das Mock-Backend.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

test('Startseite zeigt die Anfragen von heute samt Tagesziel', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  const today = page.getByTestId('invites-sent-today');
  await expect(today).toBeVisible();
  await expect(page.getByTestId('invites-sent-count')).toHaveText(/^\d+ von \d+$/);
  await expect(page.getByTestId('invites-left')).toContainText(/Noch \d+ offen|Tagesziel erreicht/);
  expect(errors).toEqual([]);
});

test('Anfragen-Modus je Gründer-Account: über den Tag verteilt, nur von Hand mit Ende, zurück', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  await openSetting(page, 'UNIPILE_ACCOUNT_NICK');
  const accounts = page.getByTestId('group-linkedin').getByTestId('linkedin-accounts');
  await accounts.getByTestId('linkedin-accounts-load').click();
  const johannesRow = accounts.getByTestId('linkedin-account-list').locator('li', { hasText: 'Johannes (Simulation)' });
  const picker = johannesRow.getByTestId('linkedin-invite-mode');
  await expect(picker.getByTestId('linkedin-invite-mode-spread')).toHaveAttribute('aria-pressed', 'true');
  // Scraping-Accounts senden nicht – dort gibt es die Wahl nicht.
  await expect(accounts.getByTestId('linkedin-account-list').locator('li', { hasText: 'Scraping-Account' }).getByTestId('linkedin-invite-mode')).toHaveCount(0);

  await picker.getByTestId('linkedin-manual-days').fill('7');
  await picker.getByTestId('linkedin-invite-mode-manual').click();
  await expect(picker.getByTestId('linkedin-invite-mode-manual')).toHaveAttribute('aria-pressed', 'true');
  await expect(picker).toContainText('Bis ');
  const status = await (await page.request.get('/api/linkedin/status')).json();
  const johannes = status.accounts.find((account: { founder: string }) => account.founder === 'johannes');
  expect(johannes.inviteMode).toBe('manual');
  expect(johannes.manualUntil).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);

  await picker.getByTestId('linkedin-invite-mode-spread').click();
  await expect(picker.getByTestId('linkedin-invite-mode-spread')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('Dashboard → Vernetzen: Statistik je Gründer, Überprüfung findet und übernimmt Kontakte', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-dashboard').click();
  await page.getByRole('tab', { name: 'Vernetzen' }).click();
  const section = page.getByTestId('invite-section');
  await expect(section.getByTestId('invite-stats-nick')).toBeVisible();
  await expect(section.getByTestId('invite-stats-johannes')).toBeVisible();
  await expect(section.getByTestId('invite-rate-nick')).toHaveText(/%|–/);
  // Je Tag nur noch eine Spalte „Angenommen“, darunter die Zahlen seit Beginn (07.11.).
  await expect(section.getByTestId('invite-lifetime-nick')).toContainText('Seit Beginn');

  await section.getByTestId('audit-start').click();
  const result = section.getByTestId('audit-result');
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result.getByTestId('audit-nick')).toBeVisible();
  await expect(result.getByTestId('audit-unknown').filter({ hasText: 'Mara Beispiel' })).toContainText('übernommen');
  await expect(section.getByTestId('audit-start')).toHaveText('Noch einmal prüfen');

  // Neue Kontakte: nach dem erneuten Öffnen des Reiters steht Mara dort.
  await page.getByRole('tab', { name: 'Überblick' }).click();
  await page.getByRole('tab', { name: 'Vernetzen' }).click();
  await expect(page.getByTestId('new-contact').filter({ hasText: 'Mara Beispiel' })).toContainText('übernommen');
  expect(errors).toEqual([]);
});

test('Überprüfung: „Vernetzt, aber noch keine Nachricht“ mit einem Klick zurück in den Tagesstapel (07.11.)', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  // Ein vernetzter Lead von Nick, „für heute übersprungen“ – fehlt also im Stapel.
  const list = (await (await page.request.get('/api/leads?owner=nick&stage=connected&limit=1')).json()) as { leads: { id: string; person: { firstName: string; lastName: string } }[] };
  const lead = list.leads[0];
  expect(lead).toBeTruthy();
  const name = `${lead.person.firstName} ${lead.person.lastName}`;
  expect((await page.request.post(`/api/leads/${lead.id}/snooze`, { data: {} })).ok()).toBe(true);
  const inStack = async () => {
    const tasks = (await (await page.request.get('/api/tasks?owner=nick')).json()) as { tasks: { lead: { id: string } }[] };
    return tasks.tasks.some((task) => task.lead.id === lead.id);
  };
  expect(await inStack()).toBe(false);

  // Ergebnis der Überprüfung mit genau diesem Lead (die Simulation findet sonst andere).
  const audit = {
    running: false,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    days: 14,
    done: 1,
    total: 1,
    founders: [
      { founder: 'nick', connections: 1, ok: 0, fixedAccepted: [], chatImported: [], notMessaged: [{ leadId: lead.id, name, connectedAt: Date.now() }], unknown: [], invitesSent: 1, acceptedBefore: 1, acceptedAfter: 1, problem: null },
    ],
  };
  await page.route('**/api/linkedin/audit', (route) => route.fulfill({ status: route.request().method() === 'POST' ? 202 : 200, json: audit }));

  await page.getByTestId('nav-dashboard').click();
  await page.getByRole('tab', { name: 'Vernetzen' }).click();
  const section = page.getByTestId('invite-section');
  await section.getByTestId('audit-start').click();
  const row = section.getByTestId('audit-not-messaged-lead').filter({ hasText: name });
  await row.getByTestId('audit-stack').click();
  await expect(row).toContainText('im Tagesstapel');
  await expect.poll(inStack).toBe(true);
  expect(errors).toEqual([]);
});
