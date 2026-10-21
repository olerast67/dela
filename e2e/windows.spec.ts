/**
 * Окна программы для Windows в браузере: всплывающая строка быстрого добавления (?quick=1)
 * и отдельное окно задачи (?window=1#/task/<id>). Та же база, что у главной вкладки.
 */
import { expect, test, type Page } from '@playwright/test';

// Папка для снимков проверки вёрстки: SHOTS=1 включает их, SHOTS_DIR меняет папку.
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/shots';

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

async function startLocal(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
}

test('всплывающая строка: разбор фразы, задача сразу в главном окне, вставленный список', async ({ page, context }) => {
  await startLocal(page);
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByPlaceholder('Название проекта').fill('Дом');
  await page.getByPlaceholder('Название проекта').press('Enter');
  await page.goto('/#/inbox');

  const quick = await context.newPage();
  await quick.setViewportSize({ width: 600, height: 120 });
  await quick.goto('/?quick=1');
  const input = quick.getByLabel('Новая задача');
  await expect(input).toBeFocused();
  // Ни боковой панели, ни списка: только строка.
  await expect(quick.locator('.shell')).toHaveCount(0);
  await shot(quick, 'quick-empty.png');
  await input.fill('Купить лампочки завтра в 19 #Дом @магазин !2');
  await expect(quick.locator('.tok-date').first()).toBeVisible();
  await expect(quick.locator('.tok-project')).toHaveText('#Дом');
  await expect(quick.locator('.chip', { hasText: '# Дом' })).toBeVisible();
  await shot(quick, 'quick-parsed.png');
  await input.press('Enter');

  // Главное окно получает задачу без перезагрузки.
  await page.goto('/#/upcoming');
  await expect(page.locator('.task', { hasText: 'Купить лампочки' })).toBeVisible();

  // Многострочная вставка — список, как в обычном быстром добавлении.
  await quick.reload();
  await quick.getByLabel('Новая задача').evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, 'Полить цветы\nВынести мусор');
  await expect(quick.getByText('Вставлен список: 2 задачи')).toBeVisible();
  await quick.setViewportSize({ width: 600, height: 200 });
  await shot(quick, 'quick-list.png');
  await quick.getByRole('button', { name: 'Добавить все' }).click();
  await page.goto('/#/inbox');
  await expect(page.locator('.task', { hasText: 'Вынести мусор' })).toBeVisible();
});

test('всплывающая строка при включённом PIN закрыта и предлагает открыть главное окно', async ({ page, context }) => {
  await startLocal(page);
  await page.goto('/#/settings');
  const section = page.locator('section.settings', { hasText: 'Блокировка приложения' });
  await page.getByLabel('Новый PIN, 4-8 цифр').fill('2468');
  await page.getByLabel('PIN ещё раз').fill('2468');
  await section.getByRole('button', { name: 'Включить' }).click();
  await expect(page.getByText('Блокировка включена.')).toBeVisible();

  const quick = await context.newPage();
  await quick.setViewportSize({ width: 600, height: 120 });
  await quick.goto('/?quick=1');
  await expect(quick.getByRole('alert')).toContainText('Dela заблокирована PIN-кодом');
  await expect(quick.getByLabel('Новая задача')).toHaveCount(0);
  await expect(quick.getByRole('button', { name: 'Открыть Dela' })).toBeVisible();
  await shot(quick, 'quick-locked.png');
});

test('отдельное окно задачи: только карточка на всё окно', async ({ page, context }) => {
  await startLocal(page);
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Записаться к врачу');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  const row = page.locator('.task', { hasText: 'Записаться к врачу' });
  await expect(row).toBeVisible();
  const id = await row.getAttribute('data-id');

  const win = await context.newPage();
  await win.setViewportSize({ width: 420, height: 640 });
  await win.goto(`/?window=1#/task/${id}`);
  const panel = win.locator('.task-window .panel');
  await expect(panel.locator('.panel-title')).toHaveValue('Записаться к врачу');
  // Без списка за карточкой, без полоски листа и кнопки «В отдельном окне».
  await expect(win.locator('.content')).toHaveCount(0);
  await expect(win.locator('.panel-grip')).toHaveCount(0);
  await expect(win.getByRole('button', { name: 'В отдельном окне' })).toHaveCount(0);
  // Маршрут не уходит на список проекта.
  expect(new URL(win.url()).hash).toBe(`#/task/${id}`);
  const box = await panel.boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 420, height: 640 });
  await shot(win, 'task-window.png');

  // Правка в окне видна в главном окне.
  await panel.locator('.panel-title').fill('Записаться к стоматологу');
  await panel.locator('.panel-title').press('Enter');
  await expect(page.locator('.task', { hasText: 'Записаться к стоматологу' })).toBeVisible();
});

test('отдельное окно проекта на 420×640', async ({ page, context }) => {
  await startLocal(page);
  const win = await context.newPage();
  await win.setViewportSize({ width: 420, height: 640 });
  await win.goto(`/?window=1#/inbox`);
  await expect(win.locator('.shell.compact')).toBeVisible();
  await expect(win.locator('nav.sidebar')).toHaveCount(0);
  await shot(win, 'project-window.png');
  await win.locator('.task').first().click();
  await expect(win.locator('.panel')).toBeVisible();
  await shot(win, 'project-window-task.png');
});
