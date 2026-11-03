import { expect, test, type Page } from '@playwright/test';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * UX-Leitfaden (Wunsch des Nutzers 25.10.): weniger Auswahl auf einmal, zeigen, dass gearbeitet wird, Fortschritt,
 * Höhepunkt und Ende, Hervorheben nur des Wichtigen. Gegen das Mock-Backend.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();

test('Fünf Hauptansichten: KI steht im Dashboard, KI-Kosten und Lernen einen Klick entfernt', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await expect(page.getByTestId('nav-assistant')).toHaveCount(0);
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('learning-section')).toHaveCount(0);
  await page.getByTestId('dashboard-more').click();
  await expect(page.getByTestId('learning-section')).toBeVisible();

  await page.getByTestId('dashboard-ask').click();
  await expect(page.getByTestId('assistant-view')).toBeVisible();
  // Solange die KI offen ist, bleibt „Dashboard“ markiert; zurück über den Link oben.
  await expect(page.getByTestId('top-nav').getByRole('button', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('assistant-back').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Lead-Suche: Start-Dialog erst als Satz, im Lauf steht in Worten, was gerade passiert', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-search').click();
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('sheet-run-plan')).toContainText('Die KI liest davon höchstens');
  await expect(page.getByTestId('sheet-settings')).toHaveCount(0);
  await page.getByTestId('start-search-confirm').click();
  await expect(page.getByTestId('run-now-text')).toHaveText(/\S/);
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('run-now')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Fokus: Übergabe bekommt ihren Moment, Beenden mittendrin eine Zwischenbilanz, Fortschritt mit Balken', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-focus').click();
  const card = currentCard(page);
  await expect(card).toHaveAttribute('data-card-type', 'reply');
  await expect(card.getByRole('button', { name: 'Kein Interesse' })).toBeEnabled();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('an Close übergeben');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('win-moment')).toContainText('ist übergeben.');
  // Blockiert nichts und verschwindet von selbst.
  await expect(page.getByTestId('win-moment')).toHaveCount(0, { timeout: 4000 });
  await expect(page.getByTestId('progress')).toHaveText('1 von 14 erledigt');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('notice')).toContainText('Gute Runde');
  await expect(page.getByTestId('notice')).toContainText('noch 13 offen');
  await expect(page.getByTestId('home-progress')).toBeVisible();
  await expect(page.getByTestId('start-focus')).toHaveText(/Weitermachen/);
  expect(errors).toEqual([]);
});

test('KI-Vorschlag zeigt, woran die KI gerade arbeitet', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-followup').click();
  const card = currentCard(page);
  await card.getByTestId('suggest-button').click();
  await expect(card.getByTestId('suggest-progress')).toContainText('Liest den Verlauf');
  await expect(card.getByTestId('suggest-note')).toBeVisible({ timeout: 10_000 });
  await expect(card.getByTestId('suggest-progress')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Chats: Blau nur für das, was auf dich wartet – oben als eigene Gruppe', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-chats').click();
  const yours = page.getByTestId('chat-group-yours');
  await expect(yours).toContainText('Wartet auf dich');
  // Alles in der Gruppe läuft über den eigenen Account.
  const items = page.getByTestId('chat-item');
  const count = Number((await yours.textContent())!.match(/\d+/)![0]);
  for (let index = 0; index < count; index++) await expect(items.nth(index)).toContainText('über deinen Account');
  await expect(page.getByTestId('chat-group-rest')).toBeVisible();
  expect(errors).toEqual([]);
});
