import { expect, test } from '@playwright/test';
import { findLead, gotoSettings, openSettingsSection, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Wünsche des Nutzers 15.10.:
 * - Erstnachricht: Kategorie der Vorlage von Hand wählen („Meta Ads nie“, „Meta Ads aus“, …).
 * - Übersprungene Leads („Nicht senden“) im Lead-Panel sofort zurück in den Tagesstapel holen.
 * - Meta-Ads aller Leads nachprüfen (Einstellungen → Meta-Werbebibliothek).
 * Demo-Daten: Nicks vernetzter Lead Jonas Vogt (Hiring-Signal → zuerst „Sucht Mitarbeiter“).
 */
test.beforeEach(async ({ request }) => {
  await resetCockpit(request);
  for (const id of ['H1', 'G1', 'R1']) expect((await request.post(`/api/templates/${id}/reset`)).status()).toBe(200);
});

// Die Nachprüfung ändert Meta-Stände der Demo-Leads – danach wieder den Ausgangsstand für andere Tests.
test.afterEach(async ({ request }) => {
  await resetCockpit(request);
});

const currentCard = (page: import('@playwright/test').Page) => page.locator('[data-testid=stack-card]').last();

test('Erstnachricht: Kategorie von Hand wählen – Vorlagen der Kategorie, gemeldet wird ihre ID', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-first').click();
  const card = currentCard(page);
  // Die Kategorie wählt die Karte selbst – alle vier erst auf Klick (Wunsch des Nutzers 25.10.).
  const picker = card.getByTestId('audience-picker');
  await expect(picker).toHaveCount(0);
  await card.getByTestId('audience-toggle').click();
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('radio', { checked: true })).toHaveCount(1);

  await picker.getByTestId('audience-reactivation').click();
  await expect(picker.getByTestId('audience-reactivation')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByTestId('audience-toggle')).toContainText('Meta Ads aus');
  // Wer die Kategorie selbst wählt, hat die Ads schon eingeschätzt – keine Warnung.
  await expect(card.getByTestId('template-warning')).toHaveCount(0);
  const tabs = card.getByRole('tablist', { name: 'Template wählen' });
  await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');

  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/leads\/[^/]+\/(events|linkedin\/message)$/.test(new URL(r.url()).pathname));
  await page.keyboard.press('Enter');
  expect((await sent).postDataJSON()).toMatchObject({ label: 'R1' });
  expect(errors).toEqual([]);
});

test('Übersprungen: im Lead-Panel zurück in den Tagesstapel holen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  const lead = await findLead(page, 'nick', 'Jonas Vogt');
  expect((await page.request.post(`/api/leads/${lead.id}/snooze`, { data: {} })).status()).toBe(200);

  await page.getByTestId('nav-leads').click();
  await page.getByTestId('leads-board').getByTestId('column-connected').getByText('Jonas Vogt').click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByTestId('panel-snoozed')).toContainText('Übersprungen bis');
  // Meta-Werbebibliothek mit einem Klick – auch ohne Prüfung (Suche nach der Firma).
  await expect(panel.getByTestId('meta-library-link')).toHaveAttribute('href', /^https:\/\/www\.facebook\.com\/ads\/library\/\?.*country=DE/);
  // Ohne gefundene Seite nur eine Suche – das steht auch so dran.
  await expect(panel.getByTestId('meta-library-link')).toContainText('Werbebibliothek · Suche');
  await panel.getByTestId('panel-unsnooze').click();
  await expect(panel.getByTestId('panel-snoozed')).toHaveCount(0);
  expect((await findLead(page, 'nick', 'Jonas Vogt')).snoozedUntil ?? null).toBeNull();
  expect(errors).toEqual([]);
});

test('Meta-Ads aller Leads nachprüfen: Start, Fortschritt, Ergebnis', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  await openSettingsSection(page, 'meta');
  const section = page.getByTestId('meta-recheck');
  await expect(section).toBeVisible();
  await section.getByTestId('meta-recheck-start').click();
  await expect(section.getByTestId('meta-recheck-status')).toContainText('Leads geprüft', { timeout: 30_000 });
  await expect(section.getByTestId('meta-recheck-status')).toContainText('ohne Anzeigen');
  await expect(section.getByTestId('meta-recheck-start')).toHaveText('Noch einmal prüfen');
  expect(errors).toEqual([]);
});
