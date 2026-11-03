import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { LeadListResponse } from '../shared/leads';
import { E2E_PASSWORD, openAssistant, resetCockpit, trackErrors } from './helpers';

/** Claude-App verbinden (`shared/mcp.ts`): Freigabe im Cockpit, Verbindungen im Tab „KI“, Lead-Links. */
test.beforeEach(async ({ request }) => resetCockpit(request));

/** Anmelden wie `signIn`, aber ohne auf die Startseite zu warten (nach der Anmeldung kommt die Freigabe). */
async function logIn(page: Page) {
  const card = page.getByTestId('login-nick');
  const form = page.getByTestId('login-form');
  await expect(card.or(form)).toBeVisible();
  if (await form.isVisible()) {
    await page.getByLabel('Name').fill('nick');
    await page.getByLabel('Passwort', { exact: true }).fill(E2E_PASSWORD);
    await page.getByTestId('login-submit').click();
  } else await card.click();
}

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

test('Claude-App: Anmeldung, Freigabe zulassen → zurück zu Claude mit Code; Adresse im Tab „KI“', async ({ page, request }) => {
  const errors = trackErrors(page);
  const registered = await request.post('/api/oauth/register', { data: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
  expect(registered.status()).toBe(201);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'abc' });
  const authorize = await request.get(`/api/oauth/authorize?${query}`, { maxRedirects: 0 });
  expect(authorize.status()).toBe(302);
  const target = new URL(authorize.headers().location);

  // Rücksprung zu Claude abfangen – kein echtes Netz.
  await page.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Claude</p>' }));
  await page.goto(`${target.pathname}${target.search}`);
  // Erst anmelden, dann die Freigabe (statt der Startseite).
  await logIn(page);
  const consent = page.getByTestId('mcp-consent');
  await expect(consent).toContainText('Claude möchte auf das Cockpit zugreifen');
  await expect(consent).toContainText('claude.ai');
  await page.getByTestId('mcp-consent-approve').click();
  await page.waitForURL(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?/);
  const back = new URL(page.url());
  expect(back.searchParams.get('code')).toBeTruthy();
  expect(back.searchParams.get('state')).toBe('abc');

  // Zurück im Cockpit: kein Freigabe-Dialog mehr, Verbindung erscheint erst nach dem Token-Abruf – hier nur die Adresse.
  await page.goto('/?ping=off');
  await expect(page.getByTestId('home')).toBeVisible();
  await openAssistant(page);
  await page.getByTestId('mcp-open').click();
  const dialog = page.getByTestId('mcp-connections');
  await expect(dialog.getByTestId('mcp-url')).toHaveText(/\/mcp$/);
  await expect(dialog).toContainText('Noch keine Verbindung.');
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test('Claude-App: Ablehnen führt mit access_denied zurück; abgelaufene Anfrage zeigt einen Hinweis', async ({ page, request }) => {
  const registered = (await (await request.post('/api/oauth/register', { data: { redirect_uris: [REDIRECT] } })).json()) as { client_id: string };
  const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
  const target = new URL((await request.get(`/api/oauth/authorize?${query}`, { maxRedirects: 0 })).headers().location);
  await page.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Claude</p>' }));
  await page.goto(`${target.pathname}${target.search}`);
  await logIn(page);
  await page.getByTestId('mcp-consent-deny').click();
  await page.waitForURL(/error=access_denied/);

  await page.goto('/?mcp_consent=gibt-es-nicht');
  await expect(page.getByTestId('mcp-consent-error')).toContainText('abgelaufen');
  await page.getByTestId('mcp-consent-back').click();
  await expect(page.getByTestId('home')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('mcp_consent')).toBeNull();
});

test('Lead-Link aus der Claude-App öffnet den Lead im Cockpit', async ({ page }) => {
  await page.goto('/?ping=off');
  await logIn(page);
  await expect(page.getByTestId('home')).toBeVisible();
  const leads = (await (await page.request.get('/api/leads')).json()) as LeadListResponse;
  const lead = leads.leads[0];
  await page.goto(`/?ping=off&lead=${lead.id}`);
  await expect(page.getByRole('dialog')).toContainText(`${lead.person.firstName} ${lead.person.lastName}`);
  expect(new URL(page.url()).searchParams.get('lead')).toBeNull();
});
