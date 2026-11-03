import { expect, test, type Page } from '@playwright/test';
import { fail, findLead, resetCockpit, signIn, trackErrors } from './helpers';

/**
 * Cockpit gegen das Mock-Backend: Tagesstapel aus `GET /api/tasks`, Verlauf aus `GET /api/leads/:id`,
 * Entscheidungen als `POST /api/leads/:id/events` (nach dem Rückgängig-Fenster). Vor jedem Test kommt die
 * Simulation zurück auf die 30 Demo-Leads – Reihenfolge laut Backend: Nick beginnt mit Ralf Ostermann,
 * Johannes mit Anja Reimers, neue Leads mit Henrik Saalfeld und Nadine Brückner.
 */
test.beforeEach(async ({ request }) => resetCockpit(request));

async function login(page: Page, founder: 'nick' | 'johannes', params = 'ping=off') {
  await page.goto(`/?${params}`);
  await signIn(page, founder);
}

/** Von der Startseite in den Fokus-Modus. */
async function startFocus(page: Page) {
  await page.getByTestId('start-focus').click();
  await expect(page.getByTestId('progress')).toBeVisible();
}

/** Entscheidungen gehen an `/events` oder – Vernetzen und Nachrichten in der Simulation – an `/linkedin/*`. */
const DECISION_ROUTES = /\/api\/leads\/[^/]+\/(events|linkedin\/)/;

const currentCard = (page: Page) => page.locator('[data-testid=stack-card]').last();
const currentName = (page: Page) => currentCard(page).getByTestId('lead-name');

/** Bearbeitet die aktuelle Aufgabe per Tastatur und wartet, bis die Seite gewechselt hat. */
async function processCurrentCard(page: Page, index: number) {
  const card = currentCard(page);
  const id = await card.getAttribute('data-card-id');
  const type = await card.getAttribute('data-card-type');
  const positive = index % 3 !== 2;

  switch (type) {
    case 'reply':
      // Erst entscheiden, wenn die Antwort geladen ist (vorher sind die Knöpfe gesperrt).
      await expect(card.getByText('Antwort erhalten')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Kein Interesse' })).toBeEnabled();
      if (positive) {
        // Enter öffnet die Close-Vorschau, ein zweites Enter übergibt
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog')).toContainText('an Close übergeben');
        await expect(page.getByTestId('close-export-confirm')).toBeEnabled();
        await page.keyboard.press('Enter');
      } else {
        await page.keyboard.press('ArrowLeft');
      }
      break;
    case 'followup':
      // Tasten gelten erst auf der fertigen Karte (vorher Platzhalter, bis Signal und Vorlagen da sind).
      await expect(card.getByRole('tablist', { name: 'Follow-up-Variante' })).toBeVisible();
      await page.keyboard.press('1');
      await page.keyboard.press(positive ? 'Enter' : 'ArrowLeft');
      break;
    case 'first':
      // Die Vorlage erscheint, sobald der Verlauf (Signal) geladen ist.
      await expect(card.getByRole('tablist', { name: 'Template wählen' })).toBeVisible();
      if (positive) {
        await page.keyboard.press('e');
        await page.keyboard.type(' PS: Kurzer Zusatz.');
        await page.keyboard.press('Control+Enter');
      } else {
        await page.keyboard.press('ArrowLeft');
      }
      break;
    default:
      await page.keyboard.press(positive ? 'Enter' : 'ArrowLeft');
  }
  await expect(page.locator(`[data-card-id="${id}"]`)).toHaveCount(0);
  return type;
}

test('Startseite zeigt nur die Aufgaben des Tages und einen Start-Button', async ({ page }) => {
  await login(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText('14');
  await expect(page.getByText('Aufgaben für heute', { exact: true })).toBeVisible();
  await expect(page.getByTestId('start-focus')).toContainText('Starten');
  // Echte Software: kein Demo-Hinweis, kein Modus-Schild, kein „Demo zurücksetzen“ – und kein Hinweis auf „nur eintragen“.
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
  await expect(page.getByTestId('mode-hint')).toHaveCount(0);
  await expect(page.getByTestId('reset-button')).toHaveCount(0);
  await expect(page.getByText(/Simulation|Beispieldaten|Demo/)).toHaveCount(0);
  await expect(page.getByTestId('protocol-hint')).toHaveCount(0);
  // Im Fokus-Modus gibt es keine Hauptnavigation mehr – nur eine Aufgabe pro Bildschirm.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('progress')).toHaveText('0 von 14 erledigt');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toHaveCount(0);
  await expect(page.locator('[data-testid=stack-card]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('start-focus')).toBeVisible();
  // Fällige Follow-ups: eigener Hinweis mit Namen, Klick öffnet nur die Follow-ups.
  const notice = page.getByTestId('followup-notice');
  await expect(notice).toContainText(/Follow-ups? nötig/);
  await expect(notice).toContainText('seit 2 Tagen keine Antwort');
  await notice.click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'followup');
  await page.keyboard.press('Escape');
});

for (const founder of ['nick', 'johannes'] as const) {
  test(`kompletter Durchlauf aller Aufgaben (${founder})`, async ({ page }) => {
    const errors = trackErrors(page);
    await login(page, founder);
    await startFocus(page);
    await expect(page.getByTestId('progress')).toHaveText('0 von 14 erledigt');

    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId('success-screen').isVisible()) break;
      seen.push((await processCurrentCard(page, i)) ?? '?');
    }

    await expect(page.getByRole('heading', { name: 'Alles erledigt!' })).toBeVisible();
    await expect(page.getByTestId('progress')).toHaveText('14 von 14 erledigt');
    expect(seen).toHaveLength(14);
    // Antworten kommen immer zuerst.
    expect(seen.slice(0, 3)).toEqual(['reply', 'reply', 'reply']);
    expect(seen.filter((type) => type === 'reply')).toHaveLength(3);

    // Tagesbilanz in vier Zahlen, darunter die Serie (heute zählt immer mit).
    await expect(page.getByTestId('day-summary')).toContainText('14');
    await page.getByRole('button', { name: /Beenden/ }).click();
    await expect(page.getByRole('heading', { name: 'Alles erledigt!' })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('Filter: nur eine Aufgabenart abarbeiten', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'lead');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight');
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId('progress')).toHaveText('5 von 14 erledigt');
  await expect(page.getByText('Alle neuen Leads erledigt')).toBeVisible();
  await page.getByRole('button', { name: /Mit allen weitermachen/ }).click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'reply');

  await page.getByTestId('filter-menu').click();
  await page.getByRole('menuitemradio', { name: /Follow-ups/ }).click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'followup');
  expect(errors).toEqual([]);
});

