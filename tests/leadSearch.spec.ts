import { expect, test, type Page } from '@playwright/test';
import { signIn, trackErrors, resetCockpit } from './helpers';

/** Jeder Test beginnt mit den 30 Demo-Leads (alle Tests teilen sich ein Mock-Backend). */
test.beforeEach(async ({ request }) => resetCockpit(request));

async function openLeadSearch(page: Page) {
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-search').click();
  await expect(page.getByTestId('start-search')).toBeEnabled();
}

/** „Suche starten“ (↵) öffnet den Dialog mit den Einstellungen, ↵ dort startet. */
async function startFromSheet(page: Page) {
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('search-start-sheet')).toBeVisible();
  await expect(page.getByTestId('start-search-confirm')).toBeEnabled();
  await page.keyboard.press('Enter');
}

async function runSearch(page: Page) {
  await startFromSheet(page);
  await expect(page.getByTestId('run-title')).toHaveText('Suche läuft …');
  await expect(page.getByTestId('live-list')).toBeVisible();
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
}

const funnel = (page: Page, key: string) => page.getByTestId(`funnel-${key}`).locator('span').first();

test('Lead-Suche: Lauf, Trichter, Ergebnis und Übergabe in den Tagesstapel', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  // Kein Modus-Schild mehr – die Software läuft immer echt.
  await expect(page.getByTestId('mode-hint')).toHaveCount(0);
  await expect(page.getByText(/Simulation|Beispieldaten/)).toHaveCount(0);

  // Eine Zeile fasst Region, Anzahl und Kontaktgrad zusammen – „Anpassen“ klappt die Felder auf.
  await expect(page.getByTestId('search-summary')).toContainText('Deutschland · 400 Treffer · 15 Profile · 2./3. Grad');
  await page.getByTestId('search-options-toggle').click();
  await expect(page.getByLabel('Region')).toHaveValue('Deutschland');

  // Profile pro Lauf: frei eintippbar, ohne feste 25er-Grenze (11.10.), höchstens 1000.
  const perRun = page.getByTestId('max-results-input');
  await expect(perRun).toHaveValue('15');
  await expect(page.getByTestId('max-results')).not.toContainText('von');
  await perRun.fill('200');
  await expect(page.getByTestId('search-summary')).toContainText('200 Profile');
  await perRun.fill('9999');
  await expect(page.getByTestId('search-summary')).toContainText('1000 Profile');
  await perRun.fill('15');
  await page.getByRole('button', { name: 'Mehr' }).click();
  await page.getByRole('button', { name: 'Weniger' }).click();
  await expect(perRun).toHaveValue('15');
  await expect(page.getByTestId('change-search-account')).toBeVisible();
  await expect(page.getByTestId('meta-ads-hint')).toContainText('aktive Meta-Ads werden markiert');

  await runSearch(page);
  // 7 qualifiziert, davon 2 mit aktiven Meta-Ads – Meta ist kein Ausschluss, nur der Aufhänger der Nachricht
  await expect(page.getByTestId('run-title')).toHaveText('7 neue Leads gefunden');
  await expect(funnel(page, 'found')).toHaveText('40');
  await expect(funnel(page, 'unique')).toHaveText('33');
  // KI-Vorprüfung anhand der Headline: Hausverwaltung und Makler fliegen ohne Profilabruf raus.
  await expect(funnel(page, 'screened')).toHaveText('31');
  await expect(page.getByTestId('funnel-enriched')).toContainText('Profil gelesen');
  await expect(funnel(page, 'enriched')).toHaveText('15');
  await expect(page.getByTestId('funnel-fit')).toHaveCount(0);
  await expect(funnel(page, 'qualified')).toHaveText('7');
  await expect(page.getByRole('tab', { name: /Schalten Meta-Ads\s*2/ })).toBeVisible();
  await expect(page.getByTestId('funnel-qualified')).toContainText('2 davon schalten gerade Meta-Ads');

  const rows = page.getByTestId('result-row');
  // Das Ergebnis öffnet bei den Qualifizierten, „Alle“ ist der letzte Reiter.
  await expect(page.getByRole('tab', { name: /^Qualifiziert/ })).toHaveAttribute('aria-selected', 'true');
  await expect(rows).toHaveCount(5);
  await page.getByRole('tab', { name: /^Alle/ }).click();
  await expect(rows).toHaveCount(40);
  await expect(rows.first()).toHaveAttribute('data-status', 'qualified');
  await expect(page.getByTestId('results')).toContainText('Bereits im Cockpit · Nick');
  await page.getByRole('tab', { name: /Schalten Meta-Ads/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-status', 'ads_active');
  await expect(rows.first()).toContainText(/Aktive Meta-Ads \(\d\) – von Hand prüfen/);
  await page.getByRole('tab', { name: /Qualifiziert/ }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId('results')).toContainText('Keine Meta-Ads gefunden');
  await expect(page.getByTestId('results')).toContainText('Meta-Ads beendet am');
  // Aussortiert: klarer Grund in der Liste, Erklärung beim Aufklappen (nicht nur „Makler“ oder „Sonstige“).
  await page.getByRole('tab', { name: /Aussortiert/ }).click();
  const wrongBranch = page.locator('[data-testid=result-row][data-status=rejected]').filter({ hasText: 'Falsche Branche' }).first();
  await wrongBranch.getByTestId('result-toggle').click();
  await expect(wrongBranch.getByTestId('lead-details')).toContainText('Warum aussortiert');
  await expect(wrongBranch.getByTestId('lead-details')).toContainText('Falsche Branche – gesucht sind nur Kapitalanlage-Vertriebe und Finanzdienstleister');
  // Von der KI-Vorprüfung aussortiert: Grund aus der Headline, kein Profil gelesen.
  await expect(page.locator('[data-testid=result-row][data-status=screened_out]')).toHaveCount(2);
  await expect(page.getByTestId('results')).toContainText('Vorprüfung: Maklerbüro – vermittelt fremde Objekte');
  await expect(page.getByTestId('rejected-summary')).toContainText('2 in der Vorprüfung aussortiert');
  await page.getByRole('tab', { name: /Alle/ }).click();

  // Der Server hat die Leads am Ende des Laufs gespeichert (Kundengespräch 25.10.) – ohne Klick, ohne Rückgängig-Frist.
  await expect(page.getByTestId('handoff-done')).toContainText('7 Leads liegen in deinem Tagesstapel');
  await expect(page.getByTestId('nav-home')).toContainText('21');
  await expect(page.getByTestId('handoff')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);

  // „Jetzt abarbeiten“ öffnet die neuen Leads im Fokus-Modus
  await page.keyboard.press('Enter');
  const card = page.locator('[data-testid=stack-card]').last();
  await expect(card).toHaveAttribute('data-card-type', 'lead');
  await expect(card).toContainText('Neuer Lead');
  await expect(card).toContainText('Henrik Vossberg');
  await expect(card).toContainText('Passt (Kapitalanlage-Vertrieb) · 94 %');
  // Hiring-Signal aus der Firmenbeschreibung (13.10.).
  await expect(card).toContainText('Keine Meta-Ads · Sucht: Vertriebsmitarbeiter (m/w/d) · 2. Grad');
  await expect(page.getByTestId('progress')).toHaveText('0 von 21 erledigt');
  const firstId = await card.getAttribute('data-card-id');
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-card-id="${firstId}"]`)).toHaveCount(0);
  await expect(page.getByTestId('progress')).toHaveText('1 von 21 erledigt');

  // Historie zeigt die Herkunft
  await page.getByTitle('Lead-Historie öffnen').click();
  await expect(page.getByRole('dialog')).toContainText('Über die Lead-Suche gefunden');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('zweiter Lauf: bereits geprüfte und übergebene Leads werden aussortiert', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  await runSearch(page);
  await expect(page.getByTestId('handoff-done')).toBeVisible();

  await page.getByTestId('new-search').click();
  await expect(page.getByTestId('start-search')).toBeEnabled();
  await runSearch(page);
  // 15 mit Profil geprüfte und 2 in der Vorprüfung aussortierte zählen jetzt als „bereits geprüft“.
  await expect(funnel(page, 'unique')).toHaveText('16');
  await expect(funnel(page, 'qualified')).toHaveText('5');
  await page.getByRole('tab', { name: /^Alle/ }).click();
  await expect(page.getByTestId('results')).toContainText('In einem früheren Lauf bereits geprüft');
  await expect(page.getByTestId('results')).toContainText('Einschätzung zu unsicher (52 %)');
  expect(errors).toEqual([]);
});

test('Abbrechen beendet den Lauf, das Ergebnis bleibt sichtbar', async ({ page }) => {
  await openLeadSearch(page);
  await startFromSheet(page);
  await expect(page.getByTestId('run-title')).toHaveText('Suche läuft …');
  await page.waitForTimeout(1200);
  await page.getByTestId('cancel-search').click();
  await expect(page.getByTestId('run-title')).toHaveText('Suche abgebrochen');
  await expect(page.getByTestId('results')).toBeVisible();
});

test('Neuladen gleich nach dem Lauf: Die Leads sind gespeichert und liegen im Tagesstapel', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  await runSearch(page);
  await expect(page.getByTestId('handoff-done')).toContainText('7 Leads liegen in deinem Tagesstapel');
  // Bisher gingen sie verloren, wenn man in den 60 s nach „In den Tagesstapel“ neu lud.
  await page.reload();
  await signIn(page, 'nick');
  await expect(page.getByTestId('nav-home')).toContainText('21');
  expect(errors).toEqual([]);
});

test('Neuladen während eines Laufs: die laufende Suche wird übernommen statt blockiert', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  await startFromSheet(page);
  await expect(page.getByTestId('run-title')).toHaveText('Suche läuft …');
  await page.reload();
  await signIn(page, 'nick');
  await page.getByTestId('nav-search').click();
  await page.getByTestId('start-search').click();
  await page.getByTestId('start-search-confirm').click();
  await expect(page.getByTestId('live-list').or(page.getByTestId('results'))).toBeVisible();
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('run-title')).toHaveText('7 neue Leads gefunden');
  expect(errors.filter((error) => !error.includes('409'))).toEqual([]);
});

test('Ergebnis: Details je Lead aufklappen', async ({ page }) => {
  await openLeadSearch(page);
  await page.getByTestId('search-options-toggle').click();
  await expect(page.getByTestId('tracking-row')).toContainText('Tracking-Liste hochladen');
  await runSearch(page);
  await page.getByTestId('result-toggle').first().click();
  const details = page.getByTestId('lead-details');
  await expect(details).toContainText('KI-Einschätzung');
  await expect(details).toContainText('Firmenbeschreibung');
  await expect(details).toContainText('KI-Zusammenfassung');
  await expect(page.getByTestId('profile-link')).toHaveAttribute('href', /linkedin\.com\/in\//);
  await expect(page.getByTestId('meta-ads-details')).toContainText(/Keine Meta-Ads gefunden|Beendet am/);
  await expect(page.getByTestId('ad-library-link')).toHaveAttribute('href', /^https:\/\/www\.facebook\.com\/ads\/library\/\?active_status=all&ad_type=all&country=DE/);
  await page.getByTestId('result-toggle').first().click();
  await expect(details).toHaveCount(0);
});

test('Aussortiert nennt die Gründe in einer Zeile', async ({ page }) => {
  await openLeadSearch(page);
  await runSearch(page);
  await expect(page.getByTestId('rejected-summary')).toHaveCount(0);
  await page.getByRole('tab', { name: /^Aussortiert/ }).click();
  await expect(page.getByTestId('rejected-summary')).toContainText('von der KI aussortiert');
  await expect(page.getByTestId('rejected-summary')).toContainText('Dubletten');
});

test('Nicht eingerichtet: Hinweis führt in die Einstellungen, nicht auf die Shell', async ({ page }) => {
  await page.route('**/api/lead-search/config*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, mode: 'live', ready: false, problems: ['Das Unipile-Token fehlt.'] } });
  });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await page.getByTestId('nav-search').click();
  const notice = page.getByRole('status').filter({ hasText: 'noch nicht eingerichtet' });
  await expect(notice).toContainText('Das Unipile-Token fehlt.');
  await expect(notice).not.toContainText('.env');
  await expect(page.getByTestId('start-search')).toBeDisabled();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-section-title')).toHaveText('Auf einen Blick');
  await expect(page.getByTestId('settings-overview')).toBeVisible();
});

test('Übergabe verteilt auf beide Gründer: Meldung nennt, wie viele bei wem gelandet sind', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  // Das Backend verteilt mit LEAD_DISTRIBUTION=balanced auf beide Gründer – schon beim Speichern am Ende des Laufs.
  const setDistribution = (value: string | null) =>
    page.evaluate(async (next) => {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: { LEAD_DISTRIBUTION: next } }),
      });
      return response.status;
    }, value);
  expect(await setDistribution('balanced')).toBe(200);
  try {
    await runSearch(page);
    // Wer den kleineren Rückstand hat, bekommt mehr – je nach Bestand alle oder ein Teil bei Johannes.
    await expect(page.getByTestId('handoff-done')).toContainText(/(\d+ Leads? bei dir, \d+|\d+ Leads?) bei Johannes/);
  } finally {
    // Aufräumen: Die Einstellung gilt für alle späteren Tests (gemeinsames Mock-Backend).
    expect(await setDistribution(null)).toBe(200);
  }
  expect(errors).toEqual([]);
});

test('Start-Dialog: Einstellungen der Lead-Suche direkt vor dem Start ändern, „Jetzt suchen“ speichert und startet', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  await page.getByTestId('start-search').click();
  const sheet = page.getByTestId('search-start-sheet');
  await expect(sheet).toBeVisible();
  // Erst nur der Satz, was der Lauf macht – die Werte liegen hinter „Anpassen“ (Wunsch des Nutzers 25.10.).
  await expect(page.getByTestId('sheet-settings')).toHaveCount(0);
  await page.getByTestId('sheet-adjust').click();
  await expect(page.getByTestId('sheet-search-hits-input')).toHaveValue('400');
  // Erklärung, was der Lauf mit den Zahlen macht (Simulation: keine Warteliste).
  await expect(page.getByTestId('sheet-run-plan-hits')).toHaveText('Bis zu 400 neue Treffer von LinkedIn.');
  const profiles = await page.getByTestId('sheet-max-results-input').inputValue();
  await page.getByTestId('sheet-search-hits-input').fill('20');
  await page.getByTestId('sheet-max-results-input').fill('50');
  await expect(page.getByTestId('sheet-run-plan-hits')).toHaveText('Bis zu 50 neue Treffer von LinkedIn.');
  await expect(page.getByTestId('sheet-run-plan-raised')).toBeVisible();
  await page.getByTestId('sheet-max-results-input').fill(profiles);
  // Esc schließt, ohne etwas zu ändern.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  await page.getByTestId('start-search').click();
  await page.getByTestId('sheet-adjust').click();
  await page.getByTestId('sheet-confidence-input').fill('50');
  await page.getByTestId('sheet-auto-qualify').fill('Bauträger, Wohnbau');
  await page.getByRole('tab', { name: 'Auf beide' }).click();
  await page.getByTestId('start-search-confirm').click();
  await expect(page.getByTestId('run-title')).toHaveText('Suche läuft …');

  const saved = await page.evaluate(async () => (await (await fetch('/api/settings')).json()) as { settings: Array<{ key: string; value: unknown }> });
  const value = (key: string) => saved.settings.find((entry) => entry.key === key)?.value;
  expect(value('QUALIFY_MIN_CONFIDENCE')).toBe(0.5);
  expect(value('AUTO_QUALIFY_TERMS')).toBe('Bauträger, Wohnbau');
  expect(value('LEAD_DISTRIBUTION')).toBe('balanced');
  expect(value('SEARCH_HITS_PER_RUN')).toBe(400);
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  // Aufräumen: Die Einstellungen gelten für alle späteren Tests (gemeinsames Mock-Backend).
  const reset = await page.evaluate(async () => {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: { QUALIFY_MIN_CONFIDENCE: null, AUTO_QUALIFY_TERMS: null, LEAD_DISTRIBUTION: null } }),
    });
    return response.status;
  });
  expect(reset).toBe(200);
  expect(errors).toEqual([]);
});

test('Von Hand qualifizieren: liegt sofort im Cockpit und zählt im Ergebnis mit; Spielstand', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  await runSearch(page);
  await expect(page.getByTestId('run-title')).toHaveText('7 neue Leads gefunden');

  // Spielstand: neue Leads, Preis je Lead, Trefferquote, Warteliste (ohne Tagesziel).
  await expect(page.getByTestId('run-score')).toBeVisible();
  await expect(page.getByTestId('score-leads-value')).toHaveText('+7');
  await expect(page.getByTestId('score-price-value')).toContainText('€');
  await expect(page.getByTestId('score-rate')).toContainText('7 von 40 Treffern');
  await expect(page.getByTestId('score-waiting-value')).toHaveText('16');

  // Aussortierte lassen sich von Hand qualifizieren – die Leads des Laufs sind schon gespeichert, der neue kommt dazu.
  const total = async () => ((await (await page.request.get('/api/leads?limit=1')).json()) as { total: number }).total;
  await expect(page.getByTestId('handoff-done')).toBeVisible();
  const before = await total();
  await page.getByRole('tab', { name: /^Aussortiert/ }).click();
  await expect(page.getByTestId('rejected-summary')).toContainText('Passt doch einer?');
  const rejected = page.locator('[data-testid="result-row"][data-status="rejected"]').first();
  // Erst das Profil ansehen können (15.10.): LinkedIn direkt neben „Qualifizieren“.
  await expect(rejected.getByTestId('qualify-profile-link')).toHaveAttribute('href', /linkedin\.com/);
  await rejected.getByTestId('qualify-manually').click();
  await expect(page.getByTestId('manual-placed')).toHaveText('1 Lead von Hand qualifiziert – liegt im Cockpit');
  expect(await total()).toBe(before + 1);
  await expect(page.getByTestId('run-title')).toHaveText('8 neue Leads gefunden');
  await expect(page.getByTestId('score-leads')).toContainText('1 davon von Hand');
  await page.getByRole('tab', { name: /^Qualifiziert/ }).click();
  await expect(page.getByTestId('results')).toContainText('Von Hand qualifiziert');
  // Dubletten haben keinen Knopf.
  await page.getByRole('tab', { name: /^Alle/ }).click();
  await expect(page.locator('[data-testid="result-row"][data-status="duplicate"]').first().getByTestId('qualify-manually')).toHaveCount(0);

  // Auch ohne Profilabruf (aus der Vorprüfung) sofort angelegt.
  await page.getByRole('tab', { name: /^Aussortiert/ }).click();
  await page.locator('[data-testid="result-row"][data-status="screened_out"]').first().getByTestId('qualify-manually').click();
  await expect(page.getByTestId('manual-placed')).toHaveText('2 Leads von Hand qualifiziert – liegen im Cockpit');
  expect(await total()).toBe(before + 2);
  expect(errors).toEqual([]);
});

test('Zielgruppe (27.10.): Dropdown mit Kapitalanlage, Finanzdienstleister oder beiden setzt das Preset, eigene Änderung = eigene Auswahl', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeadSearch(page);
  const select = page.getByTestId('audience-select');
  // Standard = beide Zielgruppen (Kapitalanlage-Vertriebe + Finanzdienstleister), keine Bauträger mehr zur Auswahl.
  await expect(select).toHaveValue('beide');
  await expect(select.locator('option')).toHaveText(['Beide Zielgruppen', 'Kapitalanlage-Vertriebe', 'Finanzdienstleister']);
  await expect(page.getByTestId('keywords')).toContainText('Finanzdienstleister');
  await expect(page.getByTestId('keywords')).not.toContainText('Bauträger');
  await select.selectOption('finanzdienstleister');
  await expect(page.getByTestId('keywords')).toContainText('Allfinanz');
  await expect(page.getByTestId('keywords')).not.toContainText('Kapitalanlage');
  await expect(page.getByTestId('positions')).toContainText('Geschäftsführer');
  await expect(page.getByTestId('positions')).not.toContainText('Vertriebsleiter');
  await expect(page.getByTestId('audience-hint')).toContainText('keine Einzelberater und keine Konzerne');
  await select.selectOption('kapitalanlage_vertrieb');
  await expect(page.getByTestId('keywords')).toContainText('Kapitalanlageimmobilien');
  // Eigene Änderung: Dropdown zeigt „Eigene Auswahl“.
  await page.getByTestId('keywords').locator('input').fill('Allfinanz');
  await page.getByTestId('keywords').locator('input').press('Enter');
  await expect(select).toHaveValue('');
  await expect(page.getByTestId('audience-hint')).toContainText('Eigene Auswahl');

  // Auch im Start-Dialog direkt wählbar – ohne „Anpassen“.
  await page.getByTestId('start-search').click();
  const sheetSelect = page.getByTestId('sheet-audience');
  await expect(sheetSelect).toBeVisible();
  await sheetSelect.selectOption('finanzdienstleister');
  await expect(sheetSelect).toHaveValue('finanzdienstleister');
  await page.keyboard.press('Escape');
  await expect(select).toHaveValue('finanzdienstleister');
  await expect(page.getByTestId('keywords')).toContainText('Finanzdienstleistungen');
  expect(errors).toEqual([]);
});

test('Start-Dialog auf dem Handy: Inhalt scrollt im Sheet, „Jetzt suchen“ bleibt sichtbar', async ({ page }) => {
  const errors = trackErrors(page);
  // Kleines Handy: der Dialog ist höher als der Bildschirm (Nutzer 13.10.: „man kommt nicht auf den Button“).
  await page.setViewportSize({ width: 375, height: 640 });
  await openLeadSearch(page);
  await page.getByTestId('start-search').click();
  await expect(page.getByTestId('sheet-run-plan')).toBeAttached();
  await page.getByTestId('sheet-adjust').click();
  await expect(page.getByTestId('start-search-confirm')).toBeInViewport({ ratio: 1 });
  const scroll = page.getByTestId('sheet-scroll');
  const overflow = await scroll.evaluate((el: { scrollHeight: number; clientHeight: number }) => el.scrollHeight > el.clientHeight);
  expect(overflow).toBe(true);
  // Scrollen bewegt den Inhalt des Sheets, der Knopf bleibt an seinem Platz.
  await scroll.hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => scroll.evaluate((el: { scrollTop: number }) => el.scrollTop)).toBeGreaterThan(0);
  // Der Satz zum Lauf steht seit 25.10. oben – unten erreicht man die letzte Einstellung.
  await expect(page.getByRole('tablist', { name: 'Neue Leads verteilen' })).toBeInViewport();
  await expect(page.getByTestId('start-search-confirm')).toBeInViewport({ ratio: 1 });
  await page.getByTestId('start-search-confirm').click();
  await expect(page.getByTestId('run-title')).toHaveText('Suche läuft …');
  expect(errors).toEqual([]);
});

test.describe('Touch', () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 640 } });

  test('Start-Dialog: mit dem Finger irgendwo im Sheet nach unten wischen schließt – erst, wenn der Inhalt oben ist', async ({ page }) => {
    // Nutzer 13.10.: „der graue Strich suggeriert, dass man das Fenster herunterwischen kann, aber das geht nicht“.
    await openLeadSearch(page);
    await page.getByTestId('start-search').click();
    const sheet = page.getByTestId('search-start-sheet');
    await expect(page.getByTestId('sheet-run-plan')).toBeAttached();
    await page.getByTestId('sheet-adjust').tap();
    const scroll = page.getByTestId('sheet-scroll');
    const box = (await scroll.boundingBox())!;
    const x = box.x + box.width / 2;
    const mid = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (fromY: number, distance: number, steps = 8) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] });
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: fromY + (distance * i) / steps }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const scrollTop = () => scroll.evaluate((el: { scrollTop: number }) => el.scrollTop);

    // Inhalt nicht oben (heruntergescrollt): nach unten wischen ist Scrollen, das Sheet bleibt an seinem Platz.
    await scroll.evaluate((el: { scrollTop: number }) => {
      el.scrollTop = 120;
    });
    await expect.poll(scrollTop).toBeGreaterThan(0);
    await swipe(mid - 100, 300);
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');

    // Kurz und am oberen Rand: federt zurück, bleibt offen.
    await scroll.evaluate((el: { scrollTop: number }) => {
      el.scrollTop = 0;
    });
    await swipe(mid - 100, 12, 3);
    await expect(sheet).toBeVisible();

    // Inhalt oben: nach unten wischen (mitten im Inhalt, nicht am Griff) schließt.
    await swipe(mid - 100, 300);
    await expect(sheet).toHaveCount(0);
  });
});
