import { expect, test, type Page } from '@playwright/test';
import { findLead, resetCockpit, signIn, trackErrors } from './helpers';

/** Leads-Ansicht gegen das Mock-Backend (`GET /api/leads`): Board nach Stufe, Tabelle, Suche, Zuständig. */
test.beforeEach(async ({ request }) => resetCockpit(request));

async function openLeads(page: Page) {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-leads').click();
  await expect(page.getByTestId('leads-view')).toBeVisible();
}

test('Leads: Board nach Stufe, Tabelle mit Suche, Panel per Klick', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page);

  const board = page.getByTestId('leads-board');
  await expect(board.getByTestId('column-replied')).toContainText('Ralf Ostermann');
  await expect(board.getByTestId('column-new')).toContainText('Henrik Saalfeld');
  // Standard „Alle“ (01.11.): auch die Leads von Johannes
  await expect(page.getByRole('tab', { name: 'Alle' })).toHaveAttribute('aria-selected', 'true');
  await expect(board).toContainText('Anja Reimers');
  // „Meine“: nur Nicks Leads
  await page.getByRole('tab', { name: 'Meine' }).click();
  await expect(board).not.toContainText('Anja Reimers');

  await page.getByTestId('leads-view-options').click();
  await page.getByRole('menuitemradio', { name: 'Tabelle' }).click();
  await expect(page.getByTestId('leads-view-options')).toBeFocused();
  const table = page.getByTestId('leads-table');
  await expect(table).toBeVisible();
  await page.getByTestId('leads-search').fill('Ostermann');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await table.getByRole('button', { name: 'Ralf Ostermann' }).click();
  await expect(page.getByRole('dialog')).toContainText('Ralf Ostermann');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Alle Gründer
  await page.getByTestId('leads-search').fill('');
  await page.getByRole('tab', { name: 'Alle' }).click();
  await expect(table).toContainText('Anja Reimers');
  await expect(table).toContainText('Johannes');

  // Die Ansicht merkt sich Tabelle
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-leads').click();
  await expect(page.getByTestId('leads-table')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Leads passen auf ein Handy (390 px) ohne seitliches Scrollen der Seite', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLeads(page);
  await expect(page.getByTestId('column-new')).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(390);
});

test('Leads: Ansicht-Menü schließt mit Esc, Sortierung nach Score', async ({ page }) => {
  await openLeads(page);
  await expect(page.getByTestId('leads-count')).toHaveText(/^\d+/);
  const trigger = page.getByTestId('leads-view-options');
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Ansicht' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('menuitemradio', { name: 'Score' }).click();
  await expect(trigger).toContainText('Board · Score');
});

