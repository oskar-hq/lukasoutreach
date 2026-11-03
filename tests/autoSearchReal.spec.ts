import { expect, test } from '@playwright/test';
import type { AutoSearchListResponse } from '../shared/autoSearch';
import { resetCockpit, signIn, trackErrors, gotoSettings, openSettingsSection } from './helpers';

/**
 * Automatische Lead-Suche ohne Nachbau gegen das Mock-Backend: Plan speichern, „Jetzt einmal ausführen“,
 * die gefundenen Leads stehen danach im Tagesstapel – gebucht mit „von Automatische Suche“.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

test('Plan speichern, jetzt ausführen, neue Leads landen im Tagesstapel', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText('14');
  await page.getByTestId('home-details-toggle').click();
  await expect(page.getByTestId('home-auto-search')).toHaveCount(0);

  await gotoSettings(page);
  await openSettingsSection(page, 'auto');
  await expect(page.getByTestId('auto-search')).toBeVisible();
  await page.getByTestId('auto-enabled').click();
  await page.getByTestId('auto-profile-toggle').click();
  await page.getByTestId('auto-max-results-input').fill('10');
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-next')).not.toHaveText('Aus');

  const before = (await (await page.request.get('/api/auto-search')).json()) as AutoSearchListResponse;
  expect(before.schedules.map((entry) => entry.founder)).toEqual(['nick']);
  expect(before.schedules[0].enabled).toBe(true);
  expect(before.schedules[0].profile.maxResults).toBe(10);

  await page.getByTestId('auto-run').click();
  await expect(page.getByTestId('auto-status')).toContainText('Läuft gerade', { timeout: 10_000 });
  await expect(page.getByTestId('auto-last')).toContainText('neue Leads', { timeout: 120_000 });
  const after = (await (await page.request.get('/api/auto-search')).json()) as AutoSearchListResponse;
  const last = after.schedules[0].lastRun!;
  expect(last.status).toBe('done');
  expect(last.manual).toBe(true);
  expect(last.created).toBeGreaterThan(0);

  // Startseite: Hinweis auf den nächsten Lauf, die neuen Leads zählen mit.
  await page.getByTestId('nav-home').click();
  await page.getByTestId('home-details-toggle').click();
  await expect(page.getByTestId('home-auto-search')).toContainText('nächster Lauf');
  await page.reload();
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText(String(14 + last.created));

  // Im Verlauf eines neuen Leads steht, wer ihn angelegt hat.
  const leads = (await (await page.request.get('/api/leads?owner=nick&limit=2000')).json()) as {
    leads: { id: string; source?: string; createdAt: number }[];
  };
  const newest = [...leads.leads].sort((a, b) => b.createdAt - a.createdAt)[0];
  const detail = (await (await page.request.get(`/api/leads/${newest.id}`)).json()) as { events: { kind: string; actor?: string | null }[] };
  expect(detail.events.find((event) => event.kind === 'created')?.actor).toBe('Automatische Suche');
  expect(errors).toEqual([]);
});

test('Mitarbeiter: kein Zugriff auf die automatische Suche, auch nicht per API', async ({ page }) => {
  await page.goto('/?ping=off');
  await signIn(page, 'mitarbeiter');
  await page.getByTestId('home-details-toggle').click();
  await expect(page.getByTestId('home-auto-search')).toHaveCount(0);
  expect((await page.request.get('/api/auto-search')).status()).toBe(403);
  expect((await page.request.post('/api/auto-search/nick/run')).status()).toBe(403);
});

test('⌘↵ übernimmt ein gerade getipptes Stichwort, Region wird am Feld geprüft', async ({ page }) => {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await gotoSettings(page);
  await openSettingsSection(page, 'auto');
  await expect(page.getByTestId('auto-search')).toBeVisible();

  // Region zu kurz: Meldung am Feld Region, Fokus dort.
  await page.getByTestId('auto-profile-toggle').click();
  await page.getByTestId('auto-region').fill('X');
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-region')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('auto-region')).toBeFocused();
  await page.getByTestId('auto-region').fill('Bayern');

  // Stichwort tippen und direkt mit ⌘/Strg+↵ speichern – es darf nicht verloren gehen.
  await page.getByTestId('auto-keywords').getByRole('textbox').fill('Bäckerei');
  await page.keyboard.press('ControlOrMeta+Enter');
  // Gespeichert wird nach dem Neuzeichnen – auf die Antwort warten statt sofort nachzusehen.
  const saved = async () => ((await (await page.request.get('/api/auto-search')).json()) as AutoSearchListResponse).schedules[0].profile;
  await expect.poll(async () => (await saved()).keywords).toContain('Bäckerei');
  expect((await saved()).region).toBe('Bayern');
});
