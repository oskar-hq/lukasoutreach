import { expect, test, type Page } from '@playwright/test';
import { fail, findLead, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Phase 3 gegen die LinkedIn-Simulation (`shared/linkedin.ts`): Vernetzen und Nachrichten gehen an
 * `/api/leads/:id/linkedin/*`, nichts verlässt den Server. Limits, Pausen und Arbeitszeit prüft das Backend –
 * die Oberfläche zeigt sie nur an (Fehler und Pausen hier nachgebaut).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();
const currentName = (page: Page) => currentCard(page).getByTestId('lead-name');

type LinkedInLead = { stage: string; linkedin?: { invitationId: string | null; chatId: string | null } | null };

async function login(page: Page, params = 'ping=off&undo=0') {
  await page.goto(`/?${params}`);
  await signIn(page, 'nick');
}

async function invitesToday(page: Page): Promise<number> {
  const response = await page.request.get('/api/linkedin/status');
  const body = (await response.json()) as { accounts: { founder: string; invitesToday: { used: number } }[] };
  return body.accounts.find((account) => account.founder === 'nick')!.invitesToday.used;
}

test('Simulation: Vernetzen und Erstnachricht gehen über LinkedIn', async ({ page }) => {
  const errors = trackErrors(page);
  // Jede Aktion über LinkedIn trägt eine `clientId` – eine Wiederholung sendet dann nicht noch einmal.
  const linkedinBodies: { clientId?: string }[] = [];
  page.on('request', (request) => {
    if (/\/linkedin\/(invite|message)$/.test(request.url())) linkedinBodies.push(request.postDataJSON() as { clientId?: string });
  });
  await login(page);
  const status = page.getByTestId('linkedin-status');
  await expect(status).toContainText('Gesendet wird über deinen LinkedIn-Account');
  await expect(status).not.toContainText('Simulation');
  await expect(page.getByTestId('protocol-hint')).toHaveCount(0);
  const before = await invitesToday(page);

  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await expect(currentCard(page).getByRole('button', { name: /Vernetzen/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => ((await findLead(page, 'nick', 'Henrik Saalfeld')) as LinkedInLead).linkedin?.invitationId ?? '')
    .toMatch(/^mock-inv-/);
  expect(((await findLead(page, 'nick', 'Henrik Saalfeld')) as LinkedInLead).stage).toBe('invited');
  expect(await invitesToday(page)).toBe(before + 1);

  // Erstnachricht
  await page.getByTestId('filter-menu').click();
  await page.getByRole('menuitemradio', { name: /Erstnachrichten/ }).click();
  const name = (await currentName(page).textContent())!.trim();
  await expect(currentCard(page).getByRole('button', { name: /Senden/ })).toBeEnabled();
  await currentCard(page).getByRole('button', { name: /Senden/ }).click();
  await expect.poll(async () => ((await findLead(page, 'nick', name)) as LinkedInLead).linkedin?.chatId ?? '').toMatch(/^mock-chat-/);

  expect(linkedinBodies).toHaveLength(2);
  for (const body of linkedinBodies) expect(body.clientId).toMatch(/\|(invite_sent|message_sent)@\d+$/);

  // Verlauf zeigt, dass es über LinkedIn ging
  await page.getByRole('button', { name: /Beenden/ }).click();
  await page.getByTestId('nav-leads').click();
  await page.getByTestId('column-invited').getByRole('button', { name: /Henrik Saalfeld/ }).click();
  await expect(page.getByRole('dialog')).toContainText('über LinkedIn');
  await page.keyboard.press('Escape');

  // Startseite zählt mit und gleicht auf Knopfdruck ab
  await page.getByTestId('nav-home').click();
  await status.getByTestId('home-details-toggle').click();
  await expect(status).toContainText(`Heute ${before + 1} /`);
  await status.getByTestId('linkedin-sync').click();
  await expect(status.getByTestId('linkedin-sync-state')).toContainText('Abgeglichen:');
  expect(errors).toEqual([]);
});

test('Limit erreicht: nichts gesendet, Grund auf der Karte, kein Wiederholen', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 429\b/.test(text));
  let calls = 0;
  await page.route('**/api/leads/*/linkedin/invite', (route) => {
    calls += 1;
    return fail(route, 429, 'linkedin_limit', 'Tageslimit für Vernetzungsanfragen erreicht (20) – morgen geht es weiter.', {
      headers: { 'Retry-After': '3600' },
    });
  });
  await login(page);
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('notice')).toContainText('Tageslimit für Vernetzungsanfragen erreicht');
  await page.keyboard.press('ArrowLeft');
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await expect(currentCard(page).getByTestId('card-failure')).toContainText('Tageslimit');
  await expect(page.getByTestId('waiting-status')).toHaveCount(0);
  expect(calls).toBe(1);
  expect((await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('new');
  expect(errors).toEqual([]);
});

test('Pausiert und außerhalb der Arbeitszeit: Startseite und Karte sagen es', async ({ page }) => {
  await page.route('**/api/linkedin/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const accounts = body.accounts.map((account: { founder: string }) =>
      account.founder === 'nick' ? { ...account, pausedUntil: Date.now() + 3_600_000, pauseReason: 'LinkedIn meldet zu viele Anfragen.' } : account,
    );
    return route.fulfill({ response, json: { ...body, accounts, withinWorkHours: false } });
  });
  await login(page, 'ping=off');
  const status = page.getByTestId('linkedin-status');
  await expect(status).toContainText('LinkedIn ist pausiert bis');
  await expect(status).toContainText('LinkedIn meldet zu viele Anfragen.');
  await page.getByTestId('start-lead').click();
  await expect(currentCard(page).getByTestId('linkedin-block')).toContainText('pausiert');
});

