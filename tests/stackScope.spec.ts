import { expect, test, type Page } from '@playwright/test';
import { findLead, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Tagesstapel „Meine / Alle“ (Wunsch des Nutzers 16.10.): Unter „Alle“ stehen auch die Aufgaben des anderen Gründers –
 * erledigt in dessen Namen (Grußformel, Tageslimit, im Verlauf „von Nick“ für Johannes), eingetragen von Hand.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();
const currentName = (page: Page) => currentCard(page).getByTestId('lead-name');
const readCount = async (page: Page) => Number((await page.getByTestId('open-count').textContent())?.replace(/\D/g, ''));
/** Die Zahl zählt beim Betreten kurz hoch – erst lesen, wenn sie stillsteht. */
const openCount = async (page: Page) => {
  let last = await readCount(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const next = await readCount(page);
    if (next === last) return next;
    last = next;
  }
  return last;
};

test('Standard ist „Alle“ (01.11.): ohne gespeicherte Wahl stehen die Aufgaben beider Gründer im Stapel', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick', 'default');
  await expect(page.getByRole('tab', { name: 'Alle' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('stack-scope')).toHaveAttribute('title', /für Johannes/);
  expect(errors).toEqual([]);
});

test('Meine / Alle: Aufgaben von Johannes mit im Stapel, für Johannes eingetragen, Wahl bleibt nach dem Neuladen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count')).toBeVisible();
  const mine = await openCount(page);

  await page.getByTestId('scope-all').click();
  // Die Erklärung steht nur noch im Hinweis beim Überfahren – keine Zeile, die die Seite verschiebt.
  await expect(page.getByTestId('stack-scope')).toHaveAttribute('title', /für Johannes/);
  await expect.poll(() => openCount(page)).toBeGreaterThan(mine);

  // Bleibt nach dem Neuladen
  await page.reload();
  // Die Erklärung steht nur noch im Hinweis beim Überfahren – keine Zeile, die die Seite verschiebt.
  await expect(page.getByTestId('stack-scope')).toHaveAttribute('title', /für Johannes/);

  // Ein neuer Lead von Johannes: im Fokus-Modus gekennzeichnet und für Johannes eingetragen
  const johannes = (await (await page.request.get('/api/tasks?owner=johannes')).json()) as { tasks: Array<{ type: string; lead: { person: { firstName: string; lastName: string } } }> };
  const task = johannes.tasks.find((entry) => entry.type === 'lead')!;
  const name = `${task.lead.person.firstName} ${task.lead.person.lastName}`;
  await page.getByTestId('start-lead').click();
  for (let i = 0; i < 30; i++) {
    await expect(currentName(page)).toBeVisible();
    if ((await currentName(page).textContent())?.trim() === name) break;
    const before = await currentCard(page).getAttribute('data-card-id');
    await page.getByTestId('defer').click();
    await expect(currentCard(page)).not.toHaveAttribute('data-card-id', before!);
  }
  await expect(currentName(page)).toHaveText(name);
  await expect(currentCard(page).getByTestId('for-founder')).toHaveText("Für Johannes · über Johannes' LinkedIn");
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'johannes', name)).stage).toBe('invited');
  const lead = await findLead(page, 'johannes', name);
  const detail = (await (await page.request.get(`/api/leads/${lead.id}`)).json()) as { events: Array<{ kind: string; by: string; actor: string | null }> };
  const invite = detail.events.find((event) => event.kind === 'invite_sent')!;
  expect([invite.by, invite.actor]).toEqual(['johannes', 'Nick']);

  // Zurück auf „Meine“: nur noch Nicks Aufgaben
  await page.keyboard.press('Escape');
  await page.getByTestId('scope-mine').click();
  await expect(page.getByTestId('stack-scope')).not.toContainText('für Johannes');
  expect(errors).toEqual([]);
});

test('Meine erledigt: kein Weiterarbeiten mit fremden Aufgaben – „Zu Alle“ wechselt in den Stapel beider Gründer', async ({ page }) => {
  // „Meine“ leer (24.10.): die eigenen Plätze sind verbraucht.
  await page.route('**/api/tasks?owner=nick', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, tasks: [], counts: { reply: 0, followup: 0, first: 0, lead: 0 } } });
  });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await expect(page.getByTestId('mine-done')).toContainText('Weiter geht es unter „Alle“.');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('open-count')).toBeVisible();
  await expect(page.getByTestId('mine-done')).toHaveCount(0);
});
