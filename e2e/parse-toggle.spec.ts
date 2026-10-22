/** Выключатель распознавания в быстром добавлении: выключен — текст сохраняется как есть, без срока и подсветки. */
import { expect, test, type Page } from '@playwright/test';

async function openQuickAdd(page: Page, route: string) {
  await page.goto(`/#/${route}`);
  // Фокус в поле настроек перехватил бы клавишу Q.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('q');
  return page.getByLabel('Новая задача');
}

test('без распознавания «сегодня» остаётся в названии, с ним снова становится сроком', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();

  await page.goto('/#/settings');
  const toggle = page.getByLabel('Распознавать даты, проекты и метки в тексте');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  // Настройка хранится в данных, а не в состоянии экрана. Запись в хранилище браузера асинхронная:
  // перезагрузка сразу после щелчка на медленной машине CI её теряла (как в game.spec.ts, ждём секунду).
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByLabel('Распознавать даты, проекты и метки в тексте')).not.toBeChecked();

  let field = await openQuickAdd(page, 'inbox');
  await field.fill('купить торт сегодня #Дом !1');
  await expect(page.locator('.qa-mirror mark')).toHaveCount(0);
  await expect(page.locator('.qa-bar .chip')).toHaveCount(0);
  await field.press('Enter');
  await field.press('Escape');
  await expect(page.locator('.task', { hasText: 'купить торт сегодня #Дом !1' })).toBeVisible();
  // Без срока: в «Сегодня» задачи нет, проект «Дом» не создан.
  await page.goto('/#/today');
  await expect(page.locator('.task').first()).toBeVisible();
  await expect(page.locator('.task', { hasText: 'купить торт' })).toHaveCount(0);
  await expect(page.locator('.sidebar').getByText('Дом', { exact: true })).toHaveCount(0);

  await page.goto('/#/settings');
  await page.getByLabel('Распознавать даты, проекты и метки в тексте').check();
  field = await openQuickAdd(page, 'inbox');
  await field.fill('испечь пирог сегодня');
  await expect(page.locator('.qa-mirror mark.tok-date')).toHaveText('сегодня');
  await field.press('Enter');
  await field.press('Escape');
  await page.goto('/#/today');
  await expect(page.locator('.task', { hasText: 'испечь пирог' })).toBeVisible();
  await expect(page.locator('.task', { hasText: 'испечь пирог сегодня' })).toHaveCount(0);
});
