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
  await pb.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(pb.getByText('Купить хлеб')).toBeVisible({ timeout: 20_000 });

  // Онлайн: правка на A появляется на B без перезагрузки (сигнал по WebSocket).
  await addTask(pa, 'Позвонить бабушке сегодня в 19');
  await expect(pb.getByText('Позвонить бабушке')).toBeVisible({ timeout: 10_000 });

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
    for (const title of ['Купить хлеб', 'Позвонить бабушке', 'Офлайн задача', 'Онлайн задача']) {
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
  // Во «Входящих» нового аккаунта есть приветственные задачи: смотрим только на свои.
  const mine = ['Первая', 'Вторая', 'Третья'];
  const titles = async () => (await page.locator('.content .task-title').allTextContents()).filter((t) => mine.includes(t));
  await expect.poll(titles).toEqual(['Первая', 'Вторая', 'Третья']);

  // Перетаскивание: «Третья» в верхнюю часть «Первой» — встаёт первой.
  const first = page.locator('.task', { hasText: 'Первая' });
  const box = (await first.boundingBox())!;
  await page.locator('.task', { hasText: 'Третья' }).dragTo(first, { targetPosition: { x: box.width / 2, y: 3 } });
  await expect.poll(titles).toEqual(['Третья', 'Первая', 'Вторая']);

  // Клавиатура: вниз, выполнить.
  await page.locator('.task', { hasText: 'Третья' }).focus();
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

test('push: service worker расшифровывает напоминание ключом устройства', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['notifications']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`push-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('push-pass-1234');
  await page.getByLabel('Пароль ещё раз').fill('push-pass-1234');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready);

  // Шифруем так же, как приложение: AES-GCM ключом устройства из IndexedDB.
  const payload = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open('dela');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const key: CryptoKey = await new Promise((res) => {
      const r = db.transaction('meta').objectStore('meta').get('deviceKey');
      r.onsuccess = () => res(r.result);
    });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ t: 'Выключить духовку', b: 'Пора', k: 'k1', id: 't1' }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const all = new Uint8Array(12 + ct.length);
    all.set(iv);
    all.set(ct, 12);
    return btoa(String.fromCharCode(...all));
  });

  const cdp = await context.newCDPSession(page);
  const registrationId = await new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
      const r = e.registrations.find((x) => !x.isDeleted);
      if (r) resolve(r.registrationId);
    });
    void cdp.send('ServiceWorker.enable');
  });
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(baseURL!).origin, registrationId, data: JSON.stringify({ p: payload }) });

  // Headless Chromium не показывает системные уведомления, поэтому проверяем путь внутри приложения:
  // service worker расшифровал текст ключом устройства и передал его окну.
  await expect(page.getByText('⏰ Выключить духовку')).toBeVisible({ timeout: 10_000 });
});

async function registerUser(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('shared-pass-123');
  await page.getByLabel('Пароль ещё раз').fill('shared-pass-123');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible();
}

test('общий проект: приглашение, правки с двух сторон, выход', async ({ browser }) => {
  const stamp = Date.now();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await registerUser(a, `owner-${stamp}@dela.test`);
  await registerUser(b, `guest-${stamp}@dela.test`);

  // A: проект с задачей → сделать общим.
  await a.getByRole('button', { name: 'Новый проект' }).click();
  await a.getByPlaceholder('Название проекта').fill('Семья');
  await a.getByPlaceholder('Название проекта').press('Enter');
  await addTask(a, 'Купить подарок');
  await expect(a.locator('.content').getByText('Купить подарок')).toBeVisible();
  await a.getByRole('button', { name: 'Поделиться' }).click();
  await a.getByRole('button', { name: 'Сделать проект общим' }).click();
  await expect(a.getByRole('button', { name: 'Участники' })).toBeVisible({ timeout: 10_000 });
  await expect(a.locator('.content').getByText('Купить подарок')).toBeVisible();

  // A приглашает B: окно общего доступа остаётся открытым после создания общего проекта.
  await a.getByLabel('Почта участника').fill(`guest-${stamp}@dela.test`);
  await a.getByRole('button', { name: 'Пригласить' }).click();
  await expect(a.getByText(/Добавлен\. Отпечаток ключа участника/)).toBeVisible({ timeout: 10_000 });
  await a.getByRole('button', { name: 'Закрыть' }).click();

  // B видит проект без перезагрузки (сигнал по WebSocket).
  await expect(b.locator('.sidebar').getByText('Семья')).toBeVisible({ timeout: 15_000 });
  await b.locator('.sidebar').getByText('Семья').click();
  await expect(b.locator('.content').getByText('Купить подарок')).toBeVisible({ timeout: 10_000 });

  // B добавляет задачу — A её видит.
  await addTask(b, 'Заказать торт');
  await expect(a.locator('.content').getByText('Заказать торт')).toBeVisible({ timeout: 15_000 });

  // B выходит — проект пропадает у B.
  await b.getByRole('button', { name: 'Участники' }).click();
  b.once('dialog', (d) => d.accept());
  await b.getByRole('button', { name: 'Выйти' }).click();
  await expect(b.locator('.sidebar').getByText('Семья')).toBeHidden({ timeout: 10_000 });
});

test('общий проект: владелец убирает участника, ключ меняется, остальные продолжают', async ({ browser }) => {
  const stamp = Date.now();
  const page = async () => (await browser.newContext()).newPage();
  const [a, b, c] = [await page(), await page(), await page()];
  await registerUser(a, `rot-owner-${stamp}@dela.test`);
  await registerUser(b, `rot-stay-${stamp}@dela.test`);
  await registerUser(c, `rot-gone-${stamp}@dela.test`);

  await a.getByRole('button', { name: 'Новый проект' }).click();
  await a.getByPlaceholder('Название проекта').fill('Ремонт');
  await a.getByPlaceholder('Название проекта').press('Enter');
  await addTask(a, 'Выбрать плитку');
  await a.getByRole('button', { name: 'Поделиться' }).click();
  await a.getByRole('button', { name: 'Сделать проект общим' }).click();
  for (const who of ['stay', 'gone']) {
    await a.getByLabel('Почта участника').fill(`rot-${who}-${stamp}@dela.test`);
    await a.getByRole('button', { name: 'Пригласить' }).click();
    await expect(a.getByText(/Добавлен\. Отпечаток ключа участника/)).toBeVisible({ timeout: 10_000 });
  }
  await a.getByRole('button', { name: 'Закрыть' }).click();
  for (const p of [b, c]) {
    await expect(p.locator('.sidebar').getByText('Ремонт')).toBeVisible({ timeout: 15_000 });
    await p.locator('.sidebar').getByText('Ремонт').click();
    await expect(p.locator('.content').getByText('Выбрать плитку')).toBeVisible({ timeout: 10_000 });
  }

  // A убирает C: ключ проекта заменяется, проект пропадает у C.
  await a.getByRole('button', { name: 'Участники' }).click();
  await a.locator('.share-body .trash-row', { hasText: `rot-gone-${stamp}` }).getByRole('button', { name: 'Убрать' }).click();
  await expect(a.getByText('Ключ проекта заменён')).toBeVisible({ timeout: 15_000 });
  await a.getByRole('button', { name: 'Закрыть' }).click();
  await expect(c.locator('.sidebar').getByText('Ремонт')).toBeHidden({ timeout: 15_000 });

  // B получает новый ключ и продолжает: его правка доходит до A, правка A доходит до B.
  await addTask(b, 'Купить клей');
  await expect(a.locator('.content').getByText('Купить клей')).toBeVisible({ timeout: 20_000 });
  await addTask(a, 'Позвать мастера');
  await expect(b.locator('.content').getByText('Позвать мастера')).toBeVisible({ timeout: 20_000 });
});
