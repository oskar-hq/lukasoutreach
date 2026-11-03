import { expect, test } from '@playwright/test';
import type { TasksResponse } from '../shared/tasks';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * LinkedIn-Account eines Gründers nicht verbunden (Wunsch des Nutzers 17.10.): Unter „Meine“ sind seine Aufgaben
 * pausiert, seine neuen Leads stehen beim anderen Gründer („übernommen“). Die Simulation hat beide Accounts – die
 * Antwort von `/api/tasks` wird hier verändert.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

test('Account nicht verbunden: Startseite zeigt die Pause statt Aufgaben', async ({ page }) => {
  const errors = trackErrors(page);
  await page.route('**/api/tasks*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as TasksResponse;
    if (body.owner === 'nick') {
      body.tasks = [];
      body.counts = { reply: 0, followup: 0, first: 0, lead: 0 };
    }
    body.accountPaused = ['nick'];
    await route.fulfill({ response, json: body });
  });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  const paused = page.getByTestId('account-paused');
  await expect(paused).toContainText('Der LinkedIn-Account ist gerade nicht verbunden. Verbinde ihn bitte erneut, um weiterzuarbeiten.');
  await expect(page.getByTestId('start-focus')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Übernommener Lead: Karte sagt, von wem er kommt', async ({ page }) => {
  const errors = trackErrors(page);
  await page.route('**/api/tasks*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as TasksResponse;
    for (const task of body.tasks) if (task.type === 'lead') task.adoptedFrom = 'johannes';
    body.accountPaused = ['johannes'];
    await route.fulfill({ response, json: body });
  });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  const card = page.locator('[data-testid=stack-card]').last();
  await expect(card.getByTestId('adopted-from')).toContainText('Übernommen von Johannes');
  await expect(card.getByTestId('for-founder')).toHaveCount(0);
  expect(errors).toEqual([]);
});
