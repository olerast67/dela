// Dela Verify: проверка страницы. Собирает список файлов веб-клиента, которые загрузила страница, и отдаёт его
// фоновой части: та скачивает файлы сама (её запросы не проходят через service worker страницы),
// считает хеши и сверяет их с подписанным списком выпуска той же версии.
(async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const ru = /^ru\b/i.test(navigator.language);

  const report = (state, detail) => {
    void api.runtime.sendMessage({ type: 'report', state, detail });
    if (state === 'bad') banner(detail);
  };

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  let version = '';

  try {
    const paths = new Set(['index.html']);
    const unverified = [];
    const add = (raw, isScript) => {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname.startsWith('/api/')) {
        // Скрипт с адреса API не входит в выпуск: такого в Dela нет.
        if (isScript) unverified.push(url.pathname);
        return;
      }
      paths.add(url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    };
    document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href], link[rel="manifest"][href]').forEach((el) => {
      add(el.src || el.href, el.tagName === 'SCRIPT' || el.rel === 'modulepreload');
    });
    for (const entry of performance.getEntriesByType('resource')) add(entry.name, entry.initiatorType === 'script');
    const sw = navigator.serviceWorker?.controller?.scriptURL;
    if (sw) add(sw, true);

    // Хеши копий, которые получила страница: файлы с хешем в имени берутся из кэша браузера.
    const pageHashes = {};
    for (const path of paths) {
      if (path === 'index.html' || path === 'sw.js' || path === 'registerSW.js') continue;
      try {
        const res = await fetch(`/${path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'force-cache' });
        pageHashes[path] = `sha256-${b64(await crypto.subtle.digest('SHA-256', await res.arrayBuffer()))}`;
      } catch {
        pageHashes[path] = 'unreadable';
      }
    }
    const result = await api.runtime.sendMessage({ type: 'check', origin: location.origin, paths: [...paths], pageHashes, unverified });
    if (!result) return;
    version = result.version ?? '';
    report(result.state, result.detail);
  } catch (err) {
    // Проверка не завершилась: это не повод считать страницу настоящей.
    report('bad', ru ? 'Проверка не завершилась.' : 'The check did not complete.');
  }

  function banner(detail) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText =
      'background:#C8402F;color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:12px 16px;box-shadow:0 2px 12px rgba(0,0,0,.3)';
    box.textContent = ru
      ? `Dela Verify: файлы веб-версии не совпадают с выпуском ${version} на GitHub. Не вводите пароль на этой странице и проверьте сервер. ${detail ?? ''}`
      : `Dela Verify: the web app files do not match release ${version} on GitHub. Do not enter your password on this page and check the server. ${detail ?? ''}`;
    root.append(box);
    document.documentElement.append(host);
  }
})();
