import { expect, test, type Page } from '@playwright/test';
import type { SettingGroup } from '../shared/settings';
import type { BackupListResponse } from '../shared/system';
import { E2E_PASSWORD, resetCockpit, signIn, trackErrors, gotoSettings, openSetting, openSettingsSection } from './helpers';

/**
 * „Nie auf die Shell“ (Wunsch des Nutzers 06.10.): LinkedIn einrichten, Verbindungstests, Sicherungen und Updates in
 * der Oberfläche – gegen das echte Mock-Backend (`shared/linkedin.ts`, `shared/settings.ts`, `shared/system.ts`).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

/** Einstellungen öffnen; „System“ = Bereich „Sicherungen und Updates“. */
async function openSettings(page: Page, section: 'Werte' | 'System' = 'Werte') {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  if (section === 'System') await openSettingsSection(page, 'backup');
}

/** Jede Gruppe ist ein eigener Bereich der Seitenleiste – vor dem Arbeiten an einem Feld hineinwechseln. */
const openGroup = (page: Page, group: SettingGroup) => openSettingsSection(page, group);

test('LinkedIn einrichten: Accounts laden und zuordnen, Test-LinkedIn-Account mit Test-Nachricht, Verbindungstests für Treg/Close/Slack', async ({ page }) => {
  const errors = trackErrors(page);
  await openSettings(page);
  const group = page.getByTestId('group-linkedin');
  await openGroup(page, 'linkedin');
  await expect(page.getByTestId('settings-section-title')).toHaveText('Senden über LinkedIn');
  // Die Arbeitszeit steht direkt auf der Seite, die Pause unter „Erweitert“.
  await expect(group.getByTestId('setting-LINKEDIN_WORK_HOURS').locator('input')).toHaveValue('8-19');
  await openSetting(page, 'LINKEDIN_PAUSE_SECONDS');
  await expect(page.getByTestId('settings-section-title')).toHaveText('Erweitert');
  await expect(group.getByTestId('setting-LINKEDIN_PAUSE_SECONDS')).toBeVisible();

  // Test-LinkedIn-Account: Profil prüfen (Name zur Kontrolle), dann Test-Nachricht (Simulation sendet nichts).
  expect((await page.request.delete('/api/linkedin/test-profile')).ok()).toBe(true);
  // Seite neu betreten, damit der (jetzt leere) Test-Account neu geladen wird.
  await page.getByTestId('nav-home').click();
  await gotoSettings(page);
  await openSetting(page, 'UNIPILE_ACCOUNT_NICK');
  const test = group.getByTestId('linkedin-test-message');
  await test.getByTestId('linkedin-test-profile').fill('https://www.linkedin.com/in/kollege');
  await test.getByTestId('linkedin-test-check').click();
  await expect(test.getByTestId('linkedin-test-account')).toContainText('Test-Kontakt');
  await expect(test.getByTestId('linkedin-test-account')).toContainText('Kontakt 1. Grades');
  await test.getByTestId('linkedin-test-send').click();
  await expect(test.getByTestId('linkedin-test-result')).toHaveText('Test – an Test-Kontakt wurde nichts gesendet.');
  await test.getByTestId('linkedin-test-connect').click();
  await expect(test.getByTestId('linkedin-test-result')).toHaveText('Test – an Test-Kontakt wurde keine Anfrage gesendet.');

  // Accounts aus Unipile (Simulation: drei erfundene) – Zuordnung per Klick in den Entwurf.
  const accounts = group.getByTestId('linkedin-accounts');
  await accounts.getByTestId('linkedin-accounts-load').click();
  const list = accounts.getByTestId('linkedin-account-list');
  await expect(list.locator('li')).toHaveCount(3);
  // Firmenseiten (02.11.): von unten nach oben, nie über die Gründer – ein Satz über der Liste.
  await expect(accounts.getByTestId('linkedin-company-order')).toContainText('Firmenseiten von unten nach oben');
  const nickRow = list.locator('li', { hasText: 'Nick (Simulation)' });
  // Aufwärmen (21.10.): nur für Accounts ohne Gründer; Stand erscheint unter dem Namen.
  await expect(nickRow.getByTestId('linkedin-warmup')).toHaveCount(0);
  const scraperRow = list.locator('li', { hasText: 'Scraping-Account (Simulation)' });
  await scraperRow.getByTestId('linkedin-warmup').click();
  await expect(scraperRow.getByTestId('linkedin-warmup')).toHaveAttribute('aria-pressed', 'true');
  await expect(scraperRow.getByTestId('linkedin-warmup-status')).toContainText('wirkt nach dem Speichern');
  await expect(group.getByTestId('setting-UNIPILE_WARMUP_ACCOUNTS').locator('input')).toHaveValue('mock-scraper');
  // Such-Reihenfolge und Grenzen je Account (21.10.): Scraping-Account vorn, Gründer zuletzt; Grenzen speichern sofort.
  await expect(list.locator('li').first()).toContainText('Scraping-Account (Simulation)');
  await expect(scraperRow).toContainText('Suche: zuerst');
  await expect(nickRow).toContainText('Suche: zuletzt (Gründer)');
  await expect(scraperRow.getByTestId('linkedin-limits-toggle')).toContainText('1.000 Treffer · 100 Profile · 17 Anfragen');
  await scraperRow.getByTestId('linkedin-limits-toggle').click();
  await expect(scraperRow.getByTestId('linkedin-limit-invitesPerDay')).toHaveAttribute('placeholder', 'Standard 17');
  await scraperRow.getByTestId('linkedin-limit-invitesPerDay').fill('5');
  await scraperRow.getByTestId('linkedin-limits-save').click();
  await expect(scraperRow.getByTestId('linkedin-limits-result')).toContainText('Gespeichert');
  await expect(scraperRow.getByTestId('linkedin-limits-toggle')).toContainText('5 Anfragen');
  // Zurück auf Standard (gemeinsames Mock-Backend).
  await scraperRow.getByTestId('linkedin-limit-invitesPerDay').fill('');
  await scraperRow.getByTestId('linkedin-limits-save').click();
  await expect(scraperRow.getByTestId('linkedin-limits-toggle')).toContainText('17 Anfragen');
  await expect(nickRow.getByTestId('linkedin-assign-nick')).toHaveAttribute('aria-pressed', 'true');
  // Wechselt der Account zu Johannes, verliert Nick ihn (ein Account gehört nur einem Gründer).
  await nickRow.getByTestId('linkedin-assign-johannes').click();
  await expect(nickRow.getByTestId('linkedin-assign-johannes')).toHaveAttribute('aria-pressed', 'true');
  await expect(nickRow.getByTestId('linkedin-assign-nick')).toHaveAttribute('aria-pressed', 'false');
  await expect(group.getByTestId('setting-UNIPILE_ACCOUNT_NICK').locator('input')).toHaveValue('');
  await expect(group.getByTestId('setting-UNIPILE_ACCOUNT_JOHANNES').locator('input')).toHaveValue('mock-nick');
  // Die IDs von Hand liegen hinter einem Klick.
  await expect(group.getByTestId('setting-UNIPILE_ACCOUNT_NICK')).toBeHidden();
  await group.getByTestId('linkedin-manual-toggle').click();
  await expect(group.getByTestId('setting-UNIPILE_ACCOUNT_NICK')).toBeVisible();
  // Ungespeichert: Die Test-Nachricht wartet aufs Speichern.
  await expect(test.getByTestId('linkedin-test-send')).toBeDisabled();

  // Verbindungstests in den Gruppen Firmendaten und CRM (Simulation ohne Netz).
  await openGroup(page, 'crm');
  await page.getByTestId('group-crm').getByRole('button', { name: 'Close testen' }).click();
  await expect(page.getByTestId('test-close').getByTestId('test-result')).toContainText('Simulation');
  await page.getByTestId('group-crm').getByRole('button', { name: 'Slack-Testnachricht' }).click();
  await expect(page.getByTestId('test-slack').getByTestId('test-result')).toContainText('Simulation');
  expect(errors).toEqual([]);
});

