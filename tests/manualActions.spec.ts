import { expect, test, type Page } from '@playwright/test';
import { MESSAGE_WITHOUT_TEXT } from '../shared/leads';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Wunsch des Nutzers 09.11.: „Manuell vernetzt“ auf der Karte „Neuer Lead“ (zählt als von Hand) und „Follow-up getätigt“
 * auf der Follow-up-Karte (z. B. Sticker auf LinkedIn – nur eintragen, im Chat als Hinweis).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();
const DECISION = /^\/api\/leads\/[^/]+\/(events|linkedin\/(invite|message))$/;

test('Neuer Lead: „Manuell vernetzt“ trägt nur ein – nichts über LinkedIn, im Verlauf „von Hand“', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  const card = currentCard(page);
  const leadId = (await card.getAttribute('data-card-id'))!.split(':')[0];
  const sent = page.waitForRequest((request) => request.method() === 'POST' && DECISION.test(new URL(request.url()).pathname));
  await card.getByTestId('connect-manual').click();
  const request = await sent;
  expect(new URL(request.url()).pathname).toBe(`/api/leads/${leadId}/events`);
  expect(request.postDataJSON()).toMatchObject({ action: 'invite_sent', manual: true });
  await expect
    .poll(async () => ((await (await page.request.get(`/api/leads/${leadId}`)).json()) as { events: { title: string }[] }).events.at(-1)?.title)
    .toBe('Vernetzungsanfrage gesendet · von Hand auf LinkedIn');
  expect(errors).toEqual([]);
});

test('Follow-up: „Follow-up getätigt“ zählt als Follow-up, Chat zeigt „Sticker oder Anhang“', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off&undo=0');
  await signIn(page, 'nick');
  await page.getByTestId('start-followup').click();
  const card = currentCard(page);
  const leadId = (await card.getAttribute('data-card-id'))!.split(':')[0];
  const before = ((await (await page.request.get(`/api/leads/${leadId}`)).json()) as { lead: { followUpsSent: number } }).lead.followUpsSent;
  const sent = page.waitForRequest((request) => request.method() === 'POST' && DECISION.test(new URL(request.url()).pathname));
  await card.getByTestId('followup-sent-elsewhere').click();
  const request = await sent;
  expect(new URL(request.url()).pathname).toBe(`/api/leads/${leadId}/events`);
  expect(request.postDataJSON()).toMatchObject({ action: 'message_sent', text: MESSAGE_WITHOUT_TEXT, manual: true });
  await expect
    .poll(async () => ((await (await page.request.get(`/api/leads/${leadId}`)).json()) as { lead: { followUpsSent: number } }).lead.followUpsSent)
    .toBe(before + 1);

  // Im Chat als Hinweis statt als Text.
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-chats').click();
  const person = ((await (await page.request.get(`/api/leads/${leadId}`)).json()) as { lead: { person: { lastName: string } } }).lead.person.lastName;
  await page.getByText(person).first().click();
  await expect(page.getByTestId('chat-without-text').first()).toContainText('Sticker oder Anhang');
  expect(errors).toEqual([]);
});
