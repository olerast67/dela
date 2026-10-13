/** Шаблоны и история: проект из готового шаблона, свой шаблон из проекта, события в истории. */
import { expect, test } from '@playwright/test';

test('шаблоны и история', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`tpl-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('templates-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('templates-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();

  await page.locator('.sidebar').getByText('Шаблоны').click();
  await page.locator('.template-card', { hasText: 'Ролик на YouTube' }).getByRole('button', { name: 'Создать проект' }).click();
  await expect(page.getByRole('heading', { name: 'Ролик на YouTube' })).toBeVisible();
  await expect(page.locator('.content').getByText('Написать сценарий')).toBeVisible();
  await expect(page.locator('.content').getByRole('heading', { name: /^Монтаж/ })).toBeVisible();

  // Свой шаблон из проекта.
  await page.getByRole('button', { name: 'Шаблон' }).click();
  await page.locator('.sidebar').getByText('Шаблоны').click();
  await expect(page.locator('.template-card', { hasText: 'Ролик на YouTube' }).first()).toContainText('4 разд.');
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/templates.png' });

  // Выполненная задача видна в истории.
  await page.locator('.sidebar').getByText('Сегодня').click();
  await page.locator('.task', { hasText: 'Подписаться на olerast' }).locator('.check').click();
  await page.locator('.sidebar').getByText('История').click();
  await expect(page.locator('.activity-row.kind-completed', { hasText: 'Подписаться на olerast' })).toBeVisible();
  await expect(page.locator('.activity-row.kind-created', { hasText: 'Написать сценарий' })).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/history.png' });
});
