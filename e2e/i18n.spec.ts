/** Английский интерфейс: язык браузера en-US, на экранах нет русского текста, фразы разбираются, язык меняется в настройках. */
import { expect, test } from '@playwright/test';

test.use({ locale: 'en-US' });

test('английский интерфейс и смена языка', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to Dela' })).toBeVisible();
  await page.getByRole('button', { name: /Try without a server/ }).click();
  await expect(page.getByText('Only in this browser')).toBeVisible();
  await expect(page.getByText('Follow olerast').first()).toBeVisible();

  await page.keyboard.press('q');
  await page.getByLabel('New task').fill('Buy flowers tomorrow at 7pm');
  await page.getByLabel('New task').press('Enter');
  await page.getByLabel('New task').press('Escape');
  await page.goto('/#/upcoming');
  await expect(page.locator('.task', { hasText: 'Buy flowers' })).toContainText('19:00');

  // Ни на одном экране не осталось русских строк интерфейса.
  for (const route of ['today', 'upcoming', 'calendar', 'inbox', 'completed', 'trash', 'templates', 'activity', 'settings']) {
    await page.goto(`/#/${route}`);
    await page.waitForTimeout(300);
    const text = await page.locator('body').innerText();
    // Кнопка «Русский» в выборе языка пишется по-русски нарочно.
    const russian = (text.match(/[А-Яа-яЁё][^\n]*/g) ?? []).filter((line) => line !== 'Русский');
    expect(russian, `#/${route}`).toEqual([]);
  }

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.getByRole('heading', { name: 'Без сервера' })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'No server' })).toBeVisible();
});
