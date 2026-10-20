/** Без сервера: задачи живут в браузере, переживают перезагрузку, запросов к API нет. */
import { expect, test } from '@playwright/test';

test('попробовать без сервера', async ({ page }) => {
  const api: string[] = [];
  await page.goto('/');
  page.on('request', (r) => r.url().includes('/api/') && api.push(r.url()));
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Только в этом браузере')).toBeVisible();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Локальная задача сегодня');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await expect(page.locator('.task', { hasText: 'Локальная задача' })).toBeVisible();
  // Запись в IndexedDB асинхронная: перезагрузка сразу после ввода могла её опередить.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('.task', { hasText: 'Локальная задача' })).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Без сервера' })).toBeVisible();
  expect(api).toEqual([]);
});

test('вставленный список становится задачами, отступ даёт подзадачу', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  const list = '- [ ] Ремонт сегодня\n  - [x] купить краску\n  - [ ] покрасить стену сегодня\n- Забрать посылку сегодня в 19';
  await page.getByLabel('Новая задача').evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, list);
  await expect(page.getByText('Вставлен список: 3 задачи')).toBeVisible();
  await expect(page.locator('.qa-batch li.sub', { hasText: 'покрасить стену' })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить все' }).click();
  await expect(page.locator('.task', { hasText: 'Забрать посылку' })).toBeVisible();
  await expect(page.locator('.task', { hasText: 'покрасить стену' })).toBeVisible();
  await expect(page.locator('.task', { hasText: 'купить краску' })).toHaveCount(0);
});

test('экран при запуске из настроек', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.goto('/#/settings');
  await page.getByLabel('Экран при запуске').selectOption('#/upcoming');
  await page.goto('/');
  await expect(page).toHaveURL(/#\/upcoming$/);
  // Ссылка на конкретный экран важнее настройки.
  await page.goto('/#/inbox');
  await page.reload();
  await expect(page).toHaveURL(/#\/inbox$/);
});

test('выделение нескольких задач: выполнить разом и отменить одной кнопкой', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, 'Первая пачка сегодня\nВторая пачка сегодня\nТретья пачка сегодня');
  await page.getByRole('button', { name: 'Добавить все' }).click();
  const row = (text: string) => page.locator('.task', { hasText: text });
  await row('Первая пачка').click({ modifiers: ['Control'] });
  // Пока что-то выделено, обычный щелчок тоже выделяет, а не открывает карточку.
  await row('Вторая пачка').click();
  await expect(page.getByText('Выбрано: 2')).toBeVisible();
  await page.getByRole('toolbar').getByRole('button', { name: 'Выполнить' }).click();
  await expect(row('Первая пачка')).toHaveCount(0);
  await expect(row('Вторая пачка')).toHaveCount(0);
  await expect(row('Третья пачка')).toBeVisible();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(row('Первая пачка')).toBeVisible();
  await expect(row('Вторая пачка')).toBeVisible();
  // Esc снимает выделение.
  await row('Третья пачка').click({ modifiers: ['Control'] });
  await expect(page.getByRole('toolbar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar')).toHaveCount(0);
});

test('повтор кнопками: каждую неделю по понедельникам и средам', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Планёрка сегодня');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await page.locator('.task', { hasText: 'Планёрка' }).click();
  const panel = page.locator('.panel');
  await panel.getByRole('button', { name: 'Настроить' }).click();
  const editor = panel.getByRole('group', { name: 'Настройка повтора' });
  await editor.getByRole('button', { name: 'Неделя' }).click();
  // По умолчанию выбран день срока: снимаем все дни и отмечаем нужные.
  const days = editor.getByRole('group', { name: 'Дни недели' });
  for (const b of await days.locator('button[aria-pressed="true"]').all()) await b.click();
  await days.getByRole('button', { name: 'Понедельник' }).click();
  await days.getByRole('button', { name: 'Среда' }).click();
  await editor.getByRole('button', { name: 'Сохранить' }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.locator('.pill', { hasText: 'каждый понедельник и среду' })).toBeVisible();
  // Срок сдвинут на ближайший понедельник или среду.
  const due = await panel.getByLabel('Дата', { exact: true }).inputValue();
  expect([1, 3]).toContain(new Date(`${due}T12:00:00Z`).getUTCDay());
  // Повторное открытие заполняет форму из правила.
  await panel.getByRole('button', { name: 'Настроить' }).click();
  await expect(editor.getByRole('button', { name: 'Понедельник' })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByRole('button', { name: 'Среда' })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByRole('button', { name: 'Пятница' })).toHaveAttribute('aria-pressed', 'false');
});

test('описание проекта переживает перезагрузку', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Только в этом браузере')).toBeVisible();
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByPlaceholder('Название проекта').fill('Ремонт');
  await page.getByPlaceholder('Название проекта').press('Enter');
  await expect(page.getByRole('heading', { name: 'Ремонт' })).toBeVisible();
  // Пустое описание места не занимает.
  await expect(page.locator('.project-desc')).toHaveCount(0);
  await page.locator('.head-actions').getByRole('button', { name: 'Описание' }).click();
  await page.locator('textarea.project-desc').fill('Бюджет **сто тысяч**');
  await page.locator('textarea.project-desc').press('Escape');
  await expect(page.locator('.project-desc strong')).toHaveText('сто тысяч');
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('.project-desc strong')).toHaveText('сто тысяч');
  // Щелчок по тексту открывает правку.
  await page.locator('.project-desc').click();
  await expect(page.locator('textarea.project-desc')).toHaveValue('Бюджет **сто тысяч**');
});
