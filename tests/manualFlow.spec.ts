import { expect, test, type Page } from '@playwright/test';
import { findLead, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Manueller Betrieb, Sackgassen und Randfälle: gelöschter Lead mitten in der Arbeit, „Wieder öffnen“ nach einer
 * Entscheidung im Stapel, angefangene Antwort bei einer zweiten Antwort, neuer Tag im offenen Tab, „Hat geantwortet“ und
 * „Termin vereinbart“ auf den Karten, Eintragen im Lead-Panel, Board und Chats ohne 409.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

/** 404 (gelöschter Lead) und 409 gehören zu einzelnen Tests – der Browser meldet sie als Konsolenfehler. */
const expected404 = (text: string) => /status of 404\b/.test(text);

async function login(page: Page, params = 'ping=off&undo=0') {
  await page.goto(`/?${params}`);
  await signIn(page, 'nick');
}

async function act(page: Page, leadId: string, body: object) {
  const response = await page.request.post(`/api/leads/${leadId}/events`, { data: body });
  expect(response.status(), await response.text()).toBe(200);
}

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();

/** Tagesstapel neu laden wie nach der Rückkehr in den Tab (Stand gilt nach 20 s als alt). */
async function refreshStack(page: Page) {
  await page.evaluate('(() => { const now = Date.now; Date.now = () => now() + 120000; document.dispatchEvent(new Event("visibilitychange")); })()');
}

test('Gelöschter Lead: nur seine Entscheidung fällt weg, die übrigen werden gespeichert', async ({ page }) => {
  const errors = trackErrors(page, expected404);
  await login(page, 'ping=off&undo=1');
  await page.getByTestId('start-reply').click();
  const first = currentCard(page);
  await expect(first).toHaveAttribute('data-card-type', 'reply');
  await expect(first.getByTestId('chat-thread').or(first.locator('[aria-busy=false]')).first()).toBeVisible();
  const firstName = (await first.getByTestId('lead-name').textContent())!;
  const firstLead = await findLead(page, 'nick', firstName);

  // Die erste Entscheidung braucht beim Speichern etwas länger – in der Zwischenzeit kommt das 404 des anderen Leads.
  await page.route(new RegExp(`/api/leads/${firstLead.id}/events$`), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.keyboard.press('ArrowLeft'); // Kein Interesse
  const second = currentCard(page);
  await expect(second.getByTestId('lead-name')).not.toHaveText(firstName);
  const secondName = (await second.getByTestId('lead-name').textContent())!;
  const secondLead = await findLead(page, 'nick', secondName);
  await expect(second.locator('[aria-busy=false]').first()).toBeVisible();

  // Anderswo gelöscht (Datenschutz-Löschung) – das Speichern dieser Entscheidung läuft ins 404.
  expect((await page.request.delete(`/api/leads/${secondLead.id}`)).status()).toBe(200);
  await page.keyboard.press('ArrowLeft');

  await expect(page.getByTestId('notice')).toContainText('Lead gibt es nicht mehr (gelöscht)');
  await expect(page.getByTestId('notice')).toContainText('Seine Aufgaben sind aus deinem Stapel entfernt.');
  await expect(page.getByText('Die Daten wurden zurückgesetzt')).toHaveCount(0);
  // Die erste Entscheidung bleibt und ist gespeichert.
  await expect.poll(async () => (await findLead(page, 'nick', firstName)).stage, { timeout: 10_000 }).toBe('lost');
  await expect(page.getByTestId('progress')).toContainText('1 von');
  expect(errors).toEqual([]);
});

test('Gelöschter Lead außerhalb des Stapels: Hinweis ohne „Stapel“', async ({ page }) => {
  const errors = trackErrors(page, expected404);
  await login(page);
  const tasks = (await (await page.request.get('/api/tasks?owner=nick')).json()) as { tasks: { lead: { id: string } }[] };
  const inStack = new Set(tasks.tasks.map((task) => task.lead.id));
  const { leads } = (await (await page.request.get('/api/leads?owner=nick&limit=2000')).json()) as {
    leads: { id: string; person: { firstName: string; lastName: string } }[];
  };
  const outside = leads.find((lead) => !inStack.has(lead.id))!;
  const name = `${outside.person.firstName} ${outside.person.lastName}`;
  await page.getByTestId('nav-leads').click();
  const card = page.getByTestId('leads-board').getByTestId('board-card').filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  // Anderswo gelöscht – das Öffnen läuft ins 404.
  expect((await page.request.delete(`/api/leads/${outside.id}`)).status()).toBe(200);
  await card.click();
  const notice = page.getByTestId('notice');
  await expect(notice).toContainText('Lead gibt es nicht mehr (gelöscht)');
  await expect(notice).not.toContainText('Stapel');
  expect(errors).toEqual([]);
});

test('Gelöschter Lead: ein noch laufendes Laden des Stapels bringt seine Aufgabe nicht zurück', async ({ page }) => {
  const errors = trackErrors(page, expected404);
  await login(page);
  await expect(page.getByTestId('open-count')).toHaveText('14');
  const tasks = (await (await page.request.get('/api/tasks?owner=nick')).json()) as { tasks: { type: string; lead: { id: string } }[] };
  const doomed = tasks.tasks.find((task) => task.type === 'first')!.lead.id;

  // Erstes Laden: Antwort mit dem Lead holen, aber erst später ausliefern. Jedes weitere Laden wartet, bis der Test fertig ist.
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => (releaseStale = resolve));
  let releaseRest!: () => void;
  const restGate = new Promise<void>((resolve) => (releaseRest = resolve));
  let calls = 0;
  let staleFetched = false;
  await page.route('**/api/tasks*', async (route) => {
    if (++calls === 1) {
      const response = await route.fetch();
      staleFetched = true;
      await staleGate;
      return route.fulfill({ response });
    }
    await restGate;
    return route.continue();
  });
  await refreshStack(page);
  await expect.poll(() => staleFetched).toBe(true);

  // Lead anderswo gelöscht; die Erstnachricht öffnen läuft ins 404 → Aufgabe fällt weg. Gleich danach (bevor das
  // Neuladen nach dem Löschen startet) kommt die alte Antwort (noch mit dem Lead) an – sie darf nichts zurückbringen.
  expect((await page.request.delete(`/api/leads/${doomed}`)).status()).toBe(200);
  await page.route(new RegExp(`/api/leads/${doomed}$`), async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
    setTimeout(releaseStale, 50);
  });
  await page.getByTestId('start-first').click();
  await expect(page.getByTestId('notice')).toContainText('Lead gibt es nicht mehr (gelöscht)');
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('progress')).toHaveText('0 von 13 erledigt');
  releaseRest();
  expect(errors).toEqual([]);
});