/** Zieht die aktuelle Seite horizontal – Start auf einer Fläche ohne Bedienelement. */
async function swipe(page: Page, dx: number, steps: number) {
  const box = await currentCard(page).getByTestId('lead-sentence').boundingBox();
  if (!box) throw new Error('Keine Fläche zum Wischen gefunden');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY, { steps });
  await page.mouse.up();
}

test('Wischen entscheidet wie die Pfeiltasten', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');

  // Kurzes, langsames Ziehen reicht nicht – die Seite federt zurück.
  await swipe(page, 60, 30);
  await page.waitForTimeout(700);
  await expect(page.getByTestId('progress')).toHaveText('0 von 14 erledigt');
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');

  // Weit nach rechts ziehen = Vernetzen
  await swipe(page, 320, 12);
  await expect(page.getByTestId('lead-name').filter({ hasText: 'Henrik Saalfeld' })).toHaveCount(0);
  await expect(page.getByTestId('progress')).toHaveText('1 von 14 erledigt');

  // Nach links = Nicht geeignet
  await expect(currentName(page)).toHaveText('Nadine Brückner');
  await swipe(page, -320, 12);
  await expect(page.getByTestId('lead-name').filter({ hasText: 'Nadine Brückner' })).toHaveCount(0);
  await expect(page.getByTestId('progress')).toHaveText('2 von 14 erledigt');

  // Rückgängig holt die Aufgabe zurück
  await page.keyboard.press('z');
  await expect(currentName(page)).toHaveText('Nadine Brückner');
  expect(errors).toEqual([]);
});

test('Rückgängig stellt die letzte Entscheidung wieder her – und speichert nichts', async ({ page }) => {
  await login(page, 'nick', 'ping=off&undo=2');
  await startFocus(page);
  await expect(currentName(page)).toHaveText('Ralf Ostermann');
  await expect(currentCard(page).getByRole('button', { name: 'Kein Interesse' })).toBeEnabled();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('progress')).toHaveText('1 von 14 erledigt');
  await page.keyboard.press('z');
  await expect(page.getByTestId('progress')).toHaveText('0 von 14 erledigt');
  await expect(currentName(page)).toHaveText('Ralf Ostermann');
  // Auch nach Ablauf des Fensters ist nichts gespeichert worden.
  await page.waitForTimeout(2500);
  expect((await findLead(page, 'nick', 'Ralf Ostermann')).stage).toBe('replied');
});

