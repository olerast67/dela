/** Без сервера: задачи живут в браузере, переживают перезагрузку, запросов к API нет. */
import { expect, test } from '@playwright/test';

test('попробовать без сервера', async ({ page }) => {
  const api: string[] = [];
  await page.goto('/');
  page.on('request', (r) => r.url().includes('/api/') && api.push(r.url()));
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Только в этом браузере')).toBeVisible();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Локальная задача сегодня');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await page.reload();
  await expect(page.locator('.task', { hasText: 'Локальная задача' })).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Без сервера' })).toBeVisible();
  expect(api).toEqual([]);
});