test('Pause zu kleiner als 3 Sekunden: das Backend lehnt ab, Meldung am Feld', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 400\b/.test(text));
  await openSettings(page);
  await openSetting(page, 'LINKEDIN_PAUSE_SECONDS');
  const field = page.getByTestId('setting-LINKEDIN_PAUSE_SECONDS');
  await field.locator('input').fill('1-2');
  await page.getByRole('button', { name: /^Speichern/ }).click();
  await expect(field).toContainText(/3/);
  expect(errors).toEqual([]);
});


test('Software-Update: ein Klick auf der ersten Ebene, kein Passwort, danach aktuell (Simulation)', async ({ page }) => {
  const errors = trackErrors(page);
  await openSettings(page);
  // Das Mock-Backend merkt sich das Update bis zum Neustart – nur beim ersten Lauf gibt es etwas einzuspielen.
  const banner = page.getByTestId('settings-update-banner');
  const before = (await (await page.request.get('/api/system/update')).json()) as { behind: number };
  if (before.behind > 0) {
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('settings-nav-badge-update')).toHaveText('Neu');
    await openSettingsSection(page, 'update');
    const update = page.getByTestId('system-update');
    await expect(update.getByTestId('update-available')).toHaveText('Neue Version da.');
    // Nur die Version als Nummer – kein Kleingedrucktes.
    await expect(update.getByTestId('update-current')).toHaveText('a1b2c3d');
    await expect(update).not.toContainText('Sicherungen und Updates in der Oberfläche');
    // Der Schalter für die Nacht gilt sofort, ohne Speichern.
    const auto = page.getByTestId('quick-UPDATE_AUTO').getByRole('switch');
    await expect(auto).toHaveAttribute('aria-checked', 'false');
    await auto.click();
    await expect(auto).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('settings-save')).toHaveCount(0);
    await expect.poll(async () => {
      const settings = (await (await page.request.get('/api/settings')).json()) as { settings: { key: string; value?: unknown }[] };
      return settings.settings.find((entry) => entry.key === 'UPDATE_AUTO')?.value;
    }).toBe(true);
    await auto.click();
    await expect(auto).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('settings-back').click();
    // Ein Klick – ohne Passwort-Dialog.
    await page.getByTestId('settings-update-start').click();
    await expect(page.getByTestId('password-dialog')).toHaveCount(0);
    await expect(page.getByTestId('settings-update-start')).toHaveText('Update läuft …');
    // Nach dem (simulierten) Update lädt die Seite neu und zeigt die neue Version.
    await page.waitForEvent('load', { timeout: 20_000 });
    await gotoSettings(page);
  }
  await expect(page.getByTestId('settings-update-banner')).toHaveCount(0);
  await openSettingsSection(page, 'update');
  await expect(page.getByTestId('update-current-state')).toHaveText('Du hast die neueste Version.');
  await expect(page.getByTestId('update-current')).toHaveText('c0ffee1');
  expect(errors).toEqual([]);
});