test('Entscheidungen werden gespeichert und überstehen das Neuladen', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'nick', 'ping=off&undo=1');
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await page.keyboard.press('Enter');
  // Meldung: erst rückgängig machbar, dann gespeichert.
  const toast = page.getByTestId('activity-toast');
  await expect(toast).toContainText('Vernetzungsanfrage wird gesendet');
  await expect(toast).toHaveAttribute('data-mode', 'done');
  expect((await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('invited');

  // Rückgängig geht jetzt nicht mehr.
  await page.keyboard.press('z');
  await expect(toast.filter({ hasText: 'Schon gespeichert' })).toBeVisible();

  await page.reload();
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText('13');
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Nadine Brückner');
  expect(errors).toEqual([]);
});

test('Entscheidung beim Schließen der Seite wird trotzdem gespeichert', async ({ page }) => {
  await login(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await page.keyboard.press('Enter');
  // Noch im Rückgängig-Fenster (5 s) neu laden: Die Anfrage geht beim Verlassen der Seite raus.
  await page.reload();
  await expect.poll(async () => (await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('invited');
  await page.reload();
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText('13');
});

test('Vom Backend abgelehnt: Die Aufgabe kommt zurück, mit Grund', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 409\b/.test(text));
  await login(page, 'nick', 'ping=off&undo=0');
  await page.route(DECISION_ROUTES, (route) =>
    fail(route, 409, 'invalid_transition', '„Vernetzungsanfrage gesendet“ passt nicht zur Stufe „Verloren“.'),
  );
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('notice')).toContainText('Nicht gespeichert · Henrik Saalfeld');
  await expect(page.getByTestId('notice')).toContainText('passt nicht zur Stufe');
  // Zurück im Stapel – direkt hinter der aktuellen Aufgabe – mit Grund auf der Karte.
  await expect(currentName(page)).toHaveText('Nadine Brückner');
  await page.keyboard.press('ArrowLeft');
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await expect(currentCard(page).getByTestId('card-failure')).toContainText('passt nicht zur Stufe');
  expect(errors).toEqual([]);
});

test('Offline: Entscheidungen warten und werden nachgetragen', async ({ page }) => {
  const errors = trackErrors(page, (text) => /ERR_FAILED|ERR_INTERNET_DISCONNECTED|status of 503\b/.test(text));
  await login(page, 'nick', 'ping=off&undo=0');
  await page.route(DECISION_ROUTES, (route) => route.abort('internetdisconnected'));
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('waiting-status')).toContainText('1 Entscheidung wartet aufs Speichern');
  await page.unroute(DECISION_ROUTES);
  await page.getByTestId('waiting-status').getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(page.getByTestId('waiting-status')).toHaveCount(0);
  await expect(page.getByTestId('progress')).toHaveText('1 von 14 erledigt');
  await expect.poll(async () => (await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('invited');
  expect(errors).toEqual([]);
});

test('Tagesstapel: Laden scheitert, Erneut versuchen, leerer Tag', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 500\b/.test(text));
  let mode: 'fail' | 'empty' | 'real' = 'fail';
  await page.route('**/api/tasks*', async (route) => {
    if (mode === 'fail') return fail(route, 500, 'error', 'Kaputt');
    const response = await route.fetch();
    const body = await response.json();
    if (mode === 'empty') return route.fulfill({ json: { ...body, tasks: [], counts: { reply: 0, followup: 0, first: 0, lead: 0 } } });
    return route.fulfill({ response, json: body });
  });
  await login(page, 'nick');
  await expect(page.getByText('Deine Aufgaben konnten nicht geladen werden.')).toBeVisible();
  mode = 'empty';
  await page.getByRole('button', { name: /Erneut versuchen/ }).click();
  // „Meine“ leer (24.10.): weiter geht es nur unter „Alle“.
  await expect(page.getByTestId('mine-done')).toContainText('Für deinen Account steht heute nichts an.');
  await expect(page.getByTestId('to-all')).toBeVisible();
  // Kein „Alles erledigt“ für einen Tag, an dem nichts anstand.
  await expect(page.getByTestId('success-screen')).toHaveCount(0);
  mode = 'real';
  await page.reload();
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText('14');
  expect(errors).toEqual([]);
});

