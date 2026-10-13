/**
 * Комментарии и файлы: комментарий с картинкой, файл зашифрован на устройстве,
 * после перезагрузки картинка снова расшифровывается; удаление комментария.
 */
import { expect, test } from '@playwright/test';

// PNG 1x1, зелёная точка.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('комментарий с картинкой', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`comments-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('comments-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('comments-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();

  await page.locator('.task', { hasText: 'Подписаться на olerast' }).click();
  const panel = page.locator('.panel');
  await panel.getByLabel('Новый комментарий').fill('Подписался, ролик про Dela отличный');
  await panel.getByLabel('Файл').setInputFiles({ name: 'точка.png', mimeType: 'image/png', buffer: PNG });
  await panel.getByRole('button', { name: 'Отправить' }).click();
  await expect(panel.locator('.comment-text')).toHaveText('Подписался, ролик про Dela отличный');
  await expect(panel.getByRole('img', { name: 'точка.png' })).toBeVisible();
  await expect(page.locator('.task', { hasText: 'Подписаться на olerast' }).getByTitle('Комментарии')).toContainText('1');
  await expect(page.getByText('Всё сохранено')).toBeVisible({ timeout: 10_000 });
  if (process.env.SHOTS) await page.screenshot({ path: 'C:/Users/olerast/AppData/Local/Temp/claude/F--ToDoIst/18f673bb-437e-416d-a093-d1b79e5bb602/scratchpad/comments.png' });

  await page.reload();
  await page.locator('.task', { hasText: 'Подписаться на olerast' }).click();
  await expect(page.locator('.panel').getByRole('img', { name: 'точка.png' })).toBeVisible({ timeout: 10_000 });
  await page.locator('.panel').getByRole('button', { name: 'Удалить комментарий' }).click();
  await expect(page.locator('.panel .comment')).toHaveCount(0);
});
