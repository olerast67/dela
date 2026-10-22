/** Настройки на телефоне: страница не шире экрана, длинные адреса календарей переносятся, а не листают страницу вбок. */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 } });

test('настройки не листаются вбок на ширине телефона', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Попробовать без сервера/ }).click();
  await expect(page.getByText('Подписаться на olerast').first()).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();

  // Строка календаря телефона (раздел есть только в Android): название и аккаунт без пробелов.
  await page.evaluate(() => {
    const label = document.createElement('label');
    label.className = 'checkline';
    label.id = 'long-calendar';
    label.innerHTML =
      '<input type="checkbox"><span class="event-swatch"></span><span class="checkline-text">Праздники в России <span class="muted">ru.russian#holiday@group.v.calendar.google.com</span></span>';
    document.querySelector('.settings')!.appendChild(label);
  });

  const widths = await page.evaluate(() => ({
    page: document.scrollingElement!.scrollWidth,
    view: document.documentElement.clientWidth,
    sections: [...document.querySelectorAll<HTMLElement>('.settings')].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.querySelector('h2')?.textContent),
    line: { scroll: document.getElementById('long-calendar')!.scrollWidth, client: document.getElementById('long-calendar')!.clientWidth },
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.view);
  expect(widths.sections).toEqual([]);
  expect(widths.line.scroll).toBeLessThanOrEqual(widths.line.client);
});
