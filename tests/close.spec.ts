import { expect, test, type Page } from '@playwright/test';
import { findLead, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Übergabe an Close (`shared/crm.ts`) und Einschätzung der Antwort (`lead.conversation`, `shared/messages.ts`) gegen das
 * Mock-Backend. In der Simulation legt das Backend den Lead „in Close“ an, ohne Netz (`mock-close-…`).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

interface CrmLead {
  stage: string;
  crm?: { externalId: string; url: string | null } | null;
}

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();

/** Startet den Stapel – die erste Aufgabe ist eine Antwort. Gibt den Namen zurück. */
async function openFirstReply(page: Page) {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-focus').click();
  const card = currentCard(page);
  await expect(card).toHaveAttribute('data-card-type', 'reply');
  await expect(card.getByRole('button', { name: 'Kein Interesse' })).toBeEnabled();
  return (await card.getByTestId('lead-name').textContent())!.trim();
}

test('Antwort-Karte: Einschätzung sichtbar, Übergabe legt den Lead in Close an', async ({ page }) => {
  const errors = trackErrors(page);
  const name = await openFirstReply(page);
  const card = currentCard(page);

  // Einschätzung der Antwort und Zusammenfassung des Verlaufs (Demo-Leads mit Antwort haben sie schon)
  const assessment = card.getByTestId('reply-assessment');
  await expect(assessment).toBeVisible();
  await expect(assessment.getByTestId('reply-intent')).toHaveText(/\S/);

  const handover = page.waitForRequest((request) => request.url().endsWith('/handover') && request.method() === 'POST');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('an Close übergeben');
  await expect(dialog).not.toContainText('Simulation');
  await expect(dialog.getByRole('button', { name: 'Angaben kopieren' })).toHaveCount(0);
  await dialog.getByTestId('close-note').fill('Termin Do. 10 Uhr');
  // Im Notizfeld macht ↵ eine neue Zeile – ⌘↵ bzw. Strg+↵ übergibt.
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0);

  const body = (await handover).postDataJSON() as { note?: string; clientId?: string };
  expect(body.note).toBe('Termin Do. 10 Uhr');
  expect(body.clientId).toBeTruthy();

  await expect.poll(async () => ((await findLead(page, 'nick', name)) as CrmLead).crm?.externalId ?? '', { timeout: 15_000 }).toMatch(/^mock-close-/);
  expect(((await findLead(page, 'nick', name)) as CrmLead).stage).toBe('handed_over');
  expect(errors).toEqual([]);
});

test('Ohne Close-Schlüssel: Angaben kopieren und die Übergabe nur eintragen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.route('**/api/crm/status', (route) => route.fulfill({ json: { provider: 'close', mode: 'off' } }));
  let handoverCalls = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/handover')) handoverCalls += 1;
  });
  const name = await openFirstReply(page);

  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('close-export-hint')).toContainText('Close ist noch nicht angebunden');
  await expect(dialog.getByRole('button', { name: 'Angaben kopieren' })).toBeVisible();
  // Auch ohne Close kann man selbst etwas dazuschreiben – die Notiz landet im Verlauf.
  await dialog.getByTestId('close-note').fill('Termin Do. 10 Uhr');
  await dialog.getByTestId('close-export-confirm').click();

  await expect.poll(async () => (await findLead(page, 'nick', name)).stage, { timeout: 15_000 }).toBe('handed_over');
  expect(((await findLead(page, 'nick', name)) as CrmLead).crm ?? null).toBeNull();
  expect(handoverCalls).toBe(0);
  expect(errors).toEqual([]);
});

test('Lead-Panel: Gespräch sehen und an Close übergeben', async ({ page }) => {
  const errors = trackErrors(page);
  const name = await openFirstReply(page);
  await currentCard(page).getByTitle('Lead-Historie öffnen').click();
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText(name);
  await expect(panel.getByTestId('panel-conversation')).toBeVisible();

  // Übergabe steht unter „Mehr“ (Haupt-Aktion nach einer Antwort ist der Termin)
  await panel.getByTestId('footer-more').click();
  await panel.getByTestId('action-form-handover').click();
  await panel.getByTestId('action-text').fill('Will ein Angebot bis Freitag');
  await panel.getByTestId('action-submit').click();

  await expect(panel.getByTestId('crm-link')).toContainText('mock-close-');
  await expect(panel).toContainText('An Close übergeben');
  expect((await findLead(page, 'nick', name)).stage).toBe('handed_over');
  expect(errors).toEqual([]);
});

test('Übergabe an Close ausgeschaltet (Einstellung, 22.10.): kein „An Close übergeben“ – ↵ trägt den Termin ein', async ({ page }) => {
  const errors = trackErrors(page);
  await page.route('**/api/crm/status', (route) => route.fulfill({ json: { provider: 'close', mode: 'mock', handover: false } }));
  let handoverCalls = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/handover')) handoverCalls += 1;
  });
  const name = await openFirstReply(page);
  const card = currentCard(page);
  await expect(card.getByRole('button', { name: /An Close übergeben|Nach Close/ })).toHaveCount(0);
  await expect(card.getByTestId('reply-primary')).toContainText('Termin vereinbart');
  // Der Termin ist jetzt die Haupt-Aktion – nicht noch einmal als kleiner Knopf.
  await expect(card.getByTestId('reply-meeting')).toHaveCount(0);
  await expect(card.getByTestId('step-rail')).not.toContainText('Übergabe');

  // Lead-Panel: unter „Mehr“ keine Übergabe.
  await card.getByTitle('Lead-Historie öffnen').click();
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText(name);
  await panel.getByTestId('footer-more').click();
  await expect(panel.getByTestId('action-form-handover')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await findLead(page, 'nick', name)).stage, { timeout: 15_000 }).toBe('meeting');
  expect(handoverCalls).toBe(0);
  expect(errors).toEqual([]);
});