test('Außerhalb der Arbeitszeit: Hinweis mit den Zeiten', async ({ page }) => {
  await page.route('**/api/linkedin/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, withinWorkHours: false, workHours: { ...body.workHours, fromHour: 8, toHour: 19, days: [1, 2, 3, 4, 5] } } });
  });
  await login(page, 'ping=off');
  await expect(page.getByTestId('linkedin-status')).toContainText('Gesendet wird nur zu Arbeitszeiten (Mo–Fr 8–19 Uhr).');
});

test('Abgleich schlägt fehl: Fehler steht sichtbar, auch bei zugeklappten Details', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 502\b/.test(text));
  let calls = 0;
  await page.route('**/api/linkedin/sync', (route) => {
    calls += 1;
    return fail(route, 502, 'linkedin_unavailable', 'LinkedIn ist gerade nicht erreichbar.');
  });
  await login(page);
  const status = page.getByTestId('linkedin-status');
  // Tageszähler und Abgleich sind einen Klick entfernt.
  await expect(status.getByTestId('linkedin-sync')).toHaveCount(0);
  await status.getByTestId('home-details-toggle').click();
  await status.getByTestId('linkedin-sync').click();
  await expect(status.getByTestId('linkedin-sync-error')).toContainText('LinkedIn ist gerade nicht erreichbar.');
  await status.getByTestId('home-details-toggle').click();
  await expect(status.getByTestId('linkedin-sync')).toHaveCount(0);
  await expect(status.getByTestId('linkedin-sync-error')).toBeVisible();
  await status.getByTestId('linkedin-sync-error').getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(status.getByTestId('linkedin-sync-error')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Vernetzen mit Notiz: die Notiz geht mit der Anfrage raus', async ({ page }) => {
  const errors = trackErrors(page);
  const inviteBodies: { message?: string }[] = [];
  page.on('request', (request) => {
    if (/\/linkedin\/invite$/.test(request.url())) inviteBodies.push(request.postDataJSON() as { message?: string });
  });
  await login(page);
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');

  await currentCard(page).getByTestId('invite-note-open').click();
  const note = currentCard(page).getByTestId('invite-note').getByRole('textbox');
  await expect(note).toBeFocused();
  // Zu lang: Vernetzen gesperrt, Zähler rot
  await note.fill('x'.repeat(301));
  await expect(currentCard(page).getByTestId('invite-note-count')).toContainText('301 / 300');
  await expect(currentCard(page).getByRole('button', { name: /Vernetzen/ })).toBeDisabled();

  await note.fill('Hallo Henrik, gern vernetzt – Gruß Nick');
  await currentCard(page).getByRole('button', { name: /Vernetzen/ }).click();
  await expect.poll(() => inviteBodies.length).toBe(1);
  expect(inviteBodies[0].message).toBe('Hallo Henrik, gern vernetzt – Gruß Nick');
  await expect
    .poll(async () => ((await findLead(page, 'nick', 'Henrik Saalfeld')) as LinkedInLead).stage)
    .toBe('invited');
  expect(errors).toEqual([]);
});
