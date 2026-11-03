import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('Handy (390 px): Tab-Leiste unten wie eine iOS-App, Navigation oben nur am Desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');

  const tabs = page.getByTestId('tab-bar');
  await expect(tabs).toBeVisible();
  // Leiste sitzt am unteren Rand, jeder Tab ist groß genug für den Daumen.
  const box = (await tabs.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  for (const view of ['home', 'search', 'leads', 'chats', 'dashboard']) {
    await expect(tabs.getByTestId(`nav-${view}`)).toBeVisible();
  }
  // Höchstens fünf Tabs (DESIGN.md) – die KI steht im Dashboard.
  await expect(tabs.getByRole('button')).toHaveCount(5);
  const tab = (await tabs.getByRole('button', { name: /Leads/ }).boundingBox())!;
  expect(tab.width).toBeGreaterThanOrEqual(44);
  expect(tab.height).toBeGreaterThanOrEqual(44);

  await tabs.getByTestId('nav-leads').click();
  await expect(tabs.getByRole('button', { name: /Leads/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: /Leads/ }).first()).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(390);

  // Zurück auf Desktop-Breite: Navigation wieder oben, keine Tab-Leiste.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('tab-bar')).toHaveCount(0);
  await expect(page.getByTestId('top-nav').getByTestId('nav-leads')).toBeVisible();
});

test('Web-App für den Home-Bildschirm: Manifest und iOS-Angaben', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
});
