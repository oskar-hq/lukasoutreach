import { expect, test, type Page } from '@playwright/test';
import type { TasksResponse } from '../shared/tasks';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Account-Wechsel (Wunsch des Nutzers 12.10.): Ist der eigene LinkedIn-Account voll, geht die nächste Anfrage über den
 * des anderen Gründers – die Karte sagt das. Leads, deren Anfrage über den anderen Account ging, schreibt man auch von
 * dort. Die Antwort von `/api/tasks` wird hier verändert, statt 20 Anfragen wirklich einzutragen.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();

const VIA_JOHANNES = { sentBy: 'johannes' as const, invitationId: null, invitedAt: null, chatId: null, chatStartedAt: null };

async function withSwitchedAccount(page: Page, via: 'johannes' | null) {
  const switched = new Set<string>();
  // Die Karte lädt den Lead einzeln nach – auch dort über Johannes.
  await page.route(/\/api\/leads\/[^/?]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { lead?: { id: string; linkedin?: unknown } };
    if (body.lead && switched.has(body.lead.id)) body.lead.linkedin = VIA_JOHANNES;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/tasks*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as TasksResponse;
    body.inviteVia = via;
    // Wie der Server seit 25.10.: je Besitzer der Account der nächsten Anfrage und die Zahlen je Account.
    body.inviteViaByOwner = { nick: via, johannes: via };
    body.invitesByAccount = { nick: 20, johannes: via ? 5 : 20 };
    body.invitesPerDayByAccount = { nick: 20, johannes: 20 };
    body.rules.newLeadsPerDay = 40;
    for (const task of body.tasks) {
      if (task.type !== 'first') continue;
      task.lead.linkedin = VIA_JOHANNES;
      switched.add(task.lead.id);
    }
    await route.fulfill({ response, json: body });
  });
}

test('Eigener Account voll: Karte nennt den Account von Johannes, Erstnachricht ebenso', async ({ page }) => {
  const errors = trackErrors(page);
  await withSwitchedAccount(page, 'johannes');
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'lead');
  await expect(currentCard(page).getByTestId('account-hint')).toHaveText('Über den LinkedIn-Account von Johannes – deiner hat heute keine Anfragen mehr frei.');
  await expect(currentCard(page).getByTestId('invite-limit-reached')).toHaveCount(0);

  await page.goto('/?ping=off');
  await page.getByTestId('start-first').click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'first');
  await expect(currentCard(page).getByTestId('account-hint')).toHaveText('Vernetzt über den LinkedIn-Account von Johannes – schreib auch von dort.');
  expect(errors).toEqual([]);
});

test('Beide Accounts voll: gesperrt mit Satz für beide', async ({ page }) => {
  const errors = trackErrors(page);
  await withSwitchedAccount(page, null);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(currentCard(page).getByTestId('invite-limit-reached')).toContainText('beide LinkedIn-Accounts');
  await expect(currentCard(page).getByTestId('account-hint')).toHaveCount(0);
  expect(errors).toEqual([]);
});
