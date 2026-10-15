/**
 * Расширение Dela Verify: настоящий Chromium с расширением, подписанный тестовым ключом список файлов
 * на локальном сервере. Нетронутая страница даёт зелёный значок, подменённая — красный значок и плашку.
 */
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const BASE = 'http://127.0.0.1:8790';

// Код внутри worker.evaluate выполняется в фоновом скрипте расширения, там есть объект chrome.
declare const chrome: any;

function distManifest(version: string): string {
  const root = 'apps/web/dist';
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const files = walk(root)
    .map((p) => [relative(root, p).split(sep).join('/'), `sha256-${createHash('sha256').update(readFileSync(p)).digest('base64')}`] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify({ v: 1, app: 'dela-web', version, files: Object.fromEntries(files) }, null, 1) + '\n';
}

let releases: Server;
let proxy: Server;
let proxyOrigin: string;
let extDir: string;
let context: BrowserContext;

test.beforeAll(async () => {
  const version = ((await (await fetch(`${BASE}/api/health`)).json()) as { version: string }).version;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest = distManifest(version);
  const sig = sign(null, Buffer.from(manifest), privateKey).toString('base64');
  releases = createServer((req, res) => {
    if (req.url === `/v${version}/web-manifest.json`) res.end(manifest);
    else if (req.url === `/v${version}/web-manifest.json.sig`) res.end(sig);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => releases.listen(0, '127.0.0.1', r));
  const port = (releases.address() as AddressInfo).port;

  // Захваченный сервер: отдаёт всем изменённый index.html, остальное как есть.
  proxy = createServer(async (req, res) => {
    const upstream = await fetch(`${BASE}${req.url}`);
    let body = Buffer.from(await upstream.arrayBuffer());
    if (req.url === '/') body = Buffer.from(body.toString('utf8').replace('</head>', '<meta name="x-evil" content="1"></head>'));
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyOrigin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  // Копия расширения: выпуски берутся с локального сервера и проверяются тестовым ключом.
  extDir = mkdtempSync(join(tmpdir(), 'dela-verify-'));
  cpSync('extension', extDir, { recursive: true });
  const bg = join(extDir, 'background.js');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  writeFileSync(
    bg,
    readFileSync(bg, 'utf8')
      .replace(/const MANIFEST_PUBLIC_KEY = '[^']*';/, `const MANIFEST_PUBLIC_KEY = '${raw}';`)
      .replace(/const RELEASES = '[^']*';/, `const RELEASES = 'http://127.0.0.1:${port}';`),
  );
  const mf = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  mf.host_permissions.push('http://127.0.0.1/*');
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(mf));

  // Расширения в фоновом режиме работают только в полной сборке Chromium. Где её запуск запрещён политикой
  // системы, подходит Microsoft Edge: он на том же движке и тоже загружает распакованное расширение.
  const options = { headless: true, args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`] };
  context = await chromium
    .launchPersistentContext('', { ...options, channel: 'chromium' })
    .catch(() => chromium.launchPersistentContext('', { ...options, channel: 'msedge' }));
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate((origins) => chrome.storage.local.set({ servers: origins }), [BASE, proxyOrigin]);
  await expect.poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBe(1);
});

test.afterAll(async () => {
  await context?.close();
  releases?.close();
  proxy?.close();
  if (extDir) rmSync(extDir, { recursive: true, force: true });
});

async function badge(page: import('@playwright/test').Page): Promise<string> {
  const worker = context.serviceWorkers()[0]!;
  const url = page.url();
  return worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u.split('#')[0] + '*' });
    return tab?.id === undefined ? '' : chrome.action.getBadgeText({ tabId: tab.id });
  }, url);
}

test('файлы совпадают с выпуском: зелёный значок, плашки нет', async () => {
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await expect.poll(() => badge(page), { timeout: 15_000 }).toBe('✓');
  await expect(page.locator('div[style*="2147483647"]')).toHaveCount(0);
  await page.close();
});

test('подменённая страница: красный значок и плашка', async () => {
  const page = await context.newPage();
  await page.goto(`${proxyOrigin}/`);
  await expect.poll(() => badge(page), { timeout: 15_000 }).toBe('!');
  // Плашка «не вводите пароль» поверх страницы (текст в закрытом shadow DOM, страница его не прочитает).
  await expect(page.locator('div[style*="2147483647"]')).toHaveCount(1);
  await page.close();
});

test('откат сервера на старую версию: красный значок', async () => {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate((origin) => chrome.storage.local.set({ [`seen:${origin}`]: '99.0.0' }), BASE);
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await expect.poll(() => badge(page), { timeout: 15_000 }).toBe('!');
  await page.close();
  await worker.evaluate((origin) => chrome.storage.local.remove(`seen:${origin}`), BASE);
});