test('Live mit LinkedIn-Aktionen aus: Das Cockpit trägt nur ein und sagt das auch', async ({ page }) => {
  // Lead-Suche meldet „live“, LinkedIn-Aktionen „off“ (LINKEDIN_ACTIONS nicht gesetzt) – das Cockpit sendet nichts.
  await page.route('**/api/lead-search/config*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, mode: 'live' } });
  });
  await page.route('**/api/linkedin/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, mode: 'off' } });
  });
  await login(page, 'nick');
  // Der Hinweis zeigt zugleich, dass die Umleitung greift.
  await expect(page.getByTestId('protocol-hint')).toContainText('Das Cockpit sendet noch nichts');
  await page.getByTestId('home-details-toggle').click();
  // Zeigt das eingestellte Anfragen-Limit (Sperre, LINKEDIN_INVITES_PER_DAY – in den E2E-Tests 10000, seit 17.10. fest
  // höchstens 80 je Account laut Unipile) – unter „Meine“ nur der eigene Account (24.10.).
  await expect(page.getByTestId('invites-today')).toHaveText(/^Heute \d+ \/ 80 Anfragen über deinen Account$/);
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
  await expect(page.getByTestId('reset-button')).toHaveCount(0);
  await page.getByTestId('start-lead').click();
  await expect(currentCard(page).getByRole('button', { name: /Anfrage eintragen/ })).toBeVisible();
  // Auf der Karte selbst: nichts geht raus (Rückmeldung 11.10. – Anfrage kam auf LinkedIn nie an).
  await expect(currentCard(page).getByTestId('protocol-note')).toContainText('Das Cockpit sendet nicht selbst');
  await page.getByTestId('filter-menu').click();
  await page.getByRole('menuitemradio', { name: /Erstnachrichten/ }).click();
  await expect(currentCard(page).getByRole('button', { name: /Als gesendet eintragen/ })).toBeVisible();
  await expect(currentCard(page).getByTestId('copy-message')).toBeVisible();
});

test('Lead-Panel zeigt Historie und Zuordnung', async ({ page }) => {
  await login(page, 'nick');
  await startFocus(page);
  await page.getByTitle('Lead-Historie öffnen').click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByTestId('owner')).toContainText('Nick');
  await expect(panel).toContainText('Vernetzungsanfrage gesendet von Nick');
  await expect(panel).toContainText('Antwort von Ralf erhalten');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Esc schließt nur das Panel, nicht den Fokus-Modus
  await expect(page.getByTestId('progress')).toBeVisible();
});

test('Dashboard rendert alle Ansichten', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'johannes');
  await page.getByRole('button', { name: /Dashboard/ }).click();
  for (const kpi of ['Anfragen', 'Annahmequote', 'Antwortquote', 'Termine']) await expect(page.getByTestId(`kpi-${kpi}`)).toBeVisible();
  // Übergaben an Close sind abgeschaltet – der fünfte Platz zeigt die KI-Kosten je qualifiziertem Lead.
  await expect(page.getByTestId('kpi-Übergaben')).toHaveCount(0);
  await expect(page.getByTestId('kpi-cost-per-lead')).toContainText('Ø Kosten je qualifiziertem Lead');
  await expect(page.getByTestId('kpi-cost-per-lead').getByTestId('kpi-value')).toHaveText(/€|–/);
  await expect(page.getByText('Von der Anfrage zum Termin', { exact: true })).toBeVisible();
  await page.getByTestId('kpi-trend-toggle').click();
  await expect(page.getByTestId('kpi-trend-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.recharts-surface').first()).toBeVisible();

  await page.getByRole('tab', { name: 'Vorlagen' }).click();
  await expect(page.getByText('Antwortquote je Vorlage')).toBeVisible();
  await expect(page.getByText('Antwortquote je Follow-up-Stufe')).toBeVisible();
  expect(await page.locator('.recharts-surface').count()).toBeGreaterThanOrEqual(2);

  await page.getByRole('tab', { name: 'Nick vs. Johannes' }).click();
  await expect(page.getByText('Termine pro Woche')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Gesamt' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Dashboard zählt echte Ereignisse (GET /api/dashboard)', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'nick', 'ping=off&undo=0');
  const requests = () => page.getByTestId('kpi-Anfragen').getByTestId('kpi-value');
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('dashboard-meta')).toContainText('Letzte 8 Wochen');
  await page.getByRole('tab', { name: 'Nick', exact: true }).click();
  const before = Number((await requests().textContent())!.replace(/\D/g, ''));

  await page.getByTestId('nav-home').click();
  await page.getByTestId('start-lead').click();
  await expect(currentName(page)).toHaveText('Henrik Saalfeld');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('invited');
  await page.getByRole('button', { name: /Beenden/ }).click();

  await page.getByTestId('nav-dashboard').click();
  await page.getByRole('tab', { name: 'Nick', exact: true }).click();
  await expect(requests()).toHaveText(String(before + 1));
  expect(errors).toEqual([]);
});

