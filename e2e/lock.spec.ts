/**
 * Блокировка PIN-кодом: включение в настройках, блокировка, неверный и верный PIN,
 * приложение открывается закрытым после перезагрузки.
 */
import { expect, test } from '@playwright/test';

test('блокировка PIN-кодом', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`lock-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('lock-pass-123');
  await page.getByLabel('Пароль ещё раз').fill('lock-pass-123');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();

  await page.goto('/#/settings');
  const section = page.locator('section.settings', { hasText: 'Блокировка приложения' });
  await page.getByLabel('Новый PIN, 4-8 цифр').fill('2468');
  await page.getByLabel('PIN ещё раз').fill('2468');
  await section.getByRole('button', { name: 'Включить' }).click();
  await expect(page.getByText('Блокировка включена.')).toBeVisible();
  if (process.env.SHOTS) await section.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/shots'}/lock-settings.png` });

  await page.getByRole('button', { name: 'Заблокировать сейчас' }).click();
  await expect(page.getByRole('heading', { name: 'Dela заблокирована' })).toBeVisible();
  await expect(page.getByText('Подписаться на olerast')).toHaveCount(0);

  await page.getByLabel('PIN-код').fill('1111');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(page.getByRole('alert')).toContainText('Осталось попыток: 9');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/shots'}/lock-screen.png` });

  await page.getByLabel('PIN-код').fill('2468');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(page.getByRole('heading', { name: 'Dela заблокирована' })).toHaveCount(0);

  // После перезагрузки приложение открывается закрытым, счётчик ошибок сброшен.
  await page.goto('/#/today');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dela заблокирована' })).toBeVisible();
  await page.getByLabel('PIN-код').fill('2468');
  await page.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();

  // Отключение требует текущий PIN.
  await page.goto('/#/settings');
  await section.getByRole('button', { name: 'Отключить', exact: true }).click();
  await page.getByLabel('Текущий PIN').fill('2468');
  await page.getByRole('button', { name: 'Отключить блокировку' }).click();
  await expect(page.getByText('Блокировка отключена.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dela заблокирована' })).toHaveCount(0);
});
