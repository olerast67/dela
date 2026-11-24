/**
 * План дня (фаза 7): «Уложить» выделенные задачи во «Входящих», лента справа, «+15» и отмена одним Ctrl+Z.
 */
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/shots';

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${name}` });
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

test('«Уложить» с 9:00 ставит задачи встык, «+15» сдвигает, Ctrl+Z возвращает', async ({ page }) => {
  // Утро 24 ноября по Москве: дела в 9:00 ещё впереди.
  await page.clock.install({ time: new Date('2026-11-24T08:00:00+03:00') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.goto('/#/inbox');
  await expect(page.getByRole('heading', { name: 'Входящие' })).toBeVisible();
  await addTasks(page, ['Банк', 'Созвон с юристом', 'Почта']);

  const row = (title: string) => page.locator('.content .task', { hasText: title });
  await row('Банк').click({ modifiers: ['Control'] });
  await row('Созвон с юристом').click({ modifiers: ['Control'] });
  await row('Почта').click({ modifiers: ['Control'] });
  await page.locator('.selection-bar').getByRole('button', { name: 'Уложить' }).click();
  const pop = page.locator('.pack-pop');
  await pop.getByLabel('Начало').fill('09:00');
  await pop.getByRole('button', { name: 'Уложить' }).click();

  // Лента стоит справа от списка; длительность по умолчанию 15 минут.
  const ribbon = page.locator('.plan-side .ribbon');
  const plan = (title: string) => ribbon.locator('.rb-task', { hasText: title }).locator('.rb-time');
  await expect(plan('Банк')).toHaveText('09:00');
  await expect(plan('Созвон с юристом')).toHaveText('09:15');
  await expect(plan('Почта')).toHaveText('09:30');
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await shot(page, 'plan-inbox-1440.png');

  await ribbon.getByRole('button', { name: '+15' }).click();
  await expect(plan('Банк')).toHaveText('09:15');
  await expect(plan('Созвон с юристом')).toHaveText('09:30');
  await expect(plan('Почта')).toHaveText('09:45');

  // Одна запись отмены на всё действие.
  await page.locator('h1').click();
  await page.keyboard.press('Control+z');
  await expect(plan('Банк')).toHaveText('09:00');
  await expect(plan('Почта')).toHaveText('09:30');

  // Выполненное дело остаётся в ленте отмеченным.
  await ribbon.locator('.rb-task', { hasText: 'Почта' }).locator('.rb-check').click();
  await page.locator('.content .task', { hasText: 'Почта' }).waitFor({ state: 'detached' });
  await expect(ribbon.locator('.rb-task.done', { hasText: 'Почта' })).toBeVisible();

  // На телефоне лента открывается вкладкой «План».
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('.plan-side')).toHaveCount(0);
  await page.getByRole('button', { name: 'План', exact: true }).click();
  await expect(page.locator('.ribbon .rb-task', { hasText: 'Банк' }).locator('.rb-time')).toHaveText('09:00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'plan-inbox-375.png');
});

test('цепочка в быстром добавлении: время видно до сохранения, дела встают встык', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-24T07:00:00+03:00') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('сегодня в 9 банк 30м потом созвон 20м потом почта');
  const chain = page.locator('.qa-chain li');
  await expect(chain).toHaveCount(3);
  await expect(chain.nth(0)).toContainText('09:00');
  await expect(chain.nth(1)).toContainText('09:30');
  await expect(chain.nth(2)).toContainText('09:50');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');

  // «Сегодня» лентой: дела по порядку, между ними нет дыр.
  await page.goto('/#/today');
  await page.getByRole('group', { name: 'Вид' }).getByRole('button', { name: 'Лента' }).click();
  const ribbon = page.locator('.ribbon');
  await expect(ribbon.locator('.rb-task .rb-time')).toHaveText(['09:00', '09:30', '09:50']);
  await expect(ribbon.locator('.rb-free')).toHaveCount(0);
});