test('Angefangene Antwort bleibt nach „Kein Interesse“ stehen (nur Senden verbraucht sie)', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await page.getByTestId('start-reply').click();
  const card = currentCard(page);
  await expect(card.getByRole('button', { name: 'Kein Interesse' })).toBeEnabled();
  const name = (await card.getByTestId('lead-name').textContent())!;
  await card.getByTestId('reply-answer').locator('textarea').fill('Schade – darf ich mich im Frühjahr noch einmal melden?');
  const saved = page.waitForResponse((response) => /\/api\/leads\/[^/]+\/events$/.test(response.url()) && response.request().method() === 'POST');
  await card.getByRole('button', { name: 'Kein Interesse' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId('progress')).toContainText('1 von');

  // Wieder geöffnet → dieselbe Antwort-Aufgabe ist wieder offen, der Text steht noch da.
  const lead = await findLead(page, 'nick', name);
  await act(page, lead.id, { action: 'reopened' });
  // Nur diese Aufgabe laden, damit sie vorn liegt.
  await page.route('**/api/tasks*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { tasks: { lead: { id: string } }[] };
    const tasks = body.tasks.filter((task) => task.lead.id === lead.id);
    return route.fulfill({ response, json: { ...body, tasks, counts: { reply: tasks.length, followup: 0, first: 0, lead: 0 } } });
  });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('start-reply')).toContainText('1');
  await page.getByTestId('start-reply').click();
  const again = currentCard(page);
  await expect(again.getByTestId('lead-name')).toHaveText(name);
  await expect(again.getByTestId('reply-answer').locator('textarea')).toHaveValue('Schade – darf ich mich im Frühjahr noch einmal melden?');
  expect(errors).toEqual([]);
});

