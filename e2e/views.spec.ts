/**
 * Группировка и сортировка в списках и «Сегодня» доской по приоритетам (без сервера).
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

async function addTasks(page: Page, lines: string[]) {
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, lines.join('\n'));
  await page.getByRole('button', { name: 'Добавить все' }).click();
}

test('группировка по приоритету показывает заголовки групп и запоминается', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startLocal(page);
  await addTasks(page, ['Срочный отчёт сегодня !1', 'Полить цветы', 'Позвонить в банк !2']);
  await page.goto('/#/inbox');
  await expect(page.locator('.task', { hasText: 'Полить цветы' })).toBeVisible();

  await page.locator('.view-opts summary').click();
  await page.getByLabel('Группировать').selectOption('priority');
  const group = (title: string) => page.locator('.task-group', { has: page.getByRole('heading', { name: title }) });
  await expect(group('Приоритет 1')).toContainText('Срочный отчёт');
  await expect(group('Приоритет 2')).toContainText('Позвонить в банк');
  await expect(group('Приоритет 4')).toContainText('Полить цветы');
  await expect(group('Приоритет 3')).toHaveCount(0);
  await shot(page, 'views-group-1440.png');

  // Бросок задачи на заголовок группы меняет приоритет.
  await page.locator('.task', { hasText: 'Полить цветы' }).dragTo(page.getByRole('heading', { name: 'Приоритет 2' }));
  await expect(group('Приоритет 2')).toContainText('Полить цветы');

  // Выбор хранится на устройстве для этого экрана.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Приоритет 1' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.view-opts summary').click();
  await expect(page.getByLabel('Сортировать')).toBeVisible();
  await shot(page, 'views-group-390.png');
});

test('«Сегодня» доской: перенос карточки в колонку меняет приоритет', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startLocal(page);
  await addTasks(page, ['Разобрать почту сегодня', 'Сдать отчёт сегодня !1']);
  await page.goto('/#/today');
  await page.getByRole('button', { name: 'Доска' }).click();
  const column = (p: number) => page.locator(`.column[data-priority="${p}"]`);
  await expect(page.locator('.today-board .column')).toHaveCount(4);
  await expect(column(1)).toContainText('Сдать отчёт');
  await expect(column(4)).toContainText('Разобрать почту');
  await shot(page, 'today-board-1440.png');

  await page.locator('.task', { hasText: 'Разобрать почту' }).dragTo(column(2));
  await expect(column(2)).toContainText('Разобрать почту');
  await expect(column(4)).not.toContainText('Разобрать почту');

  // В карточке задачи приоритет тоже новый.
  await page.locator('.task', { hasText: 'Разобрать почту' }).click();
  await expect(page.locator('.prio-btn.prio-2.active')).toBeVisible();

  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(column(2)).toContainText('Разобрать почту');
  await shot(page, 'today-board-390.png');
});
