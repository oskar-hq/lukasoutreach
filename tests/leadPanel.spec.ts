import { expect, test, type Page } from '@playwright/test';
import { findLead, resetCockpit, settledBox, signIn, trackErrors } from './helpers';

/**
 * Lead-Panel gegen das Mock-Backend: Score-Karte, Firmendaten holen (`POST /api/leads/:id/enrich`) und von Hand
 * eintragen (`POST /api/leads/:id/events`, `PATCH /api/leads/:id`). Neue Leads sind in der Simulation noch nicht
 * angereichert – der erste neue Lead von Nick ist Henrik Saalfeld.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

async function openFirstNewLead(page: Page) {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(page.locator('[data-testid=stack-card]').last().getByTestId('lead-name')).toHaveText('Henrik Saalfeld');
  await page.getByTitle('Lead-Historie öffnen').click();
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText('Henrik Saalfeld');
  return panel;
}

test('Lead-Panel: Score, Firmendaten holen, Notiz und nächster Schritt', async ({ page }) => {
  const errors = trackErrors(page);
  const panel = await openFirstNewLead(page);

  // Score oben als Chip, Teile im Reiter „Analyse“
  const score = panel.getByTestId('score-card');
  await expect(score.getByTestId('score-total')).toHaveText(/^\d{1,3}$/);
  await expect(panel.getByTestId('status-stage')).toHaveText('Neu');
  await panel.getByTestId('lead-tab-analysis').click();
  await expect(panel.getByTestId('hard-filters')).toContainText('Hard-Filter');
  await expect(panel.getByTestId('score-details')).toBeVisible();

  // Firmendaten: neutral beschriftet, Ergebnis aus der Simulation
  const company = panel.getByTestId('company-data');
  await company.getByRole('button', { name: 'Firmendaten holen' }).click();
  await expect(company).toContainText('Mitarbeiter', { timeout: 10_000 });
  await expect(company).toContainText('Beispieldaten');
  await expect(company.getByRole('button', { name: 'Firmendaten holen' })).toHaveCount(0);
  await expect(panel).toContainText('Firmendaten ergänzt');

  // Notiz über die Leiste unten – danach steht sie oben im Verlauf
  await panel.getByTestId('footer-note').click();
  await panel.getByTestId('action-text').fill('Hat auf der Messe Interesse gezeigt.');
  await panel.getByRole('button', { name: 'Notiz speichern' }).click();
  await expect(panel.getByTestId('lead-tabpanel-history')).toBeVisible();
  await expect(panel.getByTestId('timeline').locator('li').first()).toContainText('Hat auf der Messe Interesse gezeigt.');

  // Nächster Schritt im Sheet: Esc verwirft (Panel bleibt offen), ↵ speichert
  await panel.getByTestId('lead-tab-overview').click();
  await panel.getByTestId('next-step').click();
  await panel.getByRole('textbox', { name: 'Nächster Schritt' }).fill('Verworfen');
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('panel-sheet')).toHaveCount(0);
  await expect(panel.getByTestId('next-step')).toContainText('noch keiner');
  await panel.getByTestId('next-step').click();
  await panel.getByRole('textbox', { name: 'Nächster Schritt' }).fill('Nach der Anfrage Termin vorschlagen');
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('next-step')).toContainText('Nach der Anfrage Termin vorschlagen');

  // Wirklich gespeichert
  const lead = (await findLead(page, 'nick', 'Henrik Saalfeld')) as { nextStep?: string | null; enrichment?: { status: string } | null };
  expect(lead.nextStep).toBe('Nach der Anfrage Termin vorschlagen');
  expect(lead.enrichment?.status).toBe('done');

  // Aus der Stufe „Neu“ gehen Antwort und Termin noch nicht – auch nicht unter „Mehr“
  await panel.getByTestId('footer-more').click();
  await expect(panel.getByTestId('panel-sheet')).not.toContainText('Anfrage angenommen');
  await expect(panel.getByTestId('action-form-reply')).toHaveCount(0);
  await expect(panel.getByTestId('action-form-meeting')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Lead-Panel: an den anderen Gründer übergeben und als verloren eintragen', async ({ page }) => {
  const errors = trackErrors(page);
  const panel = await openFirstNewLead(page);

  await panel.getByTestId('footer-more').click();
  await panel.getByTestId('action-owner').click();
  await expect(panel.getByTestId('owner')).toContainText('Johannes');
  expect((await findLead(page, 'johannes', 'Henrik Saalfeld')).stage).toBe('new');

  await panel.getByTestId('footer-more').click();
  await panel.getByTestId('action-form-lost').click();
  await panel.getByTestId('action-text').fill('Passt doch nicht');
  await panel.getByRole('button', { name: 'Als verloren eintragen' }).click();
  await expect(panel).toContainText('Passt doch nicht');
  await expect(panel.getByTestId('status-stage')).toHaveText('Verloren');
  expect((await findLead(page, 'johannes', 'Henrik Saalfeld')).stage).toBe('lost');

  // „Verloren“ ist nicht endgültig: wieder öffnen (unten statt der Haupt-Aktion) – ohne Anfrage zurück nach „Neu“.
  await panel.getByTestId('action-reopen').click();
  await expect(panel.getByTestId('action-reopen')).toHaveCount(0);
  await expect(panel.getByTestId('action-invite-sent')).toBeVisible();
  expect((await findLead(page, 'johannes', 'Henrik Saalfeld')).stage).toBe('new');

  // Zurück im Stapel: die Karte ist nicht mehr Nicks Aufgabe
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('stale-card').or(page.locator('[data-testid=stack-card]').last())).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('Touch', () => {
  test.use({ hasTouch: true });

  test('Lead-Panel: mit dem Finger nach rechts wegwischen schließt, kurzer Zug federt zurück', async ({ page }) => {
    const panel = await openFirstNewLead(page);
    const box = await settledBox(panel);
    // Auf der Statuskarte (Text, keine Knöpfe oder Links – die nehmen den Wisch nicht an).
    const card = (await panel.getByTestId('status-card').boundingBox())!;
    const y = card.y + card.height - 16;
    const startX = box.x + 60;
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (distance: number, steps: number, holdMs = 0) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + (distance * i) / steps, y }] });
      }
      if (holdMs) await page.waitForTimeout(holdMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    // Kurz und langsam: bleibt offen und kehrt an seinen Platz zurück.
    await swipe(30, 6, 150);
    await expect(panel).toBeVisible();
    expect((await settledBox(panel)).x).toBeCloseTo(box.x, 0);

    // Weit nach rechts: schließt.
    await swipe(260, 8);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test('Lead-Panel: Deal Value und Meta-Ads von Hand – Dashboard zeigt den offenen Deal Value', async ({ page }) => {
  const errors = trackErrors(page);
  const panel = await openFirstNewLead(page);
  const actions = panel;

  // Deal Value: „25.000“ wird zu 25000 €
  await expect(actions.getByTestId('deal-value')).toContainText('noch keiner');
  await actions.getByTestId('deal-value').click();
  await actions.getByTestId('deal-value-input').fill('25.000');
  await page.keyboard.press('Enter');
  await expect(actions.getByTestId('deal-value')).toContainText('25.000 €');
  await expect(panel).toContainText('Deal Value: 25.000 €');

  // Meta-Ads: „Aus“ seit einem Datum → Reactivation, mit Dauer
  await actions.getByTestId('meta-ads').click();
  await actions.getByTestId('meta-ads-stopped').click();
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await actions.getByTestId('meta-ads-since').fill(since);
  await expect(actions.getByTestId('meta-ads-form')).toContainText('seit rund 4 Monaten');
  await actions.getByTestId('meta-ads-save').click();
  await expect(actions.getByTestId('meta-ads')).toContainText(/aus seit \d{2}\.\d{2}\.\d{4} · vor rund 4 Monaten · von Hand/);
  const lead = (await findLead(page, 'nick', 'Henrik Saalfeld')) as { dealValue?: number | null; metaAds?: { state: string; manual?: boolean } | null; score?: { leadType: string } | null };
  expect(lead.dealValue).toBe(25000);
  expect(lead.metaAds?.state).toBe('stopped');
  expect(lead.score?.leadType).toBe('reactivation');

  // Dashboard: offener Deal Value (Esc schließt das Panel, dann den Fokus-Modus)
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('deal-value-total')).toHaveText(/25\.000\s€/);
  await expect(page.getByTestId('deal-value-new')).toContainText('25.000');
  // KI-Kosten gegen den offenen Deal Value (Simulation: Beispielwerte der letzten 21 Tage).
  await page.getByTestId('dashboard-more').click();
  const aiCost = page.getByTestId('ai-cost-section');
  await expect(aiCost).toBeVisible();
  await expect(page.getByTestId('ai-cost-total')).toHaveText(/^\d+,\d{2}\s€$/);
  await expect(page.getByTestId('ai-cost-deal-value')).toHaveText(/25\.000\s€/);
  await expect(page.getByTestId('ai-cost-ratio')).toContainText('Der offene Deal Value deckt die KI-Kosten');
  // Durchschnitt je qualifiziertem Lead (Simulation: Demo-Leads), je Abschluss noch keiner übergeben.
  await expect(page.getByTestId('ai-cost-per-lead')).toHaveText(/^\d+,\d{2}\s€$/);
  await expect(page.getByTestId('ai-cost-per-closed')).toHaveText('–');
  await expect(page.getByTestId('ai-cost-section')).toContainText('noch keiner übergeben');
  await expect(page.getByTestId('ai-cost-qualify')).toContainText('Einstufung der Profile');
  expect(errors).toEqual([]);
});

test('Lead-Panel per Tastatur: Reiter 1–3/V, M und N öffnen Sheets, Esc schließt erst das Sheet, ↵ ist die Haupt-Aktion', async ({ page }) => {
  const errors = trackErrors(page);
  const panel = await openFirstNewLead(page);

  await page.keyboard.press('3');
  await expect(panel.getByTestId('lead-tabpanel-analysis')).toBeVisible();
  await page.keyboard.press('v');
  await expect(panel.getByTestId('lead-tabpanel-history')).toBeVisible();
  await page.keyboard.press('1');
  await expect(panel.getByTestId('lead-tabpanel-overview')).toBeVisible();

  await page.keyboard.press('m');
  await expect(panel.getByTestId('panel-sheet')).toContainText('Weitere Aktionen');
  await page.keyboard.press('Escape');
  await expect(panel.getByTestId('panel-sheet')).toHaveCount(0);
  await expect(panel).toBeVisible();

  // N: Notiz, ↵ im Textfeld ist ein Zeilenumbruch, ⌘↵/Strg+↵ speichert.
  await page.keyboard.press('n');
  await expect(panel.getByTestId('action-text')).toBeFocused();
  await page.keyboard.type('Per Tastatur');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(panel.getByTestId('panel-sheet')).toHaveCount(0);
  await expect(panel.getByTestId('timeline').locator('li').first()).toContainText('Per Tastatur');

  // ↵: Haupt-Aktion der Stufe „Neu“ → Anfrage gesendet.
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('status-stage')).toHaveText('Anfrage gesendet');
  expect((await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('invited');
  expect(errors).toEqual([]);
});