test('Dashboard: Fehler beim Laden, Erneut versuchen', async ({ page }) => {
  const errors = trackErrors(page, (text) => /status of 500\b/.test(text));
  let broken = true;
  await page.route('**/api/dashboard*', (route) => (broken ? fail(route, 500, 'error', 'Kaputt') : route.fallback()));
  await login(page, 'nick');
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByText('Die Zahlen konnten nicht geladen werden.')).toBeVisible();
  broken = false;
  await page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(page.getByTestId('kpi-Termine')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Abmelden und Gründer wechseln – offene Entscheidungen werden vorher gespeichert', async ({ page }) => {
  const errors = trackErrors(page);
  // Langes Rückgängig-Fenster: gespeichert wird nur, weil das Abmelden den Ausgangskorb leert.
  await login(page, 'nick', 'ping=off&undo=60');
  await startFocus(page);
  await expect(currentCard(page).getByRole('button', { name: 'Kein Interesse' })).toBeEnabled();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('progress')).toHaveText('1 von 14 erledigt');
  await page.getByRole('button', { name: /Beenden/ }).click();
  await page.getByRole('button', { name: 'Konto: Nick' }).click();
  await page.getByRole('button', { name: /^Abmelden/ }).click();
  // Erst die Startseite ausblenden lassen – sonst hält signIn sie für eine noch offene Sitzung.
  await expect(page.getByTestId('home')).toBeHidden();
  await signIn(page, 'johannes');
  await expect(page.getByTestId('open-count')).toHaveText('14');
  await startFocus(page);
  await expect(currentName(page)).toHaveText('Anja Reimers');
  // Nicks Entscheidung kam vor dem Abmelden an.
  expect((await findLead(page, 'nick', 'Ralf Ostermann')).stage).toBe('lost');
  expect(errors).toEqual([]);
});

test('Vorschlag per Klick: Erstnachricht, Follow-up und Antwort (Simulation)', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'nick');

  // Erstnachricht: Vorschlag ersetzt den Text im Editor, Vorlage passend zum Lead-Typ.
  await page.getByTestId('start-first').click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'first');
  await expect(currentCard(page).getByRole('tablist', { name: 'Template wählen' })).toBeVisible();
  await page.keyboard.press('k');
  await expect(page.getByTestId('suggest-note')).toContainText('Vorschlag');
  await expect(page.getByTestId('suggest-note')).toContainText(/ · Vorlage [AB] · /);
  // Erstnachrichten des Kunden (12.10.) enden mit der Frage nach dem Call.
  await expect(currentCard(page).locator('textarea')).toHaveValue(/15-Minuten-Call Sinn/);
  await page.keyboard.press('Escape');

  // Follow-up: Vorschlag landet als „Eigene Nachricht“.
  await page.getByTestId('start-followup').click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'followup');
  await currentCard(page).getByTestId('suggest-button').click();
  await expect(page.getByTestId('suggest-note')).toContainText(/Vorlage [AB]/);
  await expect(currentCard(page).getByRole('tab', { name: /Eigene Nachricht/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');

  // Antwort: Vorschlag landet im Antwortfeld (zum Anpassen) plus Einschätzung.
  await page.getByTestId('start-reply').click();
  await expect(currentCard(page)).toHaveAttribute('data-card-type', 'reply');
  await expect(currentCard(page).getByRole('button', { name: 'Kein Interesse' })).toBeEnabled();
  await page.keyboard.press('k');
  await expect(currentCard(page).getByTestId('reply-answer').locator('textarea')).toHaveValue(/Viele Grüße/);
  await expect(page.getByTestId('suggest-note')).toContainText('Einschätzung:');
  expect(errors).toEqual([]);
});

test('Antwort-Karte: selbst antworten – gesendet, die Antwort-Aufgabe ist danach erledigt', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'nick', 'ping=off&undo=0');
  await page.getByTestId('start-reply').click();
  const card = currentCard(page);
  await expect(card).toHaveAttribute('data-card-type', 'reply');
  const answer = card.getByTestId('reply-answer').locator('textarea');
  await expect(card.getByTestId('reply-send')).toBeDisabled();
  await answer.fill('Danke für die Rückmeldung – Donnerstag 10 Uhr passt mir gut!');
  const saved = page.waitForResponse((response) => /\/api\/leads\/[^/]+\/(events|linkedin\/message)$/.test(response.url()) && response.request().method() === 'POST');
  await card.getByTestId('reply-send').click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId('progress')).toContainText('1 von');
  // Nach dem Neuladen ist die beantwortete Antwort nicht mehr im Stapel.
  await page.reload();
  await signIn(page, 'nick');
  await expect(page.getByTestId('start-reply')).toContainText('2');
  expect(errors).toEqual([]);
});

