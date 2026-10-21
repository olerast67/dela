/** Вехи: тост один раз при пересечении порога, блок в «Статистике», отключение. */
import { expect, test, type Page } from '@playwright/test';

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
}

/** Закрыть приветственные задачи «Сегодня»: дальше число выполненных считает сам тест. */
async function clearToday(page: Page) {
  await page.goto('/#/today');
  const rows = page.locator('.task');
  await expect(rows.first()).toBeVisible();
  for (let n = await rows.count(); n > 0; n--) {
    await rows.first().getByRole('button', { name: 'Выполнить' }).click();
    await expect(rows).toHaveCount(n - 1);
  }
}

async function addToday(page: Page, title: string) {
  await page.goto('/#/today');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill(`${title} сегодня`);
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await expect(page.locator('.task', { hasText: title })).toBeVisible();
}

async function complete(page: Page, title: string) {
  await page.locator('.task', { hasText: title }).getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.task', { hasText: title })).toHaveCount(0);
}

/** Сколько задач выполнено, по «Статистике». */
async function doneCount(page: Page): Promise<number> {
  await page.goto('/#/stats');
  const text = (await page.getByText(/Всего выполнено: |Выполняйте задачи/).first().textContent()) ?? '';
  return Number(/Всего выполнено: (\d+)/.exec(text)?.[1] ?? 0);
}

test.describe.configure({ timeout: 180_000 });

const milestoneToast = (page: Page) => page.locator('.toast').filter({ hasText: 'Новая веха' });

test('веха «10 задач»: один скромный тост и блок в статистике', async ({ page }) => {
  await start(page);
  await clearToday(page);
  const n = await doneCount(page);
  for (let k = 0; n + k < 9; k++) {
    await addToday(page, `Дело ${k}`);
    await complete(page, `Дело ${k}`);
  }
  await expect(milestoneToast(page)).toHaveCount(0);
  await addToday(page, 'Десятое');
  await complete(page, 'Десятое');
  await expect(milestoneToast(page)).toContainText('Новая веха: Выполнено задач: 10');

  await page.goto('/#/stats');
  await expect(page.getByRole('heading', { name: 'Вехи' })).toBeVisible();
  await expect(page.locator('[data-milestone="tasks:10"]')).toContainText('Выполнено задач: 10');
  // Ближайшая одна (по доле порога): сто задач или полсотни из «Входящих».
  await expect(page.locator('[data-milestone-next]')).toHaveCount(1);
  await expect(page.locator('[data-milestone-next]')).toContainText('Осталось:');

  // Следующее выполнение вехи не повторяет.
  await addToday(page, 'Одиннадцатое');
  await complete(page, 'Одиннадцатое');
  await expect(page.locator('.toast', { hasText: 'Задача выполнена' })).toBeVisible();
  await expect(milestoneToast(page)).toHaveCount(0);

  // Выключатель убирает блок.
  await page.goto('/#/settings');
  await page.getByLabel('Вехи в статистике').uncheck();
  await page.goto('/#/stats');
  await expect(page.getByRole('heading', { name: 'Вехи' })).toHaveCount(0);
});

test('вехи выключены: ни тоста, ни блока', async ({ page }) => {
  await start(page);
  await page.goto('/#/settings');
  await page.getByLabel('Вехи в статистике').uncheck();
  await clearToday(page);
  const n = await doneCount(page);
  for (let k = 0; n + k < 12; k++) {
    await addToday(page, `Дело ${k}`);
    await complete(page, `Дело ${k}`);
    await expect(milestoneToast(page)).toHaveCount(0);
  }
  await page.goto('/#/stats');
  await expect(page.getByText(/Всего выполнено: /)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Вехи' })).toHaveCount(0);
});
