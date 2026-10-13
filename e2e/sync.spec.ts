/**
 * Сквозной тест в настоящем браузере: два устройства (два отдельных профиля),
 * регистрация, вход, правки онлайн и офлайн, сходимость.
 */
import { expect, test, type Page } from '@playwright/test';

const EMAIL = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@dela.test`;
const PASSWORD = 'e2e-password-123';

async function addTask(page: Page, text: string) {
  await page.keyboard.press('q');
  const input = page.getByLabel('Новая задача');
  await input.fill(text);
  await input.press('Enter');
  await input.press('Escape');
}

test('два устройства сходятся после офлайн-правок', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();

  // Устройство A: регистрация.
  await pa.goto('/');
  await pa.getByRole('button', { name: 'Создать аккаунт' }).click();
  await pa.getByLabel('Электронная почта').fill(EMAIL);
  await pa.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await pa.getByLabel('Пароль ещё раз').fill(PASSWORD);
  await pa.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(pa.getByRole('heading', { name: 'Сохраните ключ восстановления' })).toBeVisible({ timeout: 20_000 });
  await expect(pa.locator('.recovery-key')).toHaveText(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){10}$/);
  await pa.getByLabel('Ключ сохранён в надёжном месте').check();
  await pa.getByRole('button', { name: 'Продолжить' }).click();
  await expect(pa.getByRole('heading', { name: 'Сегодня' })).toBeVisible();

  await addTask(pa, 'Купить хлеб сегодня p1');
  await expect(pa.getByText('Купить хлеб')).toBeVisible();
  await expect(pa.getByText('Всё сохранено')).toBeVisible({ timeout: 10_000 });

  // Устройство B: вход, задача приезжает с сервера и расшифровывается.
  await pb.goto('/');
  await pb.getByLabel('Электронная почта').fill(EMAIL);
  await pb.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await pb.getByRole('button', { name: 'Войти' }).click();
  await expect(pb.getByText('Купить хлеб')).toBeVisible({ timeout: 20_000 });

  // Онлайн: правка на A появляется на B без перезагрузки (сигнал по WebSocket).
  await addTask(pa, 'Позвонить маме сегодня в 19');
  await expect(pb.getByText('Позвонить маме')).toBeVisible({ timeout: 10_000 });

  // Офлайн на B: правки сохраняются локально и уходят после восстановления сети.
  await b.setOffline(true);
  await addTask(pb, 'Офлайн задача сегодня');
  await expect(pb.getByText('Офлайн задача')).toBeVisible();
  await addTask(pa, 'Онлайн задача сегодня');
  await expect(pa.getByText('Онлайн задача')).toBeVisible();
  await pb.reload().catch(() => undefined);
  // Перезагрузка без сети: приложение открывается из кэша, данные из IndexedDB.
  await expect(pb.getByText('Офлайн задача')).toBeVisible({ timeout: 15_000 });

  await b.setOffline(false);
  await pb.evaluate(() => window.dispatchEvent(new Event('online')));
  for (const page of [pa, pb]) {
    for (const title of ['Купить хлеб', 'Позвонить маме', 'Офлайн задача', 'Онлайн задача']) {
      await expect(page.getByText(title)).toBeVisible({ timeout: 20_000 });
    }
  }

  // Выполнение на B исчезает на A.
  await pb.locator('.task', { hasText: 'Купить хлеб' }).getByRole('button', { name: 'Выполнить' }).click();
  await expect(pa.getByText('Купить хлеб')).toBeHidden({ timeout: 10_000 });

  await a.close();
  await b.close();
});

test('забытый пароль: вход по ключу восстановления, задачи на месте', async ({ page }) => {
  const email = `rec-${Date.now()}@dela.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('first-password-1');
  await page.getByLabel('Пароль ещё раз').fill('first-password-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  const recoveryKey = (await page.locator('.recovery-key').textContent({ timeout: 20_000 }))!;
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await addTask(page, 'Не потерять сегодня');
  await expect(page.getByText('Всё сохранено')).toBeVisible({ timeout: 10_000 });

  await page.goto('/#/settings');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Выйти' }).click();
  await page.getByRole('button', { name: 'Забыли пароль?' }).click();
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Ключ восстановления').fill(recoveryKey.toLowerCase().replace(/-/g, ' '));
  await page.getByLabel('Новый пароль').fill('second-password-2');
  await page.getByLabel('Пароль ещё раз').fill('second-password-2');
  await page.getByRole('button', { name: 'Задать пароль и войти' }).click();
  await page.goto('/#/today');
  await expect(page.getByText('Не потерять')).toBeVisible({ timeout: 20_000 });
});

test('клавиатура, палитра команд и перетаскивание', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`kb-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('keyboard-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('keyboard-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.goto('/#/inbox');
  for (const t of ['Первая', 'Вторая', 'Третья']) await addTask(page, t);
  const titles = () => page.locator('.content .task-title').allTextContents();
  await expect.poll(titles).toEqual(['Первая', 'Вторая', 'Третья']);

  // Перетаскивание: «Третья» в верхнюю часть «Первой» — встаёт первой.
  const first = page.locator('.task', { hasText: 'Первая' });
  const box = (await first.boundingBox())!;
  await page.locator('.task', { hasText: 'Третья' }).dragTo(first, { targetPosition: { x: box.width / 2, y: 3 } });
  await expect.poll(titles).toEqual(['Третья', 'Первая', 'Вторая']);

  // Клавиатура: вниз, выполнить.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('e');
  await expect.poll(titles).toEqual(['Третья', 'Вторая']);

  // Палитра: переход в «Предстоящие».
  await page.keyboard.press('Control+k');
  await page.getByLabel('Команда').fill('предст');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/upcoming$/);
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByRole('dialog', { name: 'Горячие клавиши' })).toBeVisible();
});

test('напоминание срабатывает в срок', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`rem-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('reminder-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('reminder-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await addTask(page, 'Выключить духовку через 2 минуты');
  await expect(page.getByText('Выключить духовку')).toBeVisible();
  await expect(page.getByText('⏰ Выключить духовку')).toBeHidden();
  await page.clock.fastForward('03:00');
  await expect(page.getByText('⏰ Выключить духовку')).toBeVisible({ timeout: 10_000 });
});
