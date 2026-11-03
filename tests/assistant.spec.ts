import { expect, test } from '@playwright/test';
import { openAssistant, resetCockpit, signIn, trackErrors } from './helpers';

/** KI-Assistent (`shared/assistant.ts`) gegen das Mock-Backend: in der Simulation antwortet ein fester Text mit echten Treffern. */
test.beforeEach(async ({ request }) => resetCockpit(request));

test('KI: Modell wählen, Frage stellen, Antwort mit Leseschritten und Lead-Link, Chat im Verlauf und löschen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await openAssistant(page);
  await expect(page.getByTestId('assistant-empty')).toBeVisible();
  await expect(page.getByTestId('assistant-suggestion')).toHaveCount(4);

  // Modellwahl: alle Claude-Modelle, Standard Claude Opus 5.5.
  const picker = page.getByTestId('assistant-model');
  await expect(picker).toContainText('Claude Opus 5.5');
  await picker.click();
  const menu = page.getByTestId('assistant-model-menu');
  await expect(menu.getByRole('menuitemradio')).toHaveCount(6);
  await menu.getByRole('menuitemradio', { name: /Claude Sonnet 5\.5/ }).click();
  await expect(picker).toContainText('Claude Sonnet 5.5');

  // Frage stellen (↵). Die Simulation sucht nach dem längsten Wort.
  await page.getByTestId('assistant-input').fill('Bedarf');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('assistant-question')).toHaveText('Bedarf');
  const answer = page.getByTestId('assistant-answer');
  await expect(answer).toContainText('Simulation');
  await expect(answer).toContainText('Claude Sonnet 5.5');
  await expect(answer.getByTestId('assistant-tools')).toContainText('2 Leseschritte');
  await answer.getByTestId('assistant-tools').getByRole('button').click();
  await expect(answer.getByTestId('assistant-tools')).toContainText('Nachrichten durchsucht: „Bedarf“');

  // Lead-Link öffnet das Lead-Panel.
  await answer.getByTestId('assistant-lead-link').filter({ hasText: 'Ralf Ostermann' }).click();
  await expect(page.getByRole('dialog')).toContainText('Ralf Ostermann');
  await page.keyboard.press('Escape');

  // Im Verlauf, neuer Chat ist leer, alter Chat lässt sich wieder öffnen und löschen.
  const items = page.getByTestId('assistant-chat-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Bedarf');
  await page.getByTestId('assistant-new').click();
  await expect(page.getByTestId('assistant-empty')).toBeVisible();
  await items.first().click();
  await expect(page.getByTestId('assistant-answer')).toContainText('Simulation');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('assistant-chat-delete').first().click();
  await expect(items).toHaveCount(0);
  await expect(page.getByTestId('assistant-empty')).toBeVisible();
  expect(errors).toEqual([]);
});

test('KI passt aufs Handy (390 px): Verlauf hinter einem Knopf, keine seitliche Scrollleiste', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ping=off');
  await signIn(page, 'nick');
  await openAssistant(page);
  await expect(page.getByTestId('assistant-empty')).toBeVisible();
  await page.getByTestId('assistant-suggestion').first().click();
  await expect(page.getByTestId('assistant-answer')).toContainText('Simulation');
  expect(await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth')).toBe(0);
  await page.getByRole('button', { name: 'Frühere Chats' }).click();
  await expect(page.getByTestId('assistant-chat-item')).toHaveCount(1);
});
