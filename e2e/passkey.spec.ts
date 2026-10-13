/**
 * Вход по passkey с PRF через виртуальный аутентификатор Chromium:
 * добавить passkey в настройках, выйти, войти без пароля и увидеть свои задачи.
 */
import { expect, test } from '@playwright/test';

test('вход по passkey', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:8790' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  page.on('dialog', (d) => void d.accept());

  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`passkey-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('passkey-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('passkey-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Секрет только для меня сегодня');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await expect(page.getByText('Всё сохранено')).toBeVisible({ timeout: 10_000 });

  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Добавить passkey' }).click();
  await expect(page.getByText('Passkey добавлен.')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('button', { name: 'Войти по passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/#/today');
  await expect(page.locator('.task', { hasText: 'Секрет только для меня' })).toBeVisible({ timeout: 20_000 });
});
