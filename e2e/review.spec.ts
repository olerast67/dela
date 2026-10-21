/** Итоги недели (6.3): карточка в «Сегодня» в выбранный день, экран итогов, действия у часто переносимых задач. */
import { expect, test, type Page } from '@playwright/test';

const msk = (s: string) => new Date(`${s}+03:00`);

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
}

async function add(page: Page, text: string) {
  await page.goto('/#/today');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill(text);
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
}

/** Перенести срок задачи по одному дню через поле даты в карточке. */
async function postpone(page: Page, title: string, dates: string[]) {
  await page.locator('.task', { hasText: title }).getByText(title).click();
  const panel = page.locator('.panel');
  for (const d of dates) await panel.getByLabel('Дата', { exact: true }).fill(d);
  await panel.getByRole('button', { name: 'Закрыть' }).first().click();
  await expect(panel).toHaveCount(0);
}

test('карточка «Итоги недели готовы» появляется в воскресенье после 19:00', async ({ page }) => {
  await page.clock.install({ time: msk('2026-10-18T18:00:00') });
  await start(page);
  await page.goto('/#/today');
  await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible();
  await expect(page.locator('.review-card')).toHaveCount(0);

  await page.clock.setSystemTime(msk('2026-10-18T19:05:00'));
  await page.reload();
  const card = page.locator('.review-card');
  await expect(card).toContainText('Итоги недели готовы');
  await expect(card).toContainText('Неделя 12–18 октября');
  await card.getByRole('link', { name: 'Открыть' }).click();
  await expect(page).toHaveURL(/#\/review\/2026-10-12$/);
  await expect(page.getByRole('heading', { name: 'Неделя 12–18 октября' })).toBeVisible();
  // Открытые итоги карточку больше не показывают, и после перезагрузки тоже.
  await page.goto('/#/today');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible();
  await expect(page.locator('.review-card')).toHaveCount(0);

  // Из «Статистики»: список прошлых недель.
  await page.goto('/#/stats');
  await page.getByRole('link', { name: 'Итоги недель' }).click();
  await expect(page.getByRole('heading', { name: 'Итоги недель' })).toBeVisible();
  await expect(page.locator('.review-weeks li')).toHaveCount(12);
  await expect(page.locator('.review-weeks li').first()).toContainText('Неделя 12–18 октября');
});

test('без итогов недели в настройках карточки нет', async ({ page }) => {
  await page.clock.install({ time: msk('2026-10-18T18:00:00') });
  await start(page);
  await page.goto('/#/settings');
  await page.getByLabel('Итоги недели', { exact: true }).uncheck();
  await page.waitForTimeout(500);
  await page.clock.setSystemTime(msk('2026-10-18T19:05:00'));
  await page.goto('/#/today');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible();
  await expect(page.locator('.review-card')).toHaveCount(0);
  // По прямой ссылке экран открывается.
  await page.goto('/#/review/2026-10-12');
  await expect(page.getByRole('heading', { name: 'Неделя 12–18 октября' })).toBeVisible();
});

test('экран итогов: числа, «Часто переносятся», «Разбить на шаги» и «Удалить»', async ({ page }) => {
  await page.clock.install({ time: msk('2026-10-01T12:00:00') });
  await start(page);
  await add(page, 'Разобрать кладовку');
  await page.clock.setSystemTime(msk('2026-10-13T12:00:00'));
  await add(page, 'Заплатить налоги сегодня');
  await add(page, 'Починить кран сегодня');
  await postpone(page, 'Заплатить налоги', ['2026-10-14', '2026-10-15', '2026-10-16']);
  await postpone(page, 'Починить кран', ['2026-10-14', '2026-10-15', '2026-10-16']);
  await page.goto('/#/inbox');
  await page.locator('.task', { hasText: 'Разобрать кладовку' }).getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.task', { hasText: 'Разобрать кладовку' })).toHaveCount(0);

  await page.goto('/#/review/2026-10-12');
  await expect(page.getByRole('heading', { name: 'Неделя 12–18 октября' })).toBeVisible();
  await expect(page.locator('.review-numbers')).toContainText('1');
  const waited = page.locator('section', { has: page.getByRole('heading', { name: 'Больше всего ждали' }) });
  await expect(waited).toContainText('Разобрать кладовку');
  await expect(waited).toContainText('12 дней от создания до выполнения');
  const postponed = page.locator('.review-postponed');
  await expect(postponed).toHaveCount(2);
  await expect(postponed.first()).toContainText('переносилась 3 раза');

  // «Разбить на шаги»: карточка задачи с полем подзадачи в фокусе.
  await postponed.filter({ hasText: 'Починить кран' }).getByRole('button', { name: 'Разбить на шаги' }).click();
  const panel = page.locator('.panel');
  await expect(panel.getByPlaceholder('Подзадача')).toBeFocused();
  await panel.getByRole('button', { name: 'Закрыть' }).first().click();

  // «Удалить»: задача уходит в корзину, отмена возвращает.
  await page.goto('/#/review/2026-10-12');
  await postponed.filter({ hasText: 'Заплатить налоги' }).getByRole('button', { name: 'Удалить' }).click();
  await expect(page.locator('.review-postponed', { hasText: 'Заплатить налоги' })).toHaveCount(0);
  await expect(page.getByText('Задача удалена')).toBeVisible();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.locator('.review-postponed', { hasText: 'Заплатить налоги' })).toHaveCount(1);
  await postponed.filter({ hasText: 'Заплатить налоги' }).getByRole('button', { name: 'Удалить' }).click();
  await expect(page.locator('.review-postponed', { hasText: 'Заплатить налоги' })).toHaveCount(0);
  await page.goto('/#/trash');
  await expect(page.locator('.trash-row', { hasText: 'Заплатить налоги' })).toBeVisible();

  // «Оставить»: счёт переносов начинается заново.
  await page.goto('/#/review/2026-10-12');
  await page.locator('.review-postponed', { hasText: 'Починить кран' }).getByRole('button', { name: 'Оставить' }).click();
  await expect(page.locator('.review-postponed')).toHaveCount(0);
});

