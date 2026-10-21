/** Игровые элементы: «День закрыт» при закрытии последней задачи «Сегодня», отдельные выключатели и общий. */
import { expect, test, type Page } from '@playwright/test';

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
}

/** Закрыть приветственные задачи экрана: дальше его наполняет сам тест. */
async function clearToday(page: Page, route = 'today') {
  await page.goto(`/#/${route}`);
  const rows = page.locator('.task');
  // Приветственные задачи есть всегда: ждём, пока список отрисуется.
  await expect(rows.first()).toBeVisible();
  for (let n = await rows.count(); n > 0; n--) {
    await rows.first().getByRole('button', { name: 'Выполнить' }).click();
    await expect(rows).toHaveCount(n - 1);
  }
  await expect(page.locator('.confetti')).toHaveCount(0, { timeout: 3000 });
}

async function addToday(page: Page, title: string) {
  await page.goto('/#/today');
  // Фокус в поле настроек перехватил бы клавишу Q.
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

test('«День закрыт» при закрытии последней задачи «Сегодня», без празднований — нет', async ({ page }) => {
  await start(page);
  await expect(page.locator('html')).toHaveAttribute('data-game', '');
  await clearToday(page);
  await addToday(page, 'Полить цветы');
  await addToday(page, 'Купить хлеб');
  await complete(page, 'Полить цветы');
  // Не последняя задача — празднования нет.
  await expect(page.locator('.confetti')).toHaveCount(0);
  await complete(page, 'Купить хлеб');
  await expect(page.locator('.day-done.celebrate')).toContainText('День закрыт');
  // Не мешает работе: нажатия проходят насквозь, само уходит.
  await expect(page.locator('.confetti')).toHaveCSS('pointer-events', 'none');
  await expect(page.locator('.confetti')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('.day-done.celebrate')).toHaveCount(0);
  await expect(page.getByText('Выполнено сегодня: 4.')).toBeVisible();

  await page.goto('/#/settings');
  await page.getByLabel('Празднование «День закрыт»').uncheck();
  await addToday(page, 'Позвонить маме');
  await complete(page, 'Позвонить маме');
  // Спокойный экран остаётся, вспышки нет.
  await expect(page.locator('.day-done')).toBeVisible();
  await expect(page.locator('.day-done.celebrate')).toHaveCount(0);
  await expect(page.locator('.confetti')).toHaveCount(0);
});

test('общий выключатель скрывает игровые элементы', async ({ page }) => {
  await start(page);
  await page.goto('/#/settings');
  await expect(page.getByLabel('Тихий звук при выполнении')).toBeVisible();
  await page.getByLabel('Отклик при выполнении, цели и итоги').uncheck();
  await expect(page.getByLabel('Тихий звук при выполнении')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Цели' })).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-game');
  // Настройка переживает перезагрузку: она в зашифрованных данных пространства.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByLabel('Отклик при выполнении, цели и итоги')).not.toBeChecked();

  await clearToday(page);
  await addToday(page, 'Полить цветы');
  await complete(page, 'Полить цветы');
  await expect(page.getByText('Задача выполнена')).toBeVisible();
  await expect(page.locator('.confetti')).toHaveCount(0);
  await expect(page.locator('.day-done')).toHaveCount(0);
  // Пустые экраны прежние.
  await expect(page.getByText('На сегодня всё. Новые задачи с датой «сегодня» появятся здесь.')).toBeVisible();
  await clearToday(page, 'inbox');
  await expect(page.getByText('Входящие пусты. Всё, что не разобрано по проектам, попадает сюда.')).toBeVisible();

  await page.goto('/#/settings');
  await page.getByLabel('Отклик при выполнении, цели и итоги').check();
  await expect(page.locator('html')).toHaveAttribute('data-game', '');
  await page.goto('/#/inbox');
  await expect(page.getByText('Во «Входящих» пусто: всё разобрано.', { exact: false })).toBeVisible();
});

test('цели, выходные и отпуск в настройках', async ({ page }) => {
  await start(page);
  await page.goto('/#/settings');
  const goal = page.getByLabel('Цель на день, задач');
  await goal.fill('60');
  await expect(goal).toHaveAttribute('aria-invalid', 'true');
  await goal.fill('6');
  await expect(goal).not.toHaveAttribute('aria-invalid');
  await page.getByRole('button', { name: 'Суббота' }).click();
  await expect(page.getByRole('button', { name: 'Суббота' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Конец отпуска').fill('2030-01-10');
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByLabel('Цель на день, задач')).toHaveValue('6');
  await expect(page.getByRole('button', { name: 'Суббота' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Конец отпуска')).toHaveValue('2030-01-10');
  await page.getByRole('button', { name: 'Без отпуска' }).click();
  await expect(page.getByLabel('Конец отпуска')).toHaveValue('');
});

test('цель дня: полоска «из», при выполнении — акцент и «Цель дня выполнена»; выключено — полоски нет', async ({ page }) => {
  await start(page);
  await page.goto('/#/settings');
  await page.getByLabel('Цель на день, задач').fill('2');
  await addToday(page, 'Полить цветы');
  await addToday(page, 'Купить хлеб');
  // Приветственные задачи остаются в «Сегодня»: день не закрыт, кольцо заменено полоской.
  const bar = page.locator('.today-head .goal-bar');
  await expect(bar).toHaveAttribute('aria-label', 'Цель дня: 0 из 2');
  await expect(page.locator('.today-head .ring')).toHaveCount(0);
  await complete(page, 'Полить цветы');
  await expect(bar).toHaveAttribute('aria-label', 'Цель дня: 1 из 2');
  await expect(bar).not.toHaveClass(/met/);
  await complete(page, 'Купить хлеб');
  await expect(bar).toHaveAttribute('aria-label', 'Цель дня: 2 из 2');
  await expect(bar).toHaveClass(/met/);
  await expect(page.locator('.goal-burst')).toContainText('Цель дня выполнена');
  // Без конфетти, и надпись уходит сама.
  await expect(page.locator('.confetti')).toHaveCount(0);
  await expect(page.locator('.goal-burst')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('.goal-fill')).toHaveAttribute('style', /--p: 1/);

  await page.goto('/#/stats');
  await expect(page.getByRole('heading', { name: 'Цели' })).toBeVisible();
  await expect(page.locator('.goal-day.is-today')).toHaveClass(/g-done/);

  await page.goto('/#/settings');
  await page.getByLabel('Отклик при выполнении, цели и итоги').uncheck();
  await page.goto('/#/today');
  await expect(page.locator('.goal-bar')).toHaveCount(0);
  await expect(page.locator('.today-head .ring')).toBeVisible();
  await page.goto('/#/stats');
  await expect(page.getByRole('heading', { name: 'Цели' })).toHaveCount(0);
});