test('Schnelles Hin- und Herklicken lässt die Seite nie leer', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'nick');
  // Keine automatische Übersetzung (verändert sonst den Seiteninhalt hinter React → schwarzer Bildschirm).
  await expect(page.locator('html')).toHaveAttribute('translate', 'no');
  for (let round = 0; round < 6; round++) {
    for (const view of ['dashboard', 'home', 'dashboard', 'search']) await page.getByTestId(`nav-${view}`).click();
  }
  await page.getByTestId('nav-dashboard').click();
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await expect(page.getByTestId('error-boundary')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Für heute überspringen: gilt nach dem Neuladen, Rückgängig hebt es wieder auf', async ({ page }) => {
  await login(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText('14');
  await page.getByTestId('start-followup').click();
  const name = (await currentName(page).textContent())!;
  // Tasten wirken erst, wenn Verlauf und Vorlagen geladen sind (vorher zeigt die Karte nur den Platzhalter).
  await expect(currentCard(page).getByRole('button', { name: /Nicht senden/ })).toBeEnabled();
  // Im Rückgängig-Fenster zurückgenommen: Beim Backend kommt nichts an.
  await page.keyboard.press('ArrowLeft');
  await expect(currentName(page)).not.toHaveText(name);
  await page.keyboard.press('z');
  await expect(currentName(page)).toHaveText(name);
  // Jetzt wirklich überspringen – gespeichert nach dem Fenster, im Backend bis Mitternacht.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await findLead(page, 'nick', name)).snoozedUntil ?? null, { timeout: 10_000 }).toBeGreaterThan(Date.now());
  // Auch nach dem Speichern noch rückgängig zu machen.
  await page.keyboard.press('z');
  await expect(currentName(page)).toHaveText(name);
  await expect.poll(async () => (await findLead(page, 'nick', name)).snoozedUntil ?? null).toBeNull();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await findLead(page, 'nick', name)).snoozedUntil ?? null, { timeout: 10_000 }).not.toBeNull();
  // Neu laden: Die Aufgabe fehlt – das merkt sich jetzt das Backend, nicht der Browser.
  await page.reload();
  await signIn(page, 'nick');
  await expect(page.getByTestId('open-count')).toHaveText('13');
});

test('Antwort verloren: Die Wiederholung wird nicht doppelt gebucht (clientId)', async ({ page }) => {
  const errors = trackErrors(page, (text) => /ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(text));
  // LinkedIn-Aktionen aus: Das Follow-up wird eingetragen (`POST /events`) – nur dort gibt es die clientId.
  await page.route('**/api/linkedin/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, mode: 'off' } });
  });
  const sent: string[] = [];
  await page.route(DECISION_ROUTES, async (route) => {
    sent.push(route.request().postDataJSON()?.clientId);
    if (sent.length > 1) return route.fallback();
    // Die erste Meldung kommt an, aber die Antwort geht verloren.
    await route.fetch();
    return route.abort('internetdisconnected');
  });
  await login(page, 'nick', 'ping=off&undo=0');
  await page.getByTestId('start-followup').click();
  const name = (await currentName(page).textContent())!;
  const before = (await findLead(page, 'nick', name)).followUpsSent;
  await expect(page.getByRole('tablist', { name: 'Follow-up-Variante' })).toBeVisible();
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(2);
  await expect(page.getByTestId('waiting-status')).toHaveCount(0);
  expect(sent[0]).toBeTruthy();
  expect(sent[1]).toBe(sent[0]);
  expect((await findLead(page, 'nick', name)).followUpsSent).toBe(before + 1);
  expect(errors).toEqual([]);
});

