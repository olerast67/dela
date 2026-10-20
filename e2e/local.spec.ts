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
  await expect(page.locator('.task', { hasText: 'Локальная задача' })).toBeVisible();
  // Запись в IndexedDB асинхронная: перезагрузка сразу после ввода могла её опередить.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('.task', { hasText: 'Локальная задача' })).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Без сервера' })).toBeVisible();
  expect(api).toEqual([]);
});

test('вставленный список становится задачами, отступ даёт подзадачу', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  const list = '- [ ] Ремонт сегодня\n  - [x] купить краску\n  - [ ] покрасить стену сегодня\n- Забрать посылку сегодня в 19';
  await page.getByLabel('Новая задача').evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, list);
  await expect(page.getByText('Вставлен список: 3 задачи')).toBeVisible();
  await expect(page.locator('.qa-batch li.sub', { hasText: 'покрасить стену' })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить все' }).click();
  await expect(page.locator('.task', { hasText: 'Забрать посылку' })).toBeVisible();
  await expect(page.locator('.task', { hasText: 'покрасить стену' })).toBeVisible();
  await expect(page.locator('.task', { hasText: 'купить краску' })).toHaveCount(0);
});