test('Wieder öffnen nach einer Entscheidung im Stapel: die Aufgabe ist wieder offen', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await expect(page.getByTestId('start-reply')).toContainText('3');
  await page.getByTestId('start-reply').click();
  const card = currentCard(page);
  await expect(card.locator('[aria-busy=false]').first()).toBeVisible();
  const name = (await card.getByTestId('lead-name').textContent())!;
  const saved = page.waitForResponse((response) => /\/api\/leads\/[^/]+\/events$/.test(response.url()) && response.request().method() === 'POST');
  await page.keyboard.press('ArrowLeft'); // Kein Interesse → verloren
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId('progress')).toContainText('1 von');

  // Im Lead-Panel (hier direkt über die API) wieder geöffnet – gleiche Aufgabe, neuer Stand.
  const lead = await findLead(page, 'nick', name);
  await act(page, lead.id, { action: 'reopened' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('start-reply')).toContainText('3');
  expect(errors).toEqual([]);
});

test('Zweite Antwort, während du tippst: die angefangene Antwort wandert auf die neue Aufgabe', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await page.getByTestId('start-reply').click();
  const card = currentCard(page);
  const name = (await card.getByTestId('lead-name').textContent())!;
  await card.getByTestId('reply-answer').locator('textarea').fill('Gern, wie wäre Donnerstag um 10?');

  const lead = await findLead(page, 'nick', name);
  await act(page, lead.id, { action: 'message_received', text: 'Noch eine Frage vorab: Was kostet das?' });
  await refreshStack(page);
  await page.getByTestId('stale-next').click();

  const next = currentCard(page);
  await expect(next).toHaveAttribute('data-card-type', 'reply');
  await expect(next.getByTestId('lead-name')).toHaveText(name);
  await expect(next.getByTestId('reply-answer').locator('textarea')).toHaveValue('Gern, wie wäre Donnerstag um 10?');
  expect(errors).toEqual([]);
});

test('Über Nacht offener Tab: der Takt beginnt einen neuen Tag', async ({ page }) => {
  const errors = trackErrors(page);
  const now = new Date();
  await page.clock.install({ time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0) });
  await login(page);
  await page.getByTestId('start-reply').click();
  await expect(currentCard(page).getByTestId('reply-skip')).toBeVisible();
  await currentCard(page).getByTestId('reply-skip').click();
  await expect(page.getByTestId('progress')).toContainText('1 von');

  // Mitternacht vorbei, der Tab bleibt sichtbar (kein Fokuswechsel) – nur der 60-s-Takt läuft.
  await page.clock.fastForward('01:30');
  await expect(page.getByTestId('progress')).toContainText('0 von');
  expect(errors).toEqual([]);
});

test('Karten: „Hat geantwortet“ auf der Erstnachricht, „Termin vereinbart“ auf der Antwort', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await expect(page.getByTestId('start-reply')).toContainText('3');

  await page.getByTestId('start-first').click();
  const first = currentCard(page);
  await expect(first).toHaveAttribute('data-card-type', 'first');
  const name = (await first.getByTestId('lead-name').textContent())!;
  await page.keyboard.press('a');
  await expect(first.getByTestId('log-reply-form')).toBeVisible();
  await first.getByLabel(/^Antwort von /).fill('Hallo, danke für die Nachricht – erzählen Sie mehr!');
  const saved = page.waitForResponse((response) => /\/api\/leads\/[^/]+\/events$/.test(response.url()) && response.request().method() === 'POST');
  await first.getByTestId('log-reply-submit').click();
  expect((await saved).ok()).toBe(true);
  expect((await findLead(page, 'nick', name)).stage).toBe('replied');

  // Antwort-Karte: Termin mit einem Klick eintragen.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('start-reply')).toContainText('4');
  await page.getByTestId('start-reply').click();
  const reply = currentCard(page);
  await expect(reply).toHaveAttribute('data-card-type', 'reply');
  const replyName = (await reply.getByTestId('lead-name').textContent())!;
  await expect(reply.getByTestId('reply-meeting')).toBeEnabled();
  const booked = page.waitForResponse((response) => /\/api\/leads\/[^/]+\/events$/.test(response.url()) && response.request().method() === 'POST');
  await reply.getByTestId('reply-meeting').click();
  expect((await booked).ok()).toBe(true);
  expect((await findLead(page, 'nick', replyName)).stage).toBe('meeting');
  expect(errors).toEqual([]);
});

