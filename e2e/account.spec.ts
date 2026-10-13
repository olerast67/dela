/**
 * Корзина и удаление аккаунта: удаление задачи навсегда, очистка корзины,
 * удаление аккаунта с неверным и верным паролем, повторный вход невозможен.
 */
import { expect, test } from '@playwright/test';

test('корзина и удаление аккаунта', async ({ page }) => {
  const email = `del-${Date.now()}@dela.test`;
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('delete-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('delete-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();

  // Две задачи в корзину: одну удаляем навсегда, вторую очисткой корзины.
  for (const title of ['Первая на удаление', 'Вторая на удаление']) {
    await page.keyboard.press('q');
    const input = page.getByLabel('Новая задача');
    await input.fill(`${title} сегодня`);
    await input.press('Enter');
    await input.press('Escape');
    await page.locator('.task', { hasText: title }).click();
    await page.getByRole('button', { name: 'Удалить' }).last().click();
    await expect(page.locator('.task', { hasText: title })).toHaveCount(0);
  }
  await page.goto('/#/trash');
  const row = page.locator('.trash-row', { hasText: 'Первая на удаление' });
  await row.getByRole('button', { name: 'Удалить навсегда' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.trash-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Очистить корзину' }).click();
  await expect(page.getByText('Корзина пуста.')).toBeVisible();
  await expect(page.getByText('Всё сохранено')).toBeVisible({ timeout: 10_000 });

  await page.goto('/#/settings');
  const section = page.locator('section.settings', { hasText: 'Удаление аккаунта' });
  await section.getByRole('button', { name: 'Удалить аккаунт' }).click();
  await section.getByLabel('Пароль для удаления').fill('wrong-password');
  await section.getByRole('button', { name: 'Удалить навсегда' }).click();
  await expect(section.getByRole('alert')).toHaveText('Пароль неверный.');
  await section.getByLabel('Пароль для удаления').fill('delete-pass-1');
  await section.getByRole('button', { name: 'Удалить навсегда' }).click();
  await expect(page.getByText('Аккаунт удалён.')).toBeVisible({ timeout: 20_000 });

  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('delete-pass-1');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Неверный адрес или пароль.')).toBeVisible({ timeout: 20_000 });
});