/** LinkedIn-Aktionen aus: Entscheidungen werden eingetragen (`POST /events`, mit clientId). */
async function protocolOnly(page: Page) {
  await page.route('**/api/linkedin/status', async (route) => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...(await response.json()), mode: 'off' } });
  });
}

test('Zwei Tabs, verschiedene Entscheidungen zur selben Aufgabe: Die zweite wird abgelehnt, nicht still verworfen', async ({ page, context }) => {
  const errors = trackErrors(page, (text) => /status of 409\b/.test(text));
  const other = await context.newPage();
  trackErrors(other, (text) => /status of 409\b/.test(text));
  for (const tab of [page, other]) {
    await protocolOnly(tab);
    await login(tab, 'nick', 'ping=off&undo=0');
    await tab.getByTestId('start-lead').click();
    await expect(currentName(tab)).toHaveText('Henrik Saalfeld');
  }
  // Tab 1: „Nicht geeignet“ (lost). Tab 2 – noch alter Stand: Anfrage eintragen (invite_sent).
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('lost');
  await other.keyboard.press('Enter');
  await expect(other.getByTestId('notice')).toContainText('Nicht gespeichert · Henrik Saalfeld');
  expect((await findLead(page, 'nick', 'Henrik Saalfeld')).stage).toBe('lost');
  expect(errors).toEqual([]);
});

test('Zwei Geräte mit verschiedenem Stand: Dasselbe Follow-up zählt nur einmal', async ({ page, context }) => {
  const stale = await context.newPage();
  await protocolOnly(stale);
  await login(stale, 'nick', 'ping=off&undo=0');
  await stale.getByTestId('start-followup').click();
  const name = (await currentName(stale).textContent())!;
  const lead = await findLead(page, 'nick', name);
  // Inzwischen ändert sich der Lead (anderer Stand → andere clientId), das zweite Gerät lädt neu.
  expect((await page.request.patch(`/api/leads/${lead.id}`, { data: { nextStep: 'Rückruf' } })).status()).toBe(200);
  await protocolOnly(page);
  await login(page, 'nick', 'ping=off&undo=0');
  await page.getByTestId('start-followup').click();
  await expect(currentName(page)).toHaveText(name);
  // Bis Signal und Vorlagen da sind, steht ein Platzhalter mit dem Namen – Tasten gelten erst auf der fertigen Karte.
  await expect(page.getByRole('tablist', { name: 'Follow-up-Variante' })).toBeVisible();
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'nick', name)).followUpsSent).toBe(lead.followUpsSent + 1);
  // Das Gerät mit dem alten Stand trägt dasselbe Follow-up ein – es darf nicht doppelt zählen.
  await expect(stale.getByRole('tablist', { name: 'Follow-up-Variante' })).toBeVisible();
  await stale.keyboard.press('1');
  await stale.keyboard.press('Enter');
  await expect(stale.getByTestId('progress')).toContainText('1 von');
  await expect.poll(async () => (await findLead(page, 'nick', name)).followUpsSent, { timeout: 5_000 }).toBe(lead.followUpsSent + 1);
  await stale.waitForTimeout(1_500);
  expect((await findLead(page, 'nick', name)).followUpsSent).toBe(lead.followUpsSent + 1);
});

