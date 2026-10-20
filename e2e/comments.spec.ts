/**
 * Комментарии и файлы: комментарий с картинкой, файл зашифрован на устройстве,
 * после перезагрузки картинка снова расшифровывается; удаление комментария;
 * файл из нескольких частей загружается и скачивается без искажений.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/shots'}/comments.png` });

  await page.reload();
  await page.locator('.task', { hasText: 'Подписаться на olerast' }).click();
  await expect(page.locator('.panel').getByRole('img', { name: 'точка.png' })).toBeVisible({ timeout: 10_000 });
  await page.locator('.panel').getByRole('button', { name: 'Удалить комментарий' }).click();
  await expect(page.locator('.panel .comment')).toHaveCount(0);
});

test('файл больше одной части: загрузка по частям и скачивание без искажений', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Электронная почта').fill(`bigfile-${Date.now()}@dela.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('bigfile-pass-1');
  await page.getByLabel('Пароль ещё раз').fill('bigfile-pass-1');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Ключ сохранён в надёжном месте').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();

  // 9 МБ псевдослучайных байт: три части по 4 МиБ, последняя неполная.
  const data = Buffer.alloc(9 * 1000 * 1000);
  let x = 2463534242;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 0xff;
  }
  const hash = createHash('sha256').update(data).digest('hex');

  await page.locator('.task', { hasText: 'Подписаться на olerast' }).click();
  const panel = page.locator('.panel');
  await panel.getByLabel('Файл').setInputFiles({ name: 'архив.bin', mimeType: 'application/octet-stream', buffer: data });
  const parts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && /\/files\/[0-9a-f-]+\/parts\/\d+$/.test(r.url())) parts.push(r.url());
  });
  await panel.getByRole('button', { name: 'Отправить' }).click();
  const chip = panel.locator('.file-chip', { hasText: 'архив.bin' });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  expect(parts).toHaveLength(3);
  await expect(page.getByText('Всё сохранено')).toBeVisible({ timeout: 10_000 });

  // После перезагрузки ключ файла приходит из зашифрованной записи комментария.
  await page.reload();
  await page.locator('.task', { hasText: 'Подписаться на olerast' }).click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.locator('.panel .file-chip', { hasText: 'архив.bin' }).click()]);
  expect(download.suggestedFilename()).toBe('архив.bin');
  const got = await readFile((await download.path())!);
  expect(got.length).toBe(data.length);
  expect(createHash('sha256').update(got).digest('hex')).toBe(hash);
});
