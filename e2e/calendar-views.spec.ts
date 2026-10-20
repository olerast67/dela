/**
 * Календарь без сервера: режим «3 дня», панель «Не запланировано» с перетаскиванием на сетку,
 * цвет по проекту и скрытие будущих повторов.
 */
import { expect, test, type Page } from '@playwright/test';

// Папка для снимков проверки вёрстки: SHOTS=1 включает их, SHOTS_DIR меняет папку.
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/shots';

/** Снимок для проверки вёрстки глазами (SHOTS=1); пауза даёт закончиться переходу между экранами. */
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

async function startLocal(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
}

async function addTask(page: Page, text: string) {
  await page.keyboard.press('q');
  const input = page.getByLabel('Новая задача');
  await input.fill(text);
  await input.press('Enter');
  await input.press('Escape');
}

test('календарь: три дня и задачи без даты из боковой панели', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startLocal(page);
  // Во «Входящих» быстрое добавление не ставит дату «сегодня», как на экране «Сегодня».
  await page.goto('/#/inbox');
  await addTask(page, 'Купить батарейки');
  await addTask(page, 'Починить кран');

  await page.goto('/#/calendar/3day');
  const grid = page.locator('.cal-time-grid');
  await expect(grid.locator('.cal-date')).toHaveCount(3);
  await expect(grid.locator('.cal-col')).toHaveCount(3);
  await expect(grid.locator('.cal-col').first()).toHaveClass(/today/);
  await expect(page.getByRole('tab', { name: '3 дня' })).toHaveAttribute('aria-selected', 'true');

  // Панель на широком экране открыта: задача без даты перетаскивается на час.
  const side = page.locator('.cal-side');
  await expect(side.locator('.cal-chip', { hasText: 'Купить батарейки' })).toBeVisible();
  await shot(page, 'cal-3day-1440.png');
  const col = grid.locator('.cal-col').nth(1);
  await side.locator('.cal-chip', { hasText: 'Купить батарейки' }).dragTo(col, { targetPosition: { x: 20, y: 48 * 14 + 2 } });
  await expect(grid.locator('.cal-block', { hasText: 'Купить батарейки' })).toContainText('14:00-14:30');
  await expect(side.locator('.cal-chip', { hasText: 'Купить батарейки' })).toHaveCount(0);

  // Месяц: бросок на день даёт дату без времени.
  await page.getByRole('tab', { name: 'Месяц' }).click();
  const cell = page.locator('.cal-cell:not(.other)').nth(27);
  await side.locator('.cal-chip', { hasText: 'Починить кран' }).dragTo(cell);
  await expect(cell.locator('.cal-chip', { hasText: 'Починить кран' })).toBeVisible();
  await expect(side.locator('.cal-chip', { hasText: 'Починить кран' })).toHaveCount(0);
  await shot(page, 'cal-month-side-1440.png');

  // Узкий экран: панель прячется за кнопкой.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/calendar/3day');
  await expect(page.locator('.cal-side')).toHaveCount(0);
  await expect(page.locator('.cal-time-grid .cal-date')).toHaveCount(3);
  await shot(page, 'cal-3day-390.png');
  await page.getByRole('button', { name: /Не запланировано/ }).click();
  await expect(page.locator('.cal-side.sheet')).toBeVisible();
  await shot(page, 'cal-side-390.png');
});

test('календарь: цвет по проекту и скрытие будущих повторов', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startLocal(page);
  await addTask(page, 'Зарядка каждый день');
  await page.goto('/#/calendar/week');
  const chips = page.locator('.cal-time-grid .cal-chip', { hasText: 'Зарядка' });
  await expect.poll(() => chips.count()).toBeGreaterThan(1);

  await page.locator('.cal-head .view-opts summary').click();
  await page.getByLabel('Скрыть будущие повторы').check();
  await expect(chips).toHaveCount(1);
  await page.getByLabel('Цвет задач').selectOption('project');
  await expect(chips.first()).toHaveClass(/by-project/);
  await shot(page, 'cal-options-1440.png');

  // Настройки хранятся на устройстве.
  await page.reload();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveClass(/by-project/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.cal-head .view-opts summary').click();
  await expect(page.getByLabel('Цвет задач')).toBeVisible();
  await shot(page, 'cal-options-390.png');
});