// Снимки для проверки вёрстки глазами: DELA_REVIEW_SHOTS=<папка> npx playwright test review
test('снимки экрана итогов', async ({ page }) => {
  const dir = process.env.DELA_REVIEW_SHOTS;
  test.skip(!dir, 'снимки только по запросу');
  await page.clock.install({ time: msk('2026-09-20T12:00:00') });
  await start(page);
  await add(page, 'Разобрать кладовку');
  await add(page, 'Записаться к стоматологу');
  await page.clock.setSystemTime(msk('2026-10-08T12:00:00'));
  await add(page, 'Обновить резюме');
  await page.clock.setSystemTime(msk('2026-10-12T10:00:00'));
  await add(page, 'Заплатить налоги сегодня');
  await add(page, 'Написать отчёт по проекту сегодня');
  await add(page, 'Позвонить в управляющую компанию в среду');
  await postpone(page, 'Заплатить налоги', ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  await postpone(page, 'Написать отчёт', ['2026-10-13', '2026-10-15', '2026-10-17']);
  await page.clock.setSystemTime(msk('2026-10-15T12:00:00'));
  await page.goto('/#/inbox');
  for (const t of ['Разобрать кладовку', 'Записаться к стоматологу', 'Обновить резюме']) {
    const row = page.locator('.task', { hasText: t });
    if (await row.count()) await row.getByRole('button', { name: 'Выполнить' }).click();
    await page.waitForTimeout(400);
  }
  await page.clock.setSystemTime(msk('2026-10-18T19:30:00'));
  // Перезагрузка убирает тосты выполнения.
  await page.reload();
  const sizes = [
    [390, 844],
    [1280, 860],
  ] as const;
  // Сначала карточка в «Сегодня»: открытые итоги её скрывают.
  for (const [w, h] of sizes) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/#/today');
      await expect(page.locator('.review-card')).toBeVisible();
      await page.screenshot({ path: `${dir}/today-${w}-${scheme}.png` });
    }
  }
  for (const [w, h] of sizes) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/#/review/2026-10-12');
      await expect(page.getByRole('heading', { name: 'Неделя 12–18 октября' })).toBeVisible();
      await page.screenshot({ path: `${dir}/review-${w}-${scheme}.png` });
      await page.locator('.content').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.screenshot({ path: `${dir}/review-${w}-${scheme}-end.png` });
      await page.goto('/#/review');
      await page.screenshot({ path: `${dir}/weeks-${w}-${scheme}.png` });
    }
  }
});
