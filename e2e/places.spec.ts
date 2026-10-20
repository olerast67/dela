/** Напоминание по месту в браузере: «Где я сейчас» с подменённой геолокацией, сохранённое место, переживает перезагрузку. */
import { expect, test } from '@playwright/test';

test.use({ geolocation: { latitude: 55.75222, longitude: 37.61556, accuracy: 15 }, permissions: ['geolocation'] });

test('напоминание по месту видно в карточке, срабатывает только на Android', async ({ page, context }) => {
  const api: string[] = [];
  page.on('request', (r) => {
    // Координаты не уходят ни на какой сервер: ни карт, ни геокодеров.
    if (!r.url().startsWith('http://127.0.0.1')) api.push(r.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Купить хлеб');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await page.locator('.task', { hasText: 'Купить хлеб' }).click();
  const panel = page.locator('.panel');

  await panel.getByRole('button', { name: 'Добавить место' }).click();
  await panel.getByRole('button', { name: 'Где я сейчас' }).click();
  await expect(panel.locator('.place-name')).toHaveText('55.7522, 37.6156');
  await expect(panel.getByText('Сработает на телефоне с Android')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'при входе' })).toHaveClass(/\bon\b/);
  await expect(panel.getByRole('button', { name: '200 м' })).toHaveClass(/\bon\b/);

  await panel.getByRole('button', { name: 'при выходе' }).click();
  await panel.getByRole('button', { name: '100 м' }).click();
  await panel.getByLabel('Имя места').fill('Дом');
  await panel.getByLabel('Имя места').press('Enter');
  await expect(panel.locator('.place-name')).toHaveText('Дом');
  await panel.getByRole('button', { name: 'Сохранить место в список' }).click();
  await expect(panel.getByRole('button', { name: 'Сохранить место в список' })).toHaveCount(0);

  // Запись в IndexedDB асинхронная: перезагрузка сразу после ввода могла её опередить.
  await page.waitForTimeout(1000);
  await page.reload();
  await page.locator('.task', { hasText: 'Купить хлеб' }).click();
  await expect(panel.locator('.place-name')).toHaveText('Дом');
  await expect(panel.getByRole('button', { name: 'при выходе' })).toHaveClass(/\bon\b/);
  await expect(panel.getByRole('button', { name: '100 м' })).toHaveClass(/\bon\b/);

  // Вторая задача: место выбирается из сохранённых, «Где я сейчас» рядом с домом узнаёт «Дом».
  await page.keyboard.press('Escape');
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Полить цветы');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await page.locator('.task', { hasText: 'Полить цветы' }).click();
  await panel.getByRole('button', { name: 'Добавить место' }).click();
  await panel.locator('.place-saved').getByRole('button', { name: 'Дом', exact: true }).click();
  await expect(panel.locator('.place-name')).toHaveText('Дом');
  await expect(panel.getByRole('button', { name: '100 м' })).toHaveClass(/\bon\b/);
  await panel.getByRole('button', { name: 'Убрать напоминание по месту' }).click();
  await context.setGeolocation({ latitude: 55.75282, longitude: 37.61556, accuracy: 20 });
  await panel.getByRole('button', { name: 'Добавить место' }).click();
  await panel.getByRole('button', { name: 'Где я сейчас' }).click();
  await expect(panel.locator('.place-name')).toHaveText('Дом');

  expect(api).toEqual([]);
});
