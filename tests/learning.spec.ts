import { expect, test, type Page } from '@playwright/test';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Lernen aus Lead-Qualität (Wunsch des Nutzers 13.10., `shared/learning.ts`): „Passt“ / „Passt nicht“ im Lead-Panel
 * (`PATCH /api/leads/:id` → `feedback`), Abschnitt „Lernen“ im Dashboard (`GET /api/learning`). Termine und Übergaben
 * der Demo-Leads zählen automatisch als „passt“.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

async function openFirstNewLead(page: Page) {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(page.locator('[data-testid=stack-card]').last().getByTestId('lead-name')).toHaveText('Henrik Saalfeld');
  await page.getByTitle('Lead-Historie öffnen').click();
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText('Henrik Saalfeld');
  return panel;
}

test('Lead-Panel: „Passt nicht“ mit Grund, zurücknehmen, „Passt“ – Dashboard zeigt, was gelernt wurde', async ({ page }) => {
  const errors = trackErrors(page);
  const panel = await openFirstNewLead(page);
  const box = panel.getByTestId('lead-feedback');
  await expect(box.getByTestId('lead-feedback-good')).toHaveAttribute('aria-checked', 'false');

  // „Passt nicht“ → Gründe erscheinen, ein Klick wählt einen.
  await box.getByTestId('lead-feedback-bad').click();
  await expect(box.getByTestId('lead-feedback-bad')).toHaveAttribute('aria-checked', 'true');
  await expect(panel).toContainText('Lead-Qualität: passt nicht');
  await box.getByTestId('lead-feedback-reason-makler').click();
  await expect(box.getByTestId('lead-feedback-reason-makler')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('Lead-Qualität: passt nicht · Makler');
  await expect(box).toContainText('als Beispiel mit');

  // Nochmal „Passt nicht“ nimmt es zurück.
  await box.getByTestId('lead-feedback-bad').click();
  await expect(box.getByTestId('lead-feedback-bad')).toHaveAttribute('aria-checked', 'false');
  await expect(box.getByTestId('lead-feedback-reasons')).toHaveCount(0);
  await expect(panel).toContainText('Rückmeldung zur Lead-Qualität zurückgenommen');

  // Wieder „Passt nicht · Makler“ für das Dashboard.
  await box.getByTestId('lead-feedback-bad').click();
  await box.getByTestId('lead-feedback-reason-makler').click();
  await expect(box.getByTestId('lead-feedback-reason-makler')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Aus dem Tagesstapel zurück, dann ins Dashboard.
  await page.getByRole('button', { name: /Beenden/ }).click();
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('dashboard-more').click();
  const section = page.getByTestId('learning-section');
  await expect(section).toBeVisible();
  await expect(section.getByTestId('learning-bad')).toHaveText('1');
  // Demo: Termine und Übergaben zählen automatisch als „passt“.
  await expect(section.getByTestId('learning-good')).not.toHaveText('0');
  await expect(section.getByTestId('learning-reasons')).toContainText('Makler (1)');
  await expect(section.getByTestId('learning-examples')).not.toHaveText('0');
  expect(errors).toEqual([]);
});

test('Automatisch: Termin eintragen macht den Lead zu „passt“ – überschreibbar mit „Passt nicht“', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-leads').click();
  await page.getByTestId('leads-board').getByTestId('column-replied').getByText('Ralf Ostermann').click();
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText('Ralf Ostermann');
  const actions = panel;
  await actions.getByTestId('action-form-meeting').click();
  await actions.getByRole('button', { name: 'Termin eintragen' }).click();
  const box = panel.getByTestId('lead-feedback');
  await expect(box.getByTestId('lead-feedback-auto')).toHaveText('automatisch · Termin vereinbart');
  await expect(box.getByTestId('lead-feedback-good')).toHaveAttribute('aria-checked', 'true');

  // Von Hand geht vor.
  await box.getByTestId('lead-feedback-bad').click();
  await expect(box.getByTestId('lead-feedback-bad')).toHaveAttribute('aria-checked', 'true');
  await expect(box.getByTestId('lead-feedback-auto')).toHaveCount(0);
  await expect(box.getByTestId('lead-feedback-reasons')).toBeVisible();
  expect(errors).toEqual([]);
});