test('Zwei Geräte mit verschiedenem Stand: Die Erstnachricht zählt nicht zusätzlich als Follow-up 1', async ({ page, context }) => {
  const stale = await context.newPage();
  await protocolOnly(stale);
  await login(stale, 'nick', 'ping=off&undo=0');
  await stale.getByTestId('start-first').click();
  const name = (await currentName(stale).textContent())!;
  const lead = await findLead(page, 'nick', name);
  expect(lead.followUpsSent).toBe(0);
  // Inzwischen ändert sich der Lead (anderer Stand → andere clientId), das zweite Gerät lädt neu und sendet zuerst.
  expect((await page.request.patch(`/api/leads/${lead.id}`, { data: { nextStep: 'Rückruf' } })).status()).toBe(200);
  await protocolOnly(page);
  await login(page, 'nick', 'ping=off&undo=0');
  await page.getByTestId('start-first').click();
  await expect(currentName(page)).toHaveText(name);
  await expect(page.getByRole('tablist', { name: 'Template wählen' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await findLead(page, 'nick', name)).stage).toBe('contacted');
  // Das Gerät mit dem alten Stand trägt die Erstnachricht auch ein – sie gilt als erledigt, kein Follow-up 1.
  await expect(stale.getByRole('tablist', { name: 'Template wählen' })).toBeVisible();
  await stale.keyboard.press('Enter');
  await expect(stale.getByTestId('progress')).toContainText('1 von');
  await stale.waitForTimeout(1_500);
  const after = await findLead(page, 'nick', name);
  expect(after.stage).toBe('contacted');
  expect(after.followUpsSent).toBe(0);
});

test('Überspringen offline: wartet sichtbar und wird nachgetragen', async ({ page }) => {
  const errors = trackErrors(page, (text) => /ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(text));
  await login(page, 'nick', 'ping=off&undo=0');
  await page.route('**/api/leads/*/snooze', (route) => route.abort('internetdisconnected'));
  await page.getByTestId('start-followup').click();
  const name = (await currentName(page).textContent())!;
  // Knopf statt Taste ←: Direkt nach dem Öffnen sind die Tastenkürzel einen Moment gesperrt (Karte erscheint noch).
  await currentCard(page).getByRole('button', { name: /Nicht senden/ }).click();
  await expect(page.getByTestId('waiting-status')).toContainText('1 Entscheidung wartet aufs Speichern');
  await page.unroute('**/api/leads/*/snooze');
  await page.getByTestId('waiting-status').getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(page.getByTestId('waiting-status')).toHaveCount(0);
  await expect.poll(async () => (await findLead(page, 'nick', name)).snoozedUntil ?? null).not.toBeNull();
  expect(errors).toEqual([]);
});

test('Browser, deren scrollTo einen Wert zurückgibt (Chrome 154): Lead-Suche verlassen stürzt nicht ab', async ({ page }) => {
  // Neuere Chrome-Versionen liefern bei scrollTo ein Promise – früher hielt React es für eine Aufräumfunktion.
  await page.addInitScript(`
    const original = window.scrollTo.bind(window);
    window.scrollTo = (...args) => { original(...args); return Promise.resolve(); };
  `);
  const errors = trackErrors(page);
  await login(page, 'nick');
  for (let round = 0; round < 3; round++) {
    await page.getByTestId('nav-search').click();
    await page.getByTestId('nav-dashboard').click();
    await page.getByTestId('nav-home').click();
  }
  await expect(page.getByTestId('error-boundary')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Notiz zur Vernetzungsanfrage ausgeschaltet: kein „Notiz hinzufügen“ auf der Karte', async ({ page }) => {
  await page.route('**/api/tasks*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, rules: { ...body.rules, inviteNote: false } } });
  });
  await login(page, 'nick');
  await page.getByTestId('start-lead').click();
  await expect(currentCard(page).getByRole('button', { name: /Vernetzen/ })).toBeVisible();
  await expect(currentCard(page).getByTestId('invite-note-open')).toHaveCount(0);
  await expect(currentCard(page).getByTestId('protocol-note')).toHaveCount(0);
});

for (const backend of ['älteres Backend', 'mit Account-Wechsel'] as const) {
  test(`Sperre: Tageslimit für Vernetzungsanfragen erreicht – Vernetzen gesperrt, Hinweis auf der Karte (${backend})`, async ({ page }) => {
    await page.route('**/api/tasks*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      // Älteres Backend: kein `inviteVia`, Sperre aus `invitesPerDay`. Neu: `inviteVia: null` = beide Accounts voll.
      // Seit 25.10. zusätzlich je Besitzer und je Account (`inviteViaByOwner`, `invitesByAccount`, `invitesPerDayByAccount`).
      const { inviteVia: _ignored, inviteViaByOwner: _a, invitesByAccount: _b, invitesPerDayByAccount: _c, ...old } = body;
      const json =
        backend === 'älteres Backend'
          ? { ...old, rules: { ...body.rules, invitesPerDay: 0 } }
          : {
              ...body,
              inviteVia: null,
              inviteViaByOwner: { nick: null, johannes: null },
              invitesByAccount: { nick: 20, johannes: 20 },
              invitesPerDayByAccount: { nick: 20, johannes: 20 },
            };
      return route.fulfill({ response, json });
    });
    await login(page, 'nick');
    await page.getByTestId('start-lead').click();
    await expect(currentCard(page).getByTestId('invite-limit-reached')).toContainText('Tageslimit erreicht');
    await expect(currentCard(page).getByRole('button', { name: /Vernetzen/ })).toBeDisabled();
  });
}
