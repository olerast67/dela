/**
 * Жесты на телефоне: смахивание карточки вправо выполняет задачу, влево открывает лист переноса.
 * Касания имитируются событиями указателя с pointerType «touch».
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

async function swipe(page: Page, target: Locator, dx: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await target.evaluate(
    (el, { x, y, dx }) => {
      const fire = (type: string, cx: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, clientX: cx, clientY: y, bubbles: true, isPrimary: true }));
      fire('pointerdown', x);
      for (let i = 1; i <= 8; i++) fire('pointermove', x + (dx * i) / 8);
      fire('pointerup', x + dx);
    },
    { x, y, dx },
  );
}

test('смахивание: вправо выполнить, влево перенести', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`swipe-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('swipe-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('swipe-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();

  const subscribe = page.locator('.task', { hasText: 'Подписаться на olerast' });
  await expect(subscribe).toBeVisible();
  // Короткое смахивание не срабатывает.
  await swipe(page, subscribe, 40);
  await expect(subscribe).toBeVisible();
  await expect(page.locator('.panel')).toHaveCount(0);

  await swipe(page, subscribe, 140);
  await expect(page.getByText('Задача выполнена')).toBeVisible();
  await expect(subscribe).toHaveCount(0);

  const phrase = page.locator('.task', { hasText: 'Добавить задачу фразой' });
  await swipe(page, phrase, -140);
  const sheet = page.getByRole('dialog', { name: 'Перенести задачу' });
  await expect(sheet).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/sheet.png' });
  await sheet.getByRole('button', { name: /Завтра/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(phrase).toHaveCount(0);
  await page.getByRole('link', { name: 'Скоро' }).click();
  await expect(page.locator('.task', { hasText: 'Добавить задачу фразой' })).toBeVisible();

  // Карточка задачи открывается листом снизу и закрывается, если потянуть полоску вниз.
  await page.locator('.task', { hasText: 'Добавить задачу фразой' }).click();
  const panel = page.locator('.panel');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(400);
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/panel-sheet.png' });
  const grip = (await page.locator('.panel-grip').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 10);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 220, { steps: 6 });
  await page.mouse.up();
  await expect(panel).toHaveCount(0);
});
