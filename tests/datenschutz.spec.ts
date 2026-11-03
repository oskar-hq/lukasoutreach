import { expect, test, type Page } from '@playwright/test';
import type { BackupListResponse } from '../shared/system';
import { E2E_PASSWORD, findLead, gotoSettings, openSettingsSection, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Datenschutz und Betrieb (08.10.) gegen das Mock-Backend: Auskunft und endgültiges Löschen im Lead-Panel
 * (`GET /api/leads/:id/export`, `DELETE /api/leads/:id`), freier Speicherplatz und „Schlüssel für Geheimnisse
 * anzeigen“ unter Einstellungen → Sicherungen und Updates (`shared/system.ts`).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

async function openFirstLead(page: Page, account: 'nick' | 'mitarbeiter') {
  await page.goto('/?ping=off');
  await signIn(page, account);
  await page.getByTestId('start-lead').click();
  const name = (await page.locator('[data-testid=stack-card]').last().getByTestId('lead-name').textContent())!;
  await page.getByTitle('Lead-Historie öffnen').click();
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText(name);
  return { panel, name };
}

test('Lead-Panel: Daten exportieren (JSON) und Lead nach Rückfrage endgültig löschen', async ({ page }) => {
  const errors = trackErrors(page);
  const { panel, name } = await openFirstLead(page, 'nick');
  const lead = await findLead(page, 'nick', name);
  const actions = panel;

  // Auskunft: Datei mit allen Daten (unter „Mehr“)
  await panel.getByTestId('footer-more').click();
  const download = page.waitForEvent('download');
  await actions.getByTestId('lead-export').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(new RegExp(`^lead-${lead.id}-\\d{4}-\\d{2}-\\d{2}\\.json$`));

  // Löschen: erst Rückfrage, Abbrechen lässt alles, wie es ist
  await actions.getByTestId('lead-delete').click();
  const confirm = actions.getByTestId('lead-delete-confirm');
  await expect(panel.getByTestId('panel-sheet')).toContainText(`${name} endgültig löschen?`);
  await expect(confirm).toContainText('nicht rückgängig');
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(actions.getByTestId('lead-delete-confirm')).toHaveCount(0);
  expect((await page.request.get(`/api/leads/${lead.id}`)).status()).toBe(200);

  await panel.getByTestId('footer-more').click();
  await actions.getByTestId('lead-delete').click();
  await actions.getByTestId('lead-delete-confirm-button').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await page.request.get(`/api/leads/${lead.id}`)).status()).toBe(404);
  await expect(findLead(page, 'nick', name)).rejects.toThrow(/nicht gefunden/);
  expect(errors).toEqual([]);
});

test('Lead-Panel: Mitarbeiter sehen weder Export noch Löschen, das Backend sperrt beides', async ({ page }) => {
  const { panel } = await openFirstLead(page, 'mitarbeiter');
  await panel.getByTestId('footer-more').click();
  await expect(panel.getByTestId('action-owner')).toBeVisible();
  await expect(panel.getByTestId('lead-export')).toHaveCount(0);
  await expect(panel.getByTestId('lead-delete')).toHaveCount(0);
  const leads = (await (await page.request.get('/api/leads?owner=nick&limit=1')).json()) as { leads: { id: string }[] };
  expect((await page.request.get(`/api/leads/${leads.leads[0].id}/export`)).status()).toBe(403);
  expect((await page.request.delete(`/api/leads/${leads.leads[0].id}`)).status()).toBe(403);
});

test('System: Speicherplatz nur, wenn er knapp ist; Schlüssel für Geheimnisse (mit Passwort)', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 403\b/.test(text));
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  await openSettingsSection(page, 'backup');

  const list = (await (await page.request.get('/api/system/backups')).json()) as BackupListResponse;
  expect(list.disk).toBeTruthy();
  // Die einfache Seite nennt den Speicher nur, wenn er knapp wird.
  if (list.disk!.low) await expect(page.getByTestId('backup-disk')).toContainText('Wenig Platz auf dem Server');
  else await expect(page.getByTestId('backup-disk')).toHaveCount(0);

  const card = page.getByTestId('system-key');
  await card.getByTestId('settings-key-show').click();
  const dialog = page.getByTestId('password-dialog');
  await expect(dialog).toContainText('alle gespeicherten API-Schlüssel');
  await dialog.locator('input').fill('falsch');
  await dialog.getByTestId('password-dialog-confirm').click();
  await expect(dialog.getByTestId('password-dialog-error')).toHaveText('Das Passwort stimmt nicht.');
  await dialog.locator('input').fill(E2E_PASSWORD);
  await dialog.getByTestId('password-dialog-confirm').click();
  await expect(dialog).toHaveCount(0);
  const result = card.getByTestId('settings-key-result');
  await expect(result).toBeVisible();
  // Ohne gespeichertes Geheimnis gibt es noch keinen Schlüssel; mit Datei steht er zum Kopieren da.
  await expect(result).toContainText(/Passwort-Manager|noch keinen Schlüssel|SETTINGS_KEY/);
  await card.getByTestId('settings-key-hide').click();
  await expect(card.getByTestId('settings-key-result')).toHaveCount(0);
  expect(errors).toEqual([]);
});