test('System: Sicherung anlegen, herunterladen und wiederherstellen (Simulation)', async ({ page }) => {
  const errors = trackErrors(page);
  await openSettings(page, 'System');
  const backups = page.getByTestId('system-backups');
  await expect(page.getByTestId('quick-BACKUP_HOUR_UTC').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  const count = async () => ((await (await page.request.get('/api/system/backups')).json()) as BackupListResponse).backups.length;
  const before = await count();
  await backups.getByTestId('backup-now').click();
  await expect(backups.getByTestId('backup-state')).toContainText('Zuletzt gesichert:');
  expect(await count()).toBe(before + 1);
  await expect(backups.getByTestId('backup-row')).toHaveCount(Math.min(before + 1, 3));
  const newest = backups.getByTestId('backup-row').first();
  await expect(backups.getByTestId('backup-state')).toContainText('Zuletzt gesichert:');

  // Herunterladen: Datei mit Passwort.
  await newest.getByRole('button', { name: 'Herunterladen' }).click();
  const dialog = page.getByTestId('password-dialog');
  await dialog.locator('input').fill(E2E_PASSWORD);
  const download = page.waitForEvent('download');
  await dialog.getByTestId('password-dialog-confirm').click();
  expect((await download).suggestedFilename()).toMatch(/^manuell-.*\.db$/);

  // Wiederherstellen: in der Simulation nur ein Hinweis, nichts wird ersetzt.
  await newest.getByRole('button', { name: 'Wiederherstellen' }).click();
  await expect(dialog).toContainText('Der jetzige Stand wird vorher gesichert');
  await dialog.locator('input').fill(E2E_PASSWORD);
  await dialog.getByTestId('password-dialog-confirm').click();
  await expect(page.getByTestId('system-backups').getByTestId('system-notice')).toContainText('Simulation');

  // „Jede Nacht sichern“ ausschalten braucht Passwort und Rückfrage – Abbrechen lässt den Schalter, wie er war.
  const nightly = page.getByTestId('quick-BACKUP_HOUR_UTC').getByRole('switch');
  await nightly.click();
  await expect(page.getByTestId('settings-dialog')).toContainText('nicht mehr täglich gesichert');
  await page.getByTestId('settings-dialog').getByRole('button', { name: 'Abbrechen' }).click();
  await expect(nightly).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('settings-save')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('System passt auf ein Handy (390 px) ohne seitliches Scrollen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page, 'System');
  await expect(page.getByTestId('system-backups')).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth - window.innerWidth')).toBeLessThanOrEqual(0);
});

test('Such-Account der Lead-Suche: Accounts laden, wählen, speichern – „Automatisch“ zeigt, wer gerade sucht', async ({ page }) => {
  const errors = trackErrors(page);
  await openSettings(page);
  await openSetting(page, 'UNIPILE_ACCOUNT_ID');
  const group = page.getByTestId('group-unipile');
  const picker = group.getByTestId('search-account');
  await picker.getByTestId('search-account-load').click();
  await expect(picker.getByRole('radio')).toHaveCount(4);
  await expect(picker.getByTestId('search-account-auto')).toHaveAttribute('aria-checked', 'true');
  await expect(picker.getByTestId('search-account-auto')).toContainText('Gerade: Nick (Simulation)');

  await picker.getByTestId('search-account-mock-johannes').click();
  await expect(picker.getByTestId('search-account-mock-johannes')).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByTestId('setting-UNIPILE_ACCOUNT_ID').locator('input')).toHaveValue('mock-johannes');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  await picker.getByTestId('search-account-load').click();
  await expect(picker.getByTestId('search-account-mock-johannes')).toHaveAttribute('aria-checked', 'true');
  await expect(picker.getByTestId('search-account-auto')).toContainText('Erster verbundener LinkedIn-Account');

  // Zurück auf automatisch (gemeinsames Mock-Backend).
  await picker.getByTestId('search-account-auto').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-message')).toContainText('Gespeichert');
  expect(errors).toEqual([]);
});

test('Nur eingetragene Anfragen nachsenden: Liste, zurück auf „Neu“, Lead wieder im Tagesstapel', async ({ page }) => {
  const errors = trackErrors(page);
  await openSettings(page);
  // Eine Anfrage nur eingetragen (wie „von Hand“), nicht über das Cockpit gesendet.
  const list = (await (await page.request.get('/api/leads?owner=nick&stage=new&limit=1')).json()) as { leads: { id: string; person: { lastName: string } }[] };
  const lead = list.leads[0];
  expect((await page.request.post(`/api/leads/${lead.id}/events`, { data: { action: 'invite_sent' } })).ok()).toBe(true);
  // Die Liste lädt beim Öffnen der Einstellungen – „Neu laden“ holt den Stand danach.

  await openGroup(page, 'linkedin');
  await page.getByTestId('settings-row-linkedin.unsent').click();
  const block = page.getByTestId('group-linkedin').getByTestId('unsent-invites');
  await block.getByTestId('unsent-invites-reload').click();
  await expect(block.getByTestId('unsent-invites-list')).toContainText(lead.person.lastName);
  await block.getByTestId('unsent-invites-requeue').click();
  await expect(block.getByTestId('unsent-invites-message')).toContainText('wieder „Neu“');
  await expect(block.getByTestId('unsent-invites-empty')).toBeVisible();
  const after = (await (await page.request.get(`/api/leads/${lead.id}`)).json()) as { lead: { stage: string } };
  expect(after.lead.stage).toBe('new');
  expect(errors).toEqual([]);
});

test('Vorlagen: Notiz zur Vernetzungsanfrage ausgeschaltet → Kategorie ausgegraut mit Hinweis', async ({ page }) => {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    const settings = body.settings.map((setting: { key: string }) => (setting.key === 'INVITE_NOTE' ? { ...setting, value: 'off' } : setting));
    return route.fulfill({ response, json: { ...body, settings } });
  });
  await openSettings(page);
  await openSettingsSection(page, 'templates');
  await expect(page.getByTestId('templates-invite-unused')).toContainText('nicht verwendet');
  await expect(page.getByTestId('templates-invite')).toHaveAttribute('data-unused', 'true');
  await expect(page.getByTestId('templates-first_greenfield')).not.toHaveAttribute('data-unused', 'true');
});

