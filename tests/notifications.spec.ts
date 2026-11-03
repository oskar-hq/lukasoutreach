import { expect, test } from '@playwright/test';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Neuigkeiten an der Glocke (Vertrag shared/notifications.ts) gegen das Mock-Backend. Der Demo-Reset legt zwei
 * Beispiele an: automatische Suche von Nick abgebrochen (Fehler) und Sicherung fehlgeschlagen (Warnung).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

test('Glocke: Punkt bei Neuem, Liste mit Beispielen, Klick führt in die Einstellungen, danach gesehen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  const dot = page.getByTestId('notifications-dot');
  await expect(dot).toHaveAttribute('data-tone', 'bad');
  await expect(page.getByTestId('notifications-bell')).toHaveAttribute('aria-label', 'Neuigkeiten · 2 neu');

  await page.getByTestId('notifications-bell').click();
  const items = page.getByTestId('notification-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Automatische Lead-Suche für Nick abgebrochen');
  await expect(items.nth(0)).toContainText('Neu');
  await expect(items.nth(1)).toContainText('Sicherung fehlgeschlagen');
  // Beim Öffnen gilt alles als gesehen – der Punkt ist weg, die Liste bleibt markiert.
  await expect(dot).toHaveCount(0);

  // Esc schließt und gibt den Fokus an die Glocke zurück.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('notifications-panel')).toHaveCount(0);
  await expect(page.getByTestId('notifications-bell')).toBeFocused();

  // Klick auf den Suchfehler → Einstellungen, Bereich LinkedIn (Unipile).
  await page.getByTestId('notifications-bell').click();
  await items.nth(0).getByRole('button').click();
  await expect(page.getByTestId('settings-section-title')).toHaveText('LinkedIn (Unipile)');

  // Nach dem Neuladen bleibt es gesehen.
  await page.reload();
  await expect(page.getByTestId('notifications-bell')).toBeVisible();
  await expect(dot).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Glocke für Mitarbeiter: sieht Fehler, sagt den Gründern Bescheid, keine Sprünge in die Einstellungen', async ({ page }) => {
  await page.goto('/?ping=off');
  await signIn(page, 'mitarbeiter');
  await page.getByTestId('notifications-bell').click();
  const items = page.getByTestId('notification-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByTestId('notification-tell')).toHaveText('Sag Nick Bescheid – beheben können das nur Gründer.');
  await expect(items.nth(1).getByTestId('notification-tell')).toHaveText('Sag Nick und Johannes Bescheid – beheben können das nur Gründer.');
  await expect(items.getByRole('button')).toHaveCount(0);
});

test('Glocke auf dem Handy (390 px): Liste passt ohne seitliches Scrollen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('notifications-bell').click();
  const panel = page.getByTestId('notifications-panel');
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 1);
  expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(390);
});
