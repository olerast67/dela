/**
 * События календарей поверх задач: подписка на .ics по ссылке видна в «Сегодня» и в календаре,
 * открывается подробностями и не выполняется. Календарь без CORS даёт понятное сообщение.
 */
import { expect, test } from '@playwright/test';

// Запросы через service worker page.route не перехватывает, а для подписки он не нужен.
test.use({ serviceWorkers: 'block' });

const CAL = 'https://calendar.example.test/private-secret/basic.ics';
const NO_CORS = 'https://nocors.example.test/cal.ics';

/** Сегодня в поясе теста (Europe/Moscow) в виде 20261013. */
function todayStamp(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()).replaceAll('-', '');
}

function ics(day: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//e2e//EN',
    'BEGIN:VEVENT',
    'UID:standup',
    'SUMMARY:Стендап команды',
    'LOCATION:Переговорная 3',
    'DESCRIPTION:Обсудить <b>релиз</b>',
    `DTSTART;TZID=Europe/Moscow:${day}T100000`,
    `DTEND;TZID=Europe/Moscow:${day}T110000`,
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:holiday',
    'SUMMARY:День города',
    `DTSTART;VALUE=DATE:${day}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

test('подписка на календарь iCal: события в «Сегодня» и в календаре', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.route(CAL, (route) => route.fulfill({ status: 200, contentType: 'text/calendar', headers: { 'Access-Control-Allow-Origin': '*' }, body: ics(todayStamp()) }));
  // Запрет CORS страница видит как сетевую ошибку fetch; page.route заголовки CORS не проверяет, поэтому запрос просто обрывается.
  await page.route(NO_CORS, (route) => route.abort('failed'));

  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Только в этом браузере')).toBeVisible();

  await page.goto('/#/settings');
  await page.getByLabel('Название календаря').fill('Работа');
  await page.getByLabel('Ссылка на календарь iCal').fill(CAL.replace('https://', 'webcal://'));
  await page.getByRole('button', { name: 'Подписаться' }).click();
  const row = page.locator('.calendar-row', { has: page.locator('b', { hasText: 'Работа' }) });
  await expect(row).toContainText('calendar.example.test');
  // Ссылка — секрет: целиком в настройках её не видно.
  await expect(page.locator('body')).not.toContainText('private-secret');
  await expect(row).toContainText('Обновлён в');

  await page.getByLabel('Название календаря').fill('Без CORS');
  await page.getByLabel('Ссылка на календарь iCal').fill(NO_CORS);
  await page.getByRole('button', { name: 'Подписаться' }).click();
  await expect(page.locator('.calendar-row', { hasText: 'Без CORS' })).toContainText('не разрешает загрузку из браузера');

  await page.goto('/#/today');
  const events = page.locator('.day-events');
  await expect(events.locator('.day-event', { hasText: 'Стендап команды' })).toContainText('10:00-11:00');
  await expect(events.locator('.day-event', { hasText: 'День города' })).toContainText('Весь день');
  // Событие — не задача: у него нет кружка выполнения, и в счётчике задач его нет.
  await expect(events.locator('.cal-dot, .check')).toHaveCount(0);
  await events.locator('.day-event', { hasText: 'Стендап команды' }).click();
  const dialog = page.getByRole('dialog', { name: 'Событие календаря' });
  await expect(dialog).toContainText('Переговорная 3');
  await expect(dialog).toContainText('Обсудить релиз');
  await expect(dialog.locator('b')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.goto('/#/calendar/week');
  const grid = page.locator('.cal-time-grid');
  const block = grid.locator('.cal-block.cal-event', { hasText: 'Стендап команды' });
  await expect(block).toContainText('10:00-11:00');
  await expect(block).not.toHaveAttribute('draggable', 'true');
  await expect(grid.locator('.cal-allday .cal-event', { hasText: 'День города' })).toBeVisible();
  await block.click();
  await expect(page.getByRole('dialog', { name: 'Событие календаря' })).toContainText('Стендап команды');
  await page.keyboard.press('Escape');

  await page.goto('/#/calendar/month');
  await expect(page.locator('.cal-cell.today .cal-event', { hasText: 'Стендап команды' })).toBeVisible();

  // В поиск задач события не попадают.
  await page.goto('/#/search?q=' + encodeURIComponent('Стендап'));
  await expect(page.locator('.task', { hasText: 'Стендап' })).toHaveCount(0);

  // Выключенный календарь пропадает из «Сегодня».
  await page.goto('/#/settings');
  await page.locator('.calendar-row', { has: page.locator('b', { hasText: 'Работа' }) }).getByLabel('Показывать').uncheck();
  await page.goto('/#/today');
  await expect(page.locator('.day-event', { hasText: 'Стендап команды' })).toHaveCount(0);
});
