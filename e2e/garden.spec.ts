/** Сад: экран открывается быстро, сегодняшнее растение растёт от выполненных задач, выключатель убирает сад. */
import { expect, test, type Page } from '@playwright/test';

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
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

const todaySlot = (page: Page) => page.locator('.g-slot.is-today');

test('сад: 12 недель грядками, отрисовка быстрее 50 мс', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  await page.getByRole('link', { name: 'Сад', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Сад' })).toBeVisible();
  await expect(page.locator('.g-bed')).toHaveCount(12);
  await expect(page.locator('.g-slot')).toHaveCount(84);
  await expect(todaySlot(page)).toHaveCount(1);
  // Будущие дни недели — пустые места без подсказки.
  await expect(page.locator('.g-slot.is-future').first()).toBeDisabled();

  // Время от смены экрана до готовой разметки 84 мест (без анимации перехода).
  await page.goto('/#/today');
  await expect(page.locator('.task').first()).toBeVisible();
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const ms = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const t0 = performance.now();
          const done = () => document.querySelectorAll('.g-slot').length === 84;
          const mo = new MutationObserver(() => {
            if (!done()) return;
            mo.disconnect();
            resolve(performance.now() - t0);
          });
          mo.observe(document.body, { childList: true, subtree: true });
          location.hash = '#/garden';
        }),
    );
    times.push(ms);
    await page.goto('/#/today');
    await expect(page.locator('.task').first()).toBeVisible();
  }
  console.log(`сад: ${times.map((t) => t.toFixed(1)).join(', ')} мс`);
  expect(Math.min(...times)).toBeLessThan(50);
});

test('сегодняшнее растение меняется после выполнения задачи', async ({ page }) => {
  await start(page);
  await addToday(page, 'Полить цветы');
  await page.goto('/#/garden');
  const before = Number(await todaySlot(page).getAttribute('data-done'));

  await page.goto('/#/today');
  const mini = page.locator('.garden-mini');
  await expect(mini).toHaveAttribute('data-done', String(before));
  await page.locator('.task', { hasText: 'Полить цветы' }).getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.task', { hasText: 'Полить цветы' })).toHaveCount(0);
  // Миниатюра в «Сегодня» выросла на глазах и ведёт в сад.
  await expect(mini).toHaveAttribute('data-done', String(before + 1));
  await expect(mini).not.toHaveAttribute('data-stage', '0');
  await mini.click();
  await expect(page).toHaveURL(/#\/garden$/);
  await expect(todaySlot(page)).toHaveAttribute('data-done', String(before + 1));
  await expect(todaySlot(page)).not.toHaveAttribute('data-stage', '0');

  // Касание растения — подсказка с числом выполненных.
  await todaySlot(page).click();
  await expect(page.locator('.g-tip')).toContainText(`Выполнено: ${before + 1}`);
});

test('сад выключен: ни пункта, ни миниатюры, ни команды', async ({ page }) => {
  await start(page);
  await page.goto('/#/settings');
  await page.getByLabel('Сад', { exact: true }).uncheck();
  await page.goto('/#/today');
  await expect(page.locator('.task').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Сад', exact: true })).toHaveCount(0);
  await expect(page.locator('.garden-mini')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Сад');
  await expect(page.locator('.cmd', { hasText: /^Сад$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/#/garden');
  await expect(page.getByText('Сад выключен в настройках.')).toBeVisible();
  await expect(page.locator('.g-bed')).toHaveCount(0);
});
