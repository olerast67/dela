/**
 * Календарь: задача из строки «Весь день» перетаскивается в сетку часов и получает время,
 * задача в месяце переносится на другой день, растягивание меняет длительность.
 */
import { expect, test, type Page } from '@playwright/test';

async function register(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`cal-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('calendar-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('calendar-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();
}

async function addTask(page: Page, text: string) {
  await page.keyboard.press('q');
  const input = page.getByLabel('Новая задача');
  await input.fill(text);
  await input.press('Enter');
  await input.press('Escape');
}

test('календарь: планирование дня перетаскиванием', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await register(page);
  await addTask(page, 'Разобрать почту сегодня');
  await addTask(page, 'Созвон с командой сегодня в 10:00-11:30');
  await addTask(page, 'Записать ролик завтра в 15');

  await page.goto('/#/calendar/week');
  const grid = page.locator('.cal-time-grid');
  await expect(grid.locator('.cal-block', { hasText: 'Созвон с командой' })).toBeVisible();
  await expect(grid.locator('.cal-block', { hasText: 'Созвон с командой' })).toContainText('10:00-11:30');
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/cal-week.png' });

  // Из «Весь день» в сетку: задача получает время.
  const chip = grid.locator('.cal-allday .cal-chip', { hasText: 'Разобрать почту' });
  const today = grid.locator('.cal-col.today');
  const box = (await today.boundingBox())!;
  await chip.dragTo(today, { targetPosition: { x: 20, y: 48 * 14 + 2 } });
  await expect(grid.locator('.cal-block', { hasText: 'Разобрать почту' })).toContainText('14:00-14:30');
  expect(box.height).toBeGreaterThan(1000);

  // Растягивание за нижний край: полчаса превращаются в час.
  const block = grid.locator('.cal-block', { hasText: 'Разобрать почту' });
  const handle = block.locator('.cal-resize');
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 24, { steps: 4 });
  await page.mouse.up();
  await expect(block).toContainText('14:00-15:00');

  // День: обратно в «Весь день» без времени.
  await page.getByRole('tab', { name: 'День' }).click();
  await page.locator('.cal-block', { hasText: 'Разобрать почту' }).dragTo(page.locator('.cal-allday-cell').first());
  await expect(page.locator('.cal-allday .cal-chip', { hasText: 'Разобрать почту' })).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/cal-day.png' });

  // Месяц: перенос на другой день сохраняет время.
  await page.getByRole('tab', { name: 'Месяц' }).click();
  const ролик = page.locator('.cal-month .cal-chip', { hasText: 'Записать ролик' });
  await expect(ролик).toContainText('15:00');
  const cells = page.locator('.cal-cell:not(.other)');
  const target = cells.nth(27);
  await ролик.dragTo(target);
  await expect(target.locator('.cal-chip', { hasText: 'Записать ролик' })).toContainText('15:00');
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/cal-month.png' });

  // Щелчок по пустому часу открывает быстрое добавление с этим временем.
  await page.getByRole('tab', { name: 'Неделя' }).click();
  await page.locator('.cal-col.today').click({ position: { x: 30, y: 48 * 18 + 10 } });
  const input = page.getByLabel('Новая задача');
  await input.fill('Вечерняя прогулка');
  await input.press('Enter');
  await input.press('Escape');
  await expect(page.locator('.cal-block', { hasText: 'Вечерняя прогулка' })).toContainText('18:00-18:30');
});