test('Lead-Panel: Anfrage gesendet und Nachricht gesendet eintragen – auch außerhalb des Tagesstapels', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await page.getByTestId('nav-leads').click();
  await page.getByRole('tab', { name: 'Meine' }).click();
  const board = page.getByTestId('leads-board');

  const fresh = board.getByTestId('column-new').getByTestId('board-card').first();
  const freshName = (await fresh.locator('span.truncate').first().textContent())!.trim();
  await fresh.click();
  const panel = page.getByRole('dialog');
  await panel.getByTestId('action-invite-sent').click();
  await expect(panel.getByTestId('action-invite-sent')).toHaveCount(0);
  await expect(panel).toContainText('Vernetzungsanfrage gesendet');
  expect((await findLead(page, 'nick', freshName)).stage).toBe('invited');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await board.getByTestId('column-connected').getByTestId('board-card').first().click();
  const actions = page.getByRole('dialog');
  await actions.getByTestId('action-form-message').click();
  await actions.getByTestId('action-text').fill('Hallo, kurze Frage zu euren Projekten …');
  await actions.getByRole('button', { name: 'Nachricht eintragen' }).click();
  await expect(page.getByRole('dialog')).toContainText('Hallo, kurze Frage zu euren Projekten');
  // Follow-ups gehen weiter: jetzt unter „Mehr“, Haupt-Aktion ist die Antwort
  await expect(actions.getByTestId('action-form-reply')).toBeVisible();
  await actions.getByTestId('footer-more').click();
  await expect(actions.getByTestId('action-form-message')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Board: frei nach „Termin“ ziehen (auch ohne „Vernetzt“); Chats: verloren → nur Antwort eintragen, wieder öffnen', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  // Ein Lead in „Anfrage gesendet“ (Spalte bleibt neben „Termin“ sichtbar).
  const listed = (await (await page.request.get('/api/leads?owner=nick&stage=new&limit=1')).json()) as { leads: { id: string }[] };
  await act(page, listed.leads[0].id, { action: 'invite_sent' });
  await page.getByTestId('nav-leads').click();
  const board = page.getByTestId('leads-board');
  await expect(board.getByTestId('column-invited').getByTestId('board-card')).toHaveCount(1);
  // Ziehen per Ereignis (die Spalten liegen auf 1440 px nicht zugleich im Bild).
  await page.evaluate(`(() => {
    const source = document.querySelector('[data-testid=column-invited] [data-testid=board-card]');
    const target = document.querySelector('[data-testid=column-meeting]');
    const data = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  })()`);
  // Seit 19.10. (Wunsch des Nutzers) frei verschiebbar: nur die Stufe ändert sich.
  await expect(board.getByTestId('column-invited').getByTestId('board-card')).toHaveCount(0);
  await expect(board.getByTestId('column-meeting').getByTestId('board-card')).not.toHaveCount(0);
  expect(((await (await page.request.get(`/api/leads/${listed.leads[0].id}`)).json()) as { lead: { stage: string } }).lead.stage).toBe('meeting');

  // Chats: verlorener Lead – keine eigene Nachricht (das Backend lehnt sie ab), Antwort eintragen geht.
  const ralf = await findLead(page, 'nick', 'Ralf Ostermann');
  if (ralf.stage !== 'lost') await act(page, ralf.id, { action: 'lost' });
  await page.getByTestId('nav-chats').click();
  await page.getByTestId('chats-search').fill('Ostermann');
  await page.getByTestId('chat-item').first().click();
  await expect(page.getByTestId('chat-closed')).toContainText('Als verloren markiert');
  await expect(page.getByRole('tab', { name: /Nachricht senden|Meine Nachricht/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Antwort von Ralf' })).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('chat-reopen').click();
  await expect(page.getByTestId('chat-closed')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Nachricht senden|Meine Nachricht/ })).toBeVisible();
  expect((await findLead(page, 'nick', 'Ralf Ostermann')).stage).not.toBe('lost');
  expect(errors).toEqual([]);
});

test('Board: viele neue Leads verdrängen die übrigen Stufen nicht', async ({ page }) => {
  await login(page);
  const requests: string[] = [];
  await page.route(/\/api\/leads\?/, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.searchParams.get('stage') ?? '');
    const response = await route.fetch();
    const body = (await response.json()) as { leads: unknown[]; total: number };
    // „Neu“ hätte 1234 Treffer – die übrigen Stufen kommen aus einer eigenen Abfrage.
    await route.fulfill({ response, json: url.searchParams.get('stage') === 'new' ? { ...body, total: 1234 } : body });
  });
  await page.getByTestId('nav-leads').click();
  await expect(page.getByTestId('leads-limit')).toBeVisible();
  await expect(page.getByTestId('leads-board').getByTestId('column-replied').getByTestId('board-card').first()).toBeVisible();
  expect(requests).toContain('new');
  expect(requests.some((stage) => stage.includes('replied') && !stage.split(',').includes('new'))).toBe(true);
});

