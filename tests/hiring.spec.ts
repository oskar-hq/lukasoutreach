import { expect, test, type Page } from '@playwright/test';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Hiring-Signal und „Jetzt nicht“ (Wunsch des Nutzers 13.10.):
 * - Sucht die Firma Mitarbeiter (`CockpitLead.hiring`), schlägt die Erstnachricht zuerst die Recruiting-Vorlage H1 vor
 *   ({{stelle}} = „Verstärkung als …“); die Meta-Ads-Vorlagen bleiben wählbar. Im Lead-Panel von Hand setzen/entfernen.
 * - „Jetzt nicht“ (J) setzt die aktuelle Aufgabe ans Ende des Stapels, ohne etwas zu speichern.
 * Demo-Daten: Nicks vernetzter Lead Jonas Vogt sucht „Vertriebsmitarbeiter (m/w/d) Kapitalanlageimmobilien“.
 */
test.beforeEach(async ({ request }) => {
  await resetCockpit(request);
  for (const id of ['H1', 'G1', 'G2']) expect((await request.post(`/api/templates/${id}/reset`)).status()).toBe(200);
});

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();
const currentName = (page: Page) => currentCard(page).getByTestId('lead-name');

/** Mit „Jetzt nicht“ weiterblättern, bis `name` vorn liegt. */
async function deferUntil(page: Page, name: string) {
  for (let i = 0; i < 8; i++) {
    await expect(currentName(page)).toBeVisible();
    if ((await currentName(page).textContent())?.trim() === name) return;
    const before = await currentCard(page).getAttribute('data-card-id');
    await page.getByTestId('defer').click();
    await expect(currentCard(page)).not.toHaveAttribute('data-card-id', before!);
  }
  throw new Error(`${name} kam nicht nach vorn`);
}

test('Jetzt nicht: Aufgabe ans Ende, nichts gespeichert, „Ansehen“ holt sie zurück', async ({ page }) => {
  const errors = trackErrors(page);
  let saved = 0;
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\/leads\//.test(request.url())) saved++;
  });
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  const first = (await currentName(page).textContent())!.trim();
  const progress = await page.getByTestId('progress').textContent();

  await page.getByTestId('defer').click();
  await expect(currentName(page)).not.toHaveText(first);
  await expect(page.getByTestId('progress')).toHaveText(progress!);
  // Beim Wechsel blendet der alte Hinweis noch aus – immer den neuesten nehmen.
  const notice = page.getByTestId('notice').last();
  await expect(notice).toContainText('Kommt später wieder');
  await expect(notice).toContainText(`${first} steht jetzt am Ende des Stapels.`);

  // Taste J: die nächste auch – danach zurück zur ersten über „Ansehen“.
  const second = (await currentName(page).textContent())!.trim();
  await page.keyboard.press('j');
  await expect(currentName(page)).not.toHaveText(second);
  await expect(notice).toContainText(second);
  await notice.getByRole('button', { name: 'Ansehen' }).click();
  await expect(currentName(page)).toHaveText(second);
  expect(saved).toBe(0);
  expect(errors).toEqual([]);
});

test('Jetzt nicht: alle Aufgaben im Filter zurückgestellt → weiter mit den anderen Kategorien', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  const count = Number((await page.getByTestId('start-reply').textContent())!.match(/\d+/)![0]);
  expect(count).toBeGreaterThan(1);
  await page.getByTestId('start-reply').click();
  await expect(page.getByTestId('filter-menu')).toHaveAttribute('aria-label', 'Filter: Antworten');
  // Jede Antwort einmal zurückstellen – danach geht es nicht im Kreis, sondern mit den anderen Kategorien weiter.
  for (let i = 0; i < count; i++) {
    await expect(currentCard(page)).toHaveAttribute('data-card-type', 'reply');
    const before = await currentCard(page).getAttribute('data-card-id');
    await page.getByTestId('defer').click();
    await expect(currentCard(page)).not.toHaveAttribute('data-card-id', before!);
  }
  await expect(page.getByTestId('filter-menu')).toHaveAttribute('aria-label', 'Filter: Alle Aufgaben');
  await expect(currentCard(page)).not.toHaveAttribute('data-card-type', 'reply');
  expect(errors).toEqual([]);
});

test('Hiring-Signal: Erstnachricht schlägt die Recruiting-Vorlage vor, Meta-Vorlagen bleiben wählbar', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-first').click();
  await deferUntil(page, 'Jonas Vogt');
  const card = currentCard(page);
  await expect(card.getByTestId('task-sentence')).toContainText('Sucht: Vertriebsmitarbeiter (m/w/d) Kapitalanlageimmobilien');
  const picker = card.getByRole('tablist', { name: 'Template wählen' });
  await expect(picker.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect(picker.getByRole('tab').first()).toContainText('Recruiting');
  const editor = card.getByRole('textbox').first();
  await expect(editor).toHaveValue(/gerade Verstärkung als Vertriebsmitarbeiter \(m\/w\/d\) Kapitalanlageimmobilien sucht/);
  await expect(card.getByTestId('template-warning')).toHaveCount(0);

  // Taste 2: die erste Meta-Ads-Vorlage – gemeldet wird ihre ID.
  await page.keyboard.press('2');
  await expect(editor).not.toHaveValue(/Verstärkung als/);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/leads\/[^/]+\/(events|linkedin\/message)$/.test(new URL(r.url()).pathname));
  await page.keyboard.press('1');
  await expect(editor).toHaveValue(/Verstärkung als/);
  await page.keyboard.press('Enter');
  expect((await sent).postDataJSON()).toMatchObject({ label: 'H1' });
  expect(errors).toEqual([]);
});

test('Hiring-Signal von Hand im Lead-Panel: setzen, Stelle ändern, entfernen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await page.getByTitle('Lead-Historie öffnen').click();
  const panel = page.getByRole('dialog');
  const actions = panel;
  await expect(actions.getByTestId('hiring')).toContainText('kein Hinweis');

  await actions.getByTestId('hiring').click();
  await actions.getByTestId('hiring-role').fill('Vertriebsmitarbeiter (m/w/d)');
  await actions.getByTestId('hiring-save').click();
  await expect(actions.getByTestId('hiring')).toContainText('Vertriebsmitarbeiter (m/w/d) · von Hand');
  await expect(panel).toContainText('Sucht Mitarbeiter (von Hand): Vertriebsmitarbeiter (m/w/d)');

  await actions.getByTestId('hiring').click();
  await actions.getByTestId('hiring-remove').click();
  await expect(actions.getByTestId('hiring')).toContainText('kein Hinweis');
  await expect(panel).toContainText('Sucht keine Mitarbeiter (von Hand)');
  expect(errors).toEqual([]);
});
