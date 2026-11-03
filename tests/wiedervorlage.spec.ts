import { expect, test, type Page } from '@playwright/test';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Wiedervorlage (Wunsch des Nutzers 22.10.): einen Lead pausieren und an einem Tag wieder in die Aufgaben holen – aus
 * dem Stapel („Später“), von der Startseite (nach allen Follow-ups) – und ein Termin per Knopf in den Chats.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

const DAY = 24 * 60 * 60 * 1000;

interface ApiLead {
  id: string;
  stage: string;
  followUpPlan?: { at: number; column: string | null } | null;
  person: { firstName: string; lastName: string };
}

const nameOf = (lead: ApiLead) => `${lead.person.firstName} ${lead.person.lastName}`;

async function leadsIn(page: Page, stage: string): Promise<ApiLead[]> {
  const response = await page.request.get(`/api/leads?owner=nick&stage=${stage}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { leads: ApiLead[] }).leads;
}

async function leadById(page: Page, id: string): Promise<ApiLead> {
  const response = await page.request.get(`/api/leads/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { lead: ApiLead }).lead;
}

async function act(page: Page, leadId: string, body: object) {
  const response = await page.request.post(`/api/leads/${leadId}/events`, { data: body });
  expect(response.status(), await response.text()).toBe(200);
}

test('Startseite: nach allen Follow-ups „In 2 Wochen wieder“ – pausiert, verschwindet aus „Braucht Aufmerksamkeit“', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  const [lead] = await leadsIn(page, 'contacted');
  for (let i = 0; i < 3; i++) await act(page, lead.id, { action: 'message_sent', text: `Follow-up ${i + 1}`, at: Date.now() - 5 * DAY });
  await page.reload();
  await signIn(page, 'nick');

  await page.getByTestId('attention-toggle').click();
  const item = page.getByTestId('attention-list').getByTestId('attention-followups_done').filter({ hasText: nameOf(lead) });
  await expect(item).toContainText('Alle 3 Follow-ups gesendet');
  await item.getByTestId('row-resume').click();
  await expect(item).toHaveCount(0);
  const plan = (await leadById(page, lead.id)).followUpPlan;
  expect(plan?.column).toBeNull();
  expect(Math.round(((plan?.at ?? 0) - Date.now()) / DAY)).toBe(14);
  expect(errors).toEqual([]);
});

test('Aufgaben: „Später“ (W) pausiert den Lead bis zum Tag, Z nimmt es zurück', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=2');
  await signIn(page, 'nick');
  await page.getByTestId('start-focus').click();
  const card = page.locator('[data-testid=stack-card]').last();
  await expect(card).toBeVisible();
  const first = await card.getAttribute('data-card-id');
  const firstLead = first!.split(':')[0];

  await page.keyboard.press('w');
  const menu = page.getByTestId('later-menu');
  await expect(menu).toContainText('In 2 Wochen');
  await menu.getByTestId('later-4').click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('[data-testid=stack-card]').last()).not.toHaveAttribute('data-card-id', first!);
  await expect.poll(async () => (await leadById(page, firstLead)).followUpPlan?.at ?? 0, { timeout: 10_000 }).toBeGreaterThan(Date.now() + 13 * DAY);

  // Zweite Karte: „Später“ und sofort rückgängig – kein Plan.
  const second = await page.locator('[data-testid=stack-card]').last().getAttribute('data-card-id');
  await page.keyboard.press('w');
  await page.keyboard.press('1');
  await expect(page.locator('[data-testid=stack-card]').last()).not.toHaveAttribute('data-card-id', second!);
  await page.keyboard.press('z');
  await expect(page.locator('[data-testid=stack-card]').last()).toHaveAttribute('data-card-id', second!);
  await page.waitForTimeout(2500);
  expect((await leadById(page, second!.split(':')[0])).followUpPlan ?? null).toBeNull();
  expect(errors).toEqual([]);
});

test('Chats: „Termin vereinbart“ per Knopf – Lead steht in „Termin“', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  const [lead] = await leadsIn(page, 'replied');
  await page.getByTestId('nav-chats').click();
  await page.getByTestId('chats-search').fill(lead.person.lastName);
  await page.getByTestId('chat-item').first().click();
  await expect(page.getByTestId('chat-title')).toHaveText(nameOf(lead));
  await page.getByTestId('chat-meeting').click();
  await expect(page.getByTestId('chat-meeting-chip')).toHaveText('Termin');
  await expect(page.getByTestId('chat-meeting')).toHaveCount(0);
  expect((await leadById(page, lead.id)).stage).toBe('meeting');
  expect(errors).toEqual([]);
});

test('Aufgaben: „Später“ mit eigenem Datum', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-focus').click();
  const card = page.locator('[data-testid=stack-card]').last();
  const id = (await card.getAttribute('data-card-id'))!;
  await page.getByTestId('later').click();
  const menu = page.getByTestId('later-menu');
  await expect(menu.getByTestId('later-1')).toContainText('In 2 Tagen');
  const target = new Date(Date.now() + 10 * DAY);
  const value = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  await menu.getByTestId('later-date').fill(value);
  await menu.getByTestId('later-date-ok').click();
  await expect(page.locator('[data-testid=stack-card]').last()).not.toHaveAttribute('data-card-id', id);
  await expect.poll(async () => (await leadById(page, id.split(':')[0])).followUpPlan?.at ?? 0, { timeout: 10_000 }).toBe(new Date(`${value}T08:00`).getTime());
  expect(errors).toEqual([]);
});