test('Angefangene Antwort: im Lead-Panel als gesendet eingetragen → die nächste Antwort-Karte ist leer', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await page.getByTestId('start-reply').click();
  const card = currentCard(page);
  await expect(card).toHaveAttribute('data-card-type', 'reply');
  const name = (await card.getByTestId('lead-name').textContent())!;
  const typed = 'Gern, wie wäre Donnerstag um 10?';
  await card.getByTestId('reply-answer').locator('textarea').fill(typed);

  // Stattdessen direkt auf LinkedIn geschrieben und im Lead-Panel eingetragen.
  await card.getByTestId('lead-name').click();
  const actions = page.getByRole('dialog');
  await actions.getByTestId('footer-more').click();
  await actions.getByTestId('action-form-message').click();
  await actions.getByTestId('action-text').fill(typed);
  const saved = page.waitForResponse((response) => /\/api\/leads\/[^/]+\/events$/.test(response.url()) && response.request().method() === 'POST');
  await actions.getByRole('button', { name: 'Nachricht eintragen' }).click();
  expect((await saved).ok()).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Der Lead schreibt noch einmal: die neue Antwort-Karte übernimmt den schon gesendeten Text nicht.
  const lead = await findLead(page, 'nick', name);
  await act(page, lead.id, { action: 'message_received', text: 'Passt, bis Donnerstag!' });
  await refreshStack(page);
  await page.getByTestId('stale-next').click();
  const next = currentCard(page);
  await expect(next).toHaveAttribute('data-card-type', 'reply');
  await expect(next.getByTestId('lead-name')).toHaveText(name);
  await expect(next.getByTestId('reply-answer').locator('textarea')).not.toHaveValue(typed);
  expect(errors).toEqual([]);
});

test('Angefangene Antwort: Termin eingetragen und rückgängig gemacht → der Text ist noch da', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'ping=off&undo=5');
  await page.getByTestId('start-reply').click();
  const card = currentCard(page);
  await expect(card).toHaveAttribute('data-card-type', 'reply');
  const name = (await card.getByTestId('lead-name').textContent())!;
  const typed = 'Danke, ich melde mich gleich mit einem Termin.';
  await card.getByTestId('reply-answer').locator('textarea').fill(typed);
  await expect(card.getByTestId('reply-meeting')).toBeEnabled();
  await card.getByTestId('reply-meeting').click();
  await expect(page.getByTestId('progress')).toContainText('1 von');
  await page.keyboard.press('z');
  await expect(page.getByTestId('progress')).toContainText('0 von');
  await expect(currentCard(page).getByTestId('lead-name')).toHaveText(name);
  // Karte neu aufbauen (zur Startseite und zurück): der Text kommt aus dem gemerkten Entwurf.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByTestId('start-reply').click();
  const back = currentCard(page);
  await expect(back.getByTestId('lead-name')).toHaveText(name);
  await expect(back.getByTestId('reply-answer').locator('textarea')).toHaveValue(typed);
  expect(errors).toEqual([]);
});

test('Termin schon in einem anderen Tab eingetragen: das 409 gilt als gespeichert', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 409\b/.test(text));
  await login(page);
  await page.getByTestId('start-reply').click();
  const card = currentCard(page);
  await expect(card.getByTestId('reply-meeting')).toBeEnabled();
  const name = (await card.getByTestId('lead-name').textContent())!;
  const lead = await findLead(page, 'nick', name);
  // Kurz bevor dieser Tab speichert, trägt ein anderer Tab denselben Termin ein.
  await page.route(new RegExp(`/api/leads/${lead.id}/events$`), async (route) => {
    if (route.request().method() === 'POST') await act(page, lead.id, { action: 'meeting_booked' });
    await route.continue();
  });
  const answered = page.waitForResponse((response) => response.url().endsWith(`/api/leads/${lead.id}/events`) && response.request().method() === 'POST');
  await card.getByTestId('reply-meeting').click();
  expect((await answered).status()).toBe(409);
  await expect(page.getByTestId('progress')).toContainText('1 von');
  // Kein „Nicht gespeichert“ – der Lead steht ja schon in „Termin“.
  await page.waitForTimeout(500);
  await expect(page.getByText(/Nicht gespeichert/)).toHaveCount(0);
  expect((await findLead(page, 'nick', name)).stage).toBe('meeting');
  expect(errors).toEqual([]);
});
