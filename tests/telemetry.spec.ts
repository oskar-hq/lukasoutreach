import { expect, test } from '@playwright/test';
import { resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Nutzungsdaten (09.11., `shared/telemetry.ts`, `src/lib/telemetry.ts`): Ansichten, Klicks und Karten im Tagesstapel
 * kommen ohne Zutun im Nutzungs-Bericht an (`GET /api/telemetry/report`).
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

test('Klicks, Ansichten und Karten landen im Nutzungs-Bericht', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(page.locator('[data-testid=stack-card]').first()).toBeVisible();
  await page.getByRole('button', { name: /Beenden/ }).click();
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('dashboard-more')).toBeVisible();
  // Neu laden = Seite verlassen → das letzte Paket geht raus.
  await page.reload();
  await expect(page.getByTestId('home').or(page.getByTestId('nav-dashboard')).first()).toBeVisible();

  await expect
    .poll(async () => (await page.request.get('/api/telemetry/report?days=1')).text(), { timeout: 10_000 })
    .toMatch(/\| home \| start-lead \| \d+ \|/);
  const report = await (await page.request.get('/api/telemetry/report?days=1')).text();
  expect(report).toMatch(/## Ansichten[\s\S]*\| (home|focus|dashboard) \| \d+ \|/);
  expect(report).toMatch(/## Tagesstapel – Zeit je Karte[\s\S]*\| (lead|followup|first|reply) \| \d+ \|/);
  expect(report).toMatch(/\| nick \| /);
  expect(report).toMatch(/\| GET \| \/api\/tasks \| \d+ \|/);
  expect(errors).toEqual([]);
});

test('Wischen zählt als Ausgang der Karte (10.11.) – nicht mehr „ohne Aktion“', async ({ page }) => {
  const errors = trackErrors(page);
  // Direkt die gesendeten Ereignisse prüfen: Der Bericht zeigt je Kartentyp nur die häufigsten Ausgänge – nach den
  // anderen Tests stünde ein einzelnes „Wischen“ dort nicht sicher drin.
  const outcomes: string[] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/api/telemetry/events') || request.method() !== 'POST') return;
    try {
      const batch = request.postDataJSON() as { events?: { name: string; target: string | null; props?: { outcome?: string } }[] };
      for (const event of batch.events ?? []) if (event.name === 'card' && event.target === 'lead' && event.props?.outcome) outcomes.push(event.props.outcome);
    } catch {
      // kein JSON – egal
    }
  });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  const card = page.locator('[data-testid=stack-card]').last();
  const name = (await card.getByTestId('lead-name').textContent())!;
  const box = await card.getByTestId('lead-sentence').boundingBox();
  if (!box) throw new Error('Keine Fläche zum Wischen gefunden');
  // Weit nach links ziehen = „Nicht geeignet“ – ohne Klick auf einen Knopf, ohne Taste.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 320, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId('lead-name').filter({ hasText: name })).toHaveCount(0);
  // Fokus-Modus verlassen → die nächste Karte schließt ab, der Abschied der Seite schickt das Paket.
  await page.reload();
  await expect.poll(() => outcomes, { timeout: 10_000 }).toContain('Wischen links');
  expect(errors).toEqual([]);
});