test('Chats nachträglich abgleichen: unter Einstellungen → LinkedIn, erst nach Rückfrage, zweiter Lauf findet nichts Neues', async ({ page }) => {
  const errors = trackErrors(page);
  await openSettings(page);
  await openGroup(page, 'linkedin');
  await openSetting(page, 'UNIPILE_ACCOUNT_NICK');
  const sync = page.getByTestId('chat-sync');
  // Nicht mehr in den Chats.
  await expect(sync).toBeVisible();

  await sync.getByTestId('chat-sync-start').click();
  await expect(sync.getByTestId('chat-sync-confirm')).toContainText('Wirklich starten?');
  await sync.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(sync.getByTestId('chat-sync-result')).toHaveCount(0);

  await sync.getByTestId('chat-sync-start').click();
  await sync.getByTestId('chat-sync-confirm-start').click();
  await expect(sync.getByTestId('chat-sync-result')).toContainText(/Nachrichten? in (einem Chat|\d+ Chats) übernommen\./);
  await sync.getByTestId('chat-sync-start').click();
  await sync.getByTestId('chat-sync-confirm-start').click();
  await expect(sync.getByTestId('chat-sync-result')).toContainText('Nichts Neues');

  await page.getByTestId('nav-chats').click();
  await expect(page.getByTestId('chat-item').first()).toBeVisible();
  await expect(page.getByTestId('chat-sync-start')).toHaveCount(0);
  await expect(page.getByTestId('chat-list')).toContainText('passt nächste Woche ein Call?');
  expect(errors).toEqual([]);
});
