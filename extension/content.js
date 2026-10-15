// Dela Verify: проверка страницы. Сверяет хеши файлов веб-клиента, которые загрузила страница,
// с подписанным списком файлов выпуска той же версии.
(async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const ru = /^ru\b/i.test(navigator.language);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  const report = (state, detail) => {
    void api.runtime.sendMessage({ type: 'report', state, detail });
    if (state === 'bad') banner(detail);
  };

  // Страница не из Dela: проверять нечего.
  let version;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    version = (await res.json()).version;
  } catch {
    return;
  }
  if (typeof version !== 'string') return;

  const got = await api.runtime.sendMessage({ type: 'manifest', version });
  if (!got?.ok) {
    if (got?.reason === 'bad-signature' || got?.reason === 'bad-manifest') {
      report('bad', ru ? 'Список файлов выпуска не прошёл проверку подписи.' : 'The release file list failed the signature check.');
    } else {
      report('unknown', ru ? `Нет подписанного выпуска ${version}.` : `No signed release ${version}.`);
    }
    return;
  }
  const files = got.manifest.files;

  // Что загрузила страница: сам документ, скрипты, стили, ресурсы и service worker.
  const urls = new Set(['/']);
  document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href], link[rel="manifest"][href]').forEach((el) => {
    urls.add(el.src || el.href);
  });
  for (const entry of performance.getEntriesByType('resource')) urls.add(entry.name);
  if (navigator.serviceWorker?.controller) urls.add('/sw.js');

  const bad = [];
  let checked = 0;
  for (const u of urls) {
    const url = new URL(u, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) continue;
    const path = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const want = files[path];
    if (!want) {
      bad.push(`${path} (${ru ? 'нет в выпуске' : 'not in the release'})`);
      continue;
    }
    // Файлы с хешем в имени берутся из кэша: это те же байты, что получила страница.
    const fresh = path === 'index.html' || path === 'sw.js' || path === 'registerSW.js';
    const res = await fetch(url.pathname, { cache: fresh ? 'no-store' : 'force-cache' });
    const hash = `sha256-${b64(await crypto.subtle.digest('SHA-256', await res.arrayBuffer()))}`;
    checked++;
    if (hash !== want) bad.push(path);
  }

  if (bad.length) report('bad', bad.slice(0, 5).join(', '));
  else report('ok', ru ? `Версия ${version}, проверено файлов: ${checked}.` : `Version ${version}, files checked: ${checked}.`);

  function banner(detail) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText =
      'background:#C8402F;color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:12px 16px;box-shadow:0 2px 12px rgba(0,0,0,.3)';
    box.textContent = ru
      ? `Dela Verify: файлы веб-версии не совпадают с выпуском ${version} на GitHub. Не вводите пароль на этой странице и проверьте сервер. ${detail}`
      : `Dela Verify: the web app files do not match release ${version} on GitHub. Do not enter your password on this page and check the server. ${detail}`;
    root.append(box);
    document.documentElement.append(host);
  }
})();
