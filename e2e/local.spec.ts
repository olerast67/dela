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

test('в «Сегодня» подзадачи раскрываются под задачей, выполненный повтор остаётся отмеченным', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, '- [ ] Разобрать шкаф сегодня\n  - [ ] сложить свитера завтра\n- [ ] Зарядка сегодня каждый день');
  await page.getByRole('button', { name: 'Добавить все' }).click();
  const row = (title: string) => page.locator('.task', { hasText: title });
  await expect(row('Разобрать шкаф')).toBeVisible();
  // Подзадача на завтра в «Сегодня» свёрнута под родителем.
  await expect(row('сложить свитера')).toHaveCount(0);
  await row('Разобрать шкаф').getByRole('button', { name: 'Показать подзадачи' }).click();
  await expect(row('сложить свитера')).toBeVisible();
  await expect(page.locator('.task-wrap', { hasText: 'сложить свитера' })).toHaveAttribute('style', /margin-left/);

  await row('Зарядка').getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.getByText('Перенесено на следующий раз')).toBeVisible();
  await expect(page.locator('.task.done', { hasText: 'Зарядка' })).toBeVisible();
  await expect(row('Зарядка')).toHaveCount(1);
});

test('ссылка на задачу по Ctrl+Shift+C открывает её карточку в новой вкладке', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Задача по ссылке сегодня');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await page.locator('.task', { hasText: 'Задача по ссылке' }).getByText('Задача по ссылке').click();
  await expect(page.locator('.panel').getByLabel('Название')).toHaveValue('Задача по ссылке');
  await page.keyboard.press('Control+Shift+C');
  await expect(page.getByText('Ссылка скопирована. Без сервера она откроется только в этом браузере')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/task\/[\w-]+$/);
  // Пока запись в IndexedDB не завершилась, другая вкладка задачу ещё не видит.
  await page.waitForTimeout(1000);

  const other = await context.newPage();
  await other.goto(link);
  await expect(other.locator('.panel').getByLabel('Название')).toHaveValue('Задача по ссылке');
  await expect(other).toHaveURL(/#\/inbox$/);

  // Без открытой карточки копируется ссылка на текущий экран, в том числе из палитры команд.
  await other.locator('.panel').getByRole('button', { name: 'Закрыть' }).click();
  await other.goto('/#/upcoming');
  await other.keyboard.press('Control+k');
  await other.getByLabel('Команда').fill('ссылку');
  await other.getByLabel('Команда').press('Enter');
  await expect.poll(() => other.evaluate(() => navigator.clipboard.readText())).toMatch(/\/#\/upcoming$/);
});

test('статистика: выполненная задача считается за сегодня', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Для статистики сегодня');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await page.locator('.task', { hasText: 'Для статистики' }).getByRole('button', { name: 'Выполнить' }).click();
  await page.getByRole('link', { name: 'Статистика' }).click();
  await expect(page).toHaveURL(/#\/stats/);
  await expect(page.getByRole('heading', { name: 'Статистика' })).toBeVisible();
  await expect(page.locator('.stats-card', { hasText: 'сегодня' }).locator('b')).toHaveText('1');
  await expect(page.locator('.stats-card', { hasText: 'лучшая серия' }).locator('b')).toHaveText('1');
  // На телефоне экран помещается без горизонтальной прокрутки.
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('помодоро: идёт отсчёт, по окончании время записано в задачу', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  // Короткая работа через настройки, чтобы не ждать 25 минут даже на перемотанных часах.
  await page.goto('/#/settings');
  await page.getByLabel('Работа, минут').fill('2');
  // Переход ссылкой уводит фокус из поля, иначе Q напечаталась бы в нём.
  await page.getByRole('link', { name: /Сегодня/ }).click();
  await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Фокус на отчёте сегодня');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  await page.locator('.task', { hasText: 'Фокус на отчёте' }).getByText('Фокус на отчёте').click();
  const panel = page.locator('.panel');
  await expect(panel.locator('.pomo-spent')).toHaveText('нет');
  await panel.getByRole('button', { name: 'Помодоро 2 мин' }).click();
  const chip = page.locator('.pomo-chip');
  await expect(chip.locator('.pomo-time')).toHaveText(/^(2:00|1:5\d)$/);
  await page.clock.fastForward('00:30');
  await expect(chip.locator('.pomo-time')).toHaveText(/^1:[23]\d$/);
  await expect(panel.locator('.pomo-big')).toHaveText(/^1:[23]\d$/);
  // Пауза: отсчёт стоит.
  await chip.getByRole('button', { name: 'Пауза' }).click();
  const paused = await chip.locator('.pomo-time').textContent();
  await page.clock.fastForward('01:00');
  await expect(chip.locator('.pomo-time')).toHaveText(paused!);
  await chip.getByRole('button', { name: 'Продолжить таймер' }).click();
  // Таймер переживает перезагрузку: хранится время окончания.
  await page.reload();
  await expect(page.locator('.pomo-chip .pomo-time')).toHaveText(/^1:[23]\d$/);
  await page.clock.fastForward('02:00');
  await expect(chip.getByRole('button', { name: 'Перерыв 5 мин' })).toBeVisible();
  await chip.locator('.pomo-open').click();
  await expect(panel.locator('.pomo-spent')).toHaveText('2 мин');
  await chip.getByRole('button', { name: 'Перерыв 5 мин' }).click();
  await expect(chip.locator('.pomo-task')).toHaveText('Перерыв');
  await page.clock.fastForward('05:30');
  await expect(page.getByText('Перерыв окончен')).toBeVisible();
  await expect(chip).toHaveCount(0);
  await expect(panel.locator('.pomo-spent')).toHaveText('2 мин');
});

test('привычка: выполнение даёт серию 1 в строке задачи', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.goto('/#/today');
  await page.keyboard.press('q');
  await page.getByLabel('Новая задача').fill('Зарядка каждый день');
  await page.getByLabel('Новая задача').press('Enter');
  await page.getByLabel('Новая задача').press('Escape');
  const row = page.locator('.task', { hasText: 'Зарядка' });
  await row.getByText('Зарядка').click();
  const panel = page.locator('.panel');
  await panel.getByLabel('Считать серию дней подряд').check();
  await expect(panel.locator('.habit-now b')).toHaveText('0');
  await expect(row.locator('.habit-badge')).toHaveText('0');
  await panel.getByRole('button', { name: 'Закрыть' }).click();
  await row.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.task.done', { hasText: 'Зарядка' }).locator('.habit-badge')).toHaveText('1');
  await row.getByText('Зарядка').click();
  await expect(panel.locator('.habit-now b')).toHaveText('1');
  await expect(panel.locator('.habit-day.s-done')).toHaveCount(2); // в полоске и в подписи
});

test('отдельное окно: проект в компактном виде без боковой панели, изменения видны в главном окне', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Только в этом браузере')).toBeVisible();
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByPlaceholder('Название проекта').fill('Отпуск');
  await page.getByPlaceholder('Название проекта').press('Enter');
  await expect(page.getByRole('heading', { name: 'Отпуск' })).toBeVisible();
  // Кнопка отдельного окна есть только в программе для Windows.
  await expect(page.locator('.head-actions').getByRole('button', { name: 'В отдельном окне' })).toHaveCount(0);
  const hash = new URL(page.url()).hash;
  expect(hash).toMatch(/^#\/project\//);

  // Второе окно — та же страница с ?window=1: та же база в браузере, вход не нужен.
  const win = await context.newPage();
  await win.setViewportSize({ width: 420, height: 640 });
  await win.goto(`/?window=1${hash}`);
  await expect(win.getByRole('heading', { name: 'Отпуск' })).toBeVisible();
  await expect(win.locator('.shell.compact')).toBeVisible();
  await expect(win.locator('nav.sidebar')).toHaveCount(0);
  await expect(win.locator('.tabbar')).toHaveCount(0);

  await win.keyboard.press('q');
  await win.getByLabel('Новая задача').fill('Купить билеты');
  await win.getByLabel('Новая задача').press('Enter');
  await win.getByLabel('Новая задача').press('Escape');
  await expect(win.locator('.task', { hasText: 'Купить билеты' })).toBeVisible();
  // Главное окно получает задачу без перезагрузки.
  await expect(page.locator('.task', { hasText: 'Купить билеты' })).toBeVisible();
  await expect(page.locator('nav.sidebar')).toBeVisible();
});
