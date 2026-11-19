import { expect, test } from '@playwright/test';
import type { FeedbackListResponse } from '../shared/feedback';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Feedback vom Kunden (09.11., `shared/feedback.ts`): von überall in Sekunden – Knopf oben oder ⌥F, ein Textfeld,
 * Senden. Bildschirmfoto, Ansicht und letzte Schritte kommen von selbst mit; die eigenen Meldungen stehen darunter.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

test('Knopf oben: schreiben, senden – Zusammenhang und Bildschirmfoto kommen von selbst mit', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-leads').click();
  await page.getByTestId('nav-feedback').click();
  const dialog = page.getByTestId('feedback-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('feedback-text')).toBeFocused();
  // Bildschirmfoto der Seite dahinter erscheint von selbst (abwählbar).
  await expect(dialog.getByTestId('feedback-remove-screenshot')).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId('feedback-send')).toBeDisabled();
  await dialog.getByTestId('feedback-text').fill('In der Tabelle fehlt die Spalte „Firma“');
  await dialog.getByTestId('feedback-kind-wish').click();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('feedback-sent')).toContainText('Danke – ist angekommen.');
  await expect(page.getByTestId('feedback-sent')).toContainText('Meldung #1');
  await page.getByTestId('feedback-done').click();
  await expect(dialog).toHaveCount(0);

  const list = (await (await page.request.get('/api/feedback?mine=1')).json()) as FeedbackListResponse;
  expect(list.items).toHaveLength(1);
  expect(list.items[0].kind).toBe('wish');
  expect(list.items[0].imageCount).toBe(1);
  expect(list.items[0].context?.view).toBe('leads');
  expect(list.items[0].context?.trail?.some((step) => step.includes('click nav-leads'))).toBe(true);
  expect(list.items[0].context?.device?.width).toBe(1440);

  // ⌥F öffnet überall – die eigene Meldung steht mit Stand darunter.
  await page.keyboard.press('Alt+KeyF');
  await expect(page.getByTestId('feedback-mine')).toContainText('#1 · In der Tabelle fehlt die Spalte');
  await expect(page.getByTestId('feedback-mine')).toContainText('Eingegangen');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Handy (390 px): Knopf oben, eigenes Bild, ohne Bildschirmfoto, keine seitliche Scrollleiste', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-feedback').click();
  const dialog = page.getByTestId('feedback-dialog');
  await expect(dialog.getByTestId('feedback-remove-screenshot')).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId('feedback-remove-screenshot').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByTestId('feedback-remove-image')).toBeVisible();
  await dialog.getByTestId('feedback-text').fill('Senden klappt am Handy nicht');
  expect(await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth')).toBe(0);
  await dialog.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-sent')).toBeVisible();
  const list = (await (await page.request.get('/api/feedback?mine=1')).json()) as FeedbackListResponse;
  expect(list.items[0].imageCount).toBe(1);
  expect(list.items[0].context?.device?.width).toBe(390);
});