test('Eigene Spalte im Board: anlegen, Lead hineinziehen, im Panel zurück, löschen', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page);
  // Nur Nicks Leads: schmaleres Board, die eigene Spalte bleibt fürs Ziehen erreichbar.
  await page.getByRole('tab', { name: 'Meine' }).click();
  const name = `Meeting Close ${Date.now() % 100000}`;
  await page.getByTestId('board-column-new').click();
  await page.getByTestId('board-column-name').fill(name);
  await page.getByTestId('board-column-add').click();
  const column = page.getByTestId('custom-column').filter({ hasText: name });
  await expect(column).toBeVisible();

  // Ziehen: Lead aus „Antwort“ in die eigene Spalte – die Stufe bleibt.
  const lead = page.getByTestId('column-replied').getByTestId('board-card').filter({ hasText: 'Ralf Ostermann' });
  await lead.dragTo(column);
  await expect(column).toContainText('Ralf Ostermann');
  await expect(column).toContainText('Antwort');
  await expect(page.getByTestId('column-replied')).not.toContainText('Ralf Ostermann');

  // Zurück über das Lead-Panel (ohne Ziehen).
  await column.getByTestId('board-card').filter({ hasText: 'Ralf Ostermann' }).click();
  await page.getByTestId('board-column-select').selectOption('');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('column-replied')).toContainText('Ralf Ostermann');

  // Löschen
  page.once('dialog', (dialog) => void dialog.accept());
  await column.getByRole('button', { name: `Spalte „${name}“ löschen` }).click();
  await expect(page.getByTestId('custom-column').filter({ hasText: name })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Board frei anordnen: eigene Spalte zwischen Antwort und Termin schieben, Stufe umbenennen – bleibt nach Neuladen', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page);
  const name = `Wiedervorlage ${Date.now() % 100000}`;
  await page.getByTestId('board-column-new').click();
  await page.getByTestId('board-column-name').fill(name);
  await page.getByTestId('board-column-add').click();
  const column = page.getByTestId('custom-column').filter({ hasText: name });
  await expect(column).toBeVisible();
  // Eigene Spalten sehen aus wie die Stufen (fett, nicht blau).
  await expect(column.getByTestId('board-column-title')).toHaveCSS('font-weight', '700');

  const titles = () => page.getByTestId('board-column-title').allTextContents();
  // So oft nach links, bis sie direkt hinter „Antwort“ steht.
  for (let i = 0; i < 10; i++) {
    const list = await titles();
    if (list.indexOf(name) === list.indexOf('Antwort') + 1) break;
    await column.getByTestId('board-column-left').click();
    await expect.poll(async () => (await titles()).indexOf(name)).toBe(list.indexOf(name) - 1);
  }
  let list = await titles();
  expect(list.slice(list.indexOf('Antwort'), list.indexOf('Antwort') + 3)).toEqual(['Antwort', name, 'Termin']);

  // Stufe umbenennen – nur der Name im Board, die Funktion bleibt.
  await page.getByTestId('column-replied').getByTestId('board-column-edit').first().click();
  await page.getByTestId('board-column-rename').fill('Im Gespräch');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('column-replied').getByTestId('board-column-title')).toHaveText('Im Gespräch');

  await page.reload();
  await page.getByTestId('nav-leads').click();
  await expect(page.getByTestId('column-replied').getByTestId('board-column-title')).toHaveText('Im Gespräch');
  list = await titles();
  expect(list.slice(list.indexOf('Im Gespräch'), list.indexOf('Im Gespräch') + 3)).toEqual(['Im Gespräch', name, 'Termin']);

  // Zurück: leerer Name = Standardname, Spalte löschen.
  await page.getByTestId('column-replied').getByTestId('board-column-edit').first().click();
  await page.getByTestId('board-column-rename').fill('');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('column-replied').getByTestId('board-column-title')).toHaveText('Antwort');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('custom-column').filter({ hasText: name }).getByRole('button', { name: `Spalte „${name}“ löschen` }).click();
  await expect(page.getByTestId('custom-column').filter({ hasText: name })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Verloren = archiviert: weg aus dem Board (auch aus eigenen Spalten), im Ordner „Verloren“ wieder öffnen; Antwort holt zurück', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page);
  // Nur Nicks Leads: schmaleres Board, die eigene Spalte bleibt fürs Ziehen erreichbar.
  await page.getByRole('tab', { name: 'Meine' }).click();
  const name = `Ablage ${Date.now() % 100000}`;
  await page.getByTestId('board-column-new').click();
  await page.getByTestId('board-column-name').fill(name);
  await page.getByTestId('board-column-add').click();
  const column = page.getByTestId('custom-column').filter({ hasText: name });
  await page.getByTestId('column-replied').getByTestId('board-card').filter({ hasText: 'Ralf Ostermann' }).dragTo(column);
  await expect(column).toContainText('Ralf Ostermann');
  const lostBefore = Number((await page.getByTestId('lost-open').textContent())?.match(/\d+/)?.[0] ?? 0);

  // Verloren (wie aus dem Lead-Panel) – archiviert: nicht mehr im Board, Zähler im Ordner +1.
  const lead = await findLead(page, 'nick', 'Ralf Ostermann');
  expect((await page.request.post(`/api/leads/${lead.id}/events`, { data: { action: 'lost' } })).status()).toBe(200);
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-leads').click();
  await expect(page.getByTestId('lost-open')).toContainText(`${lostBefore + 1} archiviert`);
  await expect(page.getByTestId('leads-board')).not.toContainText('Ralf Ostermann');

  // Ordner: suchen, wieder öffnen → zurück im Board.
  await page.getByTestId('lost-open').click();
  const dialog = page.getByTestId('lost-dialog');
  await dialog.getByTestId('lost-search').fill('Ostermann');
  await expect(dialog.getByTestId('lost-item')).toHaveCount(1);
  await dialog.getByTestId('lost-reopen').click();
  await expect(dialog.getByTestId('lost-item')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await expect(page.getByTestId('leads-board')).toContainText('Ralf Ostermann');

  // Nochmal verloren – eine neue Nachricht von ihm holt ihn von selbst zurück (Stufe Antwort).
  expect((await page.request.post(`/api/leads/${lead.id}/events`, { data: { action: 'lost' } })).status()).toBe(200);
  expect((await page.request.post(`/api/leads/${lead.id}/events`, { data: { action: 'message_received', text: 'Doch noch Interesse' } })).status()).toBe(200);
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-leads').click();
  await expect(page.getByTestId('leads-board')).toContainText('Ralf Ostermann');
  expect((await findLead(page, 'nick', 'Ralf Ostermann')).stage).toBe('replied');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('custom-column').filter({ hasText: name }).getByRole('button', { name: `Spalte „${name}“ löschen` }).click();
  await expect(page.getByTestId('custom-column').filter({ hasText: name })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Eigene Spalten: Mitarbeiter sieht sie, kann sie aber nicht anlegen, umbenennen oder löschen', async ({ page, browser }) => {
  const errors = trackErrors(page);
  await openLeads(page);
  const name = `Nur ansehen ${Date.now() % 100000}`;
  await page.getByTestId('board-column-new').click();
  await page.getByTestId('board-column-name').fill(name);
  await page.getByTestId('board-column-add').click();
  await expect(page.getByTestId('custom-column').filter({ hasText: name })).toBeVisible();

  const context = await browser.newContext();
  const anna = await context.newPage();
  await anna.goto('/?ping=off');
  await signIn(anna, 'mitarbeiter');
  await anna.getByTestId('nav-leads').click();
  const column = anna.getByTestId('custom-column').filter({ hasText: name });
  await expect(column).toBeVisible();
  await expect(column.getByRole('button', { name: `Spalte „${name}“ umbenennen` })).toHaveCount(0);
  await expect(column.getByRole('button', { name: `Spalte „${name}“ löschen` })).toHaveCount(0);
  await expect(anna.getByTestId('board-column-left')).toHaveCount(0);
  await expect(anna.getByTestId('board-column-edit')).toHaveCount(0);
  await expect(anna.getByTestId('board-column-new')).toHaveCount(0);
  await context.close();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('custom-column').filter({ hasText: name }).getByRole('button', { name: `Spalte „${name}“ löschen` }).click();
  await expect(page.getByTestId('custom-column').filter({ hasText: name })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Kontakt per Link: Profil-Link einfügen → Lead mit übernommenem Chat, Dublette wird erkannt', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page);

  await page.getByTestId('contact-add').click();
  const dialog = page.getByTestId('contact-dialog');
  await expect(dialog).toContainText('über deinen LinkedIn-Account');
  await expect(page.getByTestId('contact-profile-input')).toBeFocused();
  await page.getByTestId('contact-profile-input').fill('https://example.com/anna');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('contact-error')).toContainText('kein LinkedIn-Profil-Link');

  await page.getByTestId('contact-profile-input').fill('https://www.linkedin.com/in/anna-berg-4a1b2c/');
  await page.getByTestId('contact-submit').click();
  // Gleich im Lead-Panel: persönlicher Kontakt, Chat aus LinkedIn im Verlauf
  const panel = page.getByRole('dialog', { name: /Anna Berg/ });
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('contact-dialog')).toHaveCount(0);
  await expect(page.getByTestId('contact-chip')).toBeVisible();
  await page.getByTestId('lead-tab-history').click();
  await expect(panel).toContainText('Lass uns gern mal kurz telefonieren.');
  await expect(panel).toContainText('aus LinkedIn übernommen');
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('contact-notice')).toContainText('Anna Berg ist jetzt unter „Antwort“. 2 Nachrichten aus dem LinkedIn-Chat übernommen.');
  await expect(page.getByTestId('leads-board').getByTestId('column-replied')).toContainText('Anna Berg');

  // Noch einmal: kein zweiter Lead
  await page.getByTestId('contact-add').click();
  await page.getByTestId('contact-profile-input').fill('linkedin.com/in/Anna-Berg-4a1b2c');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /Anna Berg/ })).toBeVisible();
  await expect(page.getByTestId('contact-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('contact-notice')).toContainText('gibt es schon');
  await expect(page.getByTestId('leads-board').getByText('Anna Berg')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Board frei verschieben: Termin zurück nach Antwort, Antwort interessiert / nicht interessiert, Filter nach Zielgruppe', async ({ page }) => {
  const errors = trackErrors(page);
  const ralf = await (async () => {
    await openLeads(page);
    return findLead(page, 'nick', 'Ralf Ostermann');
  })();
  // Ralf hat einen Termin – im Board zurück nach „Antwort“ ziehen (per Ereignis, die Spalten liegen nicht zugleich im Bild).
  expect((await page.request.post(`/api/leads/${ralf.id}/events`, { data: { action: 'meeting_booked' } })).status()).toBe(200);
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-leads').click();
  const board = page.getByTestId('leads-board');
  await expect(board.getByTestId('column-meeting')).toContainText('Ralf Ostermann');
  const drag = (from: string, to: string) =>
    page.evaluate(`(() => {
      const source = [...document.querySelectorAll('[data-testid=${from}] [data-testid=board-card]')].find((el) => el.textContent.includes('Ralf Ostermann'));
      const target = document.querySelector('[data-testid=${to}]');
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    })()`);
  await drag('column-meeting', 'column-replied-interested');
  await expect(board.getByTestId('column-replied-interested')).toContainText('Ralf Ostermann');
  await expect(board.getByTestId('column-meeting')).not.toContainText('Ralf Ostermann');
  expect((await findLead(page, 'nick', 'Ralf Ostermann')).stage).toBe('replied');

  // Innerhalb von „Antwort“: nicht interessiert
  await drag('column-replied-interested', 'column-replied-not_interested');
  await expect(board.getByTestId('column-replied-not_interested')).toContainText('Ralf Ostermann');
  const detail = (await (await page.request.get(`/api/leads/${ralf.id}`)).json()) as {
    lead: { replyInterest?: string | null; assessment: { category: string } | null };
  };
  expect(detail.lead.replyInterest).toBe('not_interested');

  // Zielgruppe: bei der jeweils anderen Kategorie ist Ralf nicht zu sehen
  const category = detail.lead.assessment?.category;
  // Seit 25.10. im Menü „Board ▾“ statt als eigener Schalter.
  await page.getByTestId('leads-view-options').click();
  await page.getByRole('menuitemradio', { name: category === 'bautraeger_projektentwickler' ? 'Kapitalanlage' : 'Bauträger' }).click();
  await expect(page.getByTestId('leads-view-options')).toContainText(category === 'bautraeger_projektentwickler' ? 'Kapitalanlage' : 'Bauträger');
  await expect(board).not.toContainText('Ralf Ostermann');
  await page.getByTestId('leads-view-options').click();
  await page.getByRole('menuitemradio', { name: 'Alle Zielgruppen' }).click();
  await expect(board).toContainText('Ralf Ostermann');
  expect(errors).toEqual([]);
});

test('Follow-up planen im Lead-Panel: Datum per Schnellwahl, Spalte „Follow-Up spezial“ vorgewählt, wieder entfernen', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page);
  expect((await page.request.post('/api/board/columns', { data: { name: 'Follow-Up spezial' } })).status()).toBe(201);
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-leads').click();
  await page.getByTestId('leads-board').getByTestId('board-card').filter({ hasText: 'Ralf Ostermann' }).click();

  await page.getByTestId('follow-up-plan').click();
  await expect(page.getByTestId('follow-up-column')).toHaveValue(/.+/);
  await expect(page.getByTestId('follow-up-column').locator('option:checked')).toHaveText('Follow-Up spezial');
  await page.getByRole('button', { name: '2 Wochen' }).click();
  await page.getByTestId('follow-up-save').click();
  await expect(page.getByTestId('follow-up-plan')).toContainText('· Follow-Up spezial');
  await expect(page.getByTestId('follow-up-plan')).toContainText(/pausiert bis \d{2}\.\d{2}\.\d{4}/);
  // Ab sofort im Board in der Follow-up-Spalte (22.10.), nicht erst am Tag.
  await page.keyboard.press('Escape');
  const column = page.getByTestId('custom-column').filter({ hasText: 'Follow-Up spezial' });
  await expect(column).toContainText('Ralf Ostermann');
  await expect(page.getByTestId('column-replied')).not.toContainText('Ralf Ostermann');

  await column.getByTestId('board-card').filter({ hasText: 'Ralf Ostermann' }).click();
  await page.getByTestId('follow-up-plan').click();
  await page.getByTestId('follow-up-remove').click();
  await expect(page.getByTestId('follow-up-plan')).toContainText('keins geplant');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('column-replied')).toContainText('Ralf Ostermann');
  const columns = (await (await page.request.get('/api/board/columns')).json()) as { columns: { id: string; name: string }[] };
  for (const entry of columns.columns.filter((c) => c.name === 'Follow-Up spezial')) await page.request.delete(`/api/board/columns/${entry.id}`);
  expect(errors).toEqual([]);
});
