// Dela Verify: фоновая часть. Скачивает подписанный список файлов выпуска с GitHub, проверяет подпись
// ключом проекта и ставит значок на вкладке по итогу проверки страницы.
const api = globalThis.browser ?? globalThis.chrome;

/** Открытый ключ Ed25519, которым подписываются списки файлов веб-версии (raw, base64). */
const MANIFEST_PUBLIC_KEY = 'y3Zkairxm+9yU65AqArxf1PUT63ygFlnRAs676WEZGs=';
const RELEASES = 'https://github.com/olerast67/dela/releases/download';

const fromB64 = (s) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
const manifests = new Map();

async function loadManifest(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, reason: 'bad-version' };
  if (manifests.has(version)) return manifests.get(version);
  const result = await (async () => {
    const [body, sig] = await Promise.all([
      fetch(`${RELEASES}/v${version}/web-manifest.json`, { cache: 'no-store' }),
      fetch(`${RELEASES}/v${version}/web-manifest.json.sig`, { cache: 'no-store' }),
    ]);
    if (body.status === 404 || sig.status === 404) return { ok: false, reason: 'no-release' };
    if (!body.ok || !sig.ok) return { ok: false, reason: 'network' };
    const bytes = new Uint8Array(await body.arrayBuffer());
    const key = await crypto.subtle.importKey('raw', fromB64(MANIFEST_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', key, fromB64(await sig.text()), bytes);
    if (!valid) return { ok: false, reason: 'bad-signature' };
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    if (manifest.app !== 'dela-web' || manifest.version !== version) return { ok: false, reason: 'bad-manifest' };
    return { ok: true, manifest };
  })().catch(() => ({ ok: false, reason: 'network' }));
  // Сетевую ошибку не запоминаем: следующая проверка попробует снова.
  if (result.ok || result.reason !== 'network') manifests.set(version, result);
  return result;
}

const cmpVersion = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/**
 * Сверка страницы сервера с выпуском. Файлы скачиваются отсюда, из фоновой части: эти запросы не проходят через
 * service worker страницы, и подменённый service worker не может показать проверке другие файлы.
 */
async function check({ origin, paths, pageHashes, unverified }) {
  const ru = /^ru\b/i.test(navigator.language);
  const { servers = [] } = await api.storage.local.get('servers');
  if (!servers.includes(origin)) return null;

  // Версию спрашивает фоновая часть: service worker страницы не может подсунуть удобную.
  let version;
  try {
    version = (await (await fetch(`${origin}/api/health`, { cache: 'no-store', credentials: 'omit' })).json()).version;
  } catch {
    return null;
  }
  if (typeof version !== 'string') return null;
  const result = await verify(origin, version, paths, pageHashes ?? {}, unverified ?? [], ru);
  return { ...result, version };
}

async function verify(origin, version, paths, pageHashes, unverified, ru) {

  // Откат на старую версию тоже подозрителен: в старой версии могут быть исправленные с тех пор ошибки.
  const seenKey = `seen:${origin}`;
  const seen = (await api.storage.local.get(seenKey))[seenKey];
  if (typeof seen === 'string' && /^\d+\.\d+\.\d+$/.test(version) && cmpVersion(version, seen) < 0) {
    return { state: 'bad', detail: ru ? `Версия сервера снизилась: была ${seen}, стала ${version}.` : `The server version went down from ${seen} to ${version}.` };
  }

  const got = await loadManifest(version);
  if (!got.ok) {
    if (got.reason === 'bad-signature' || got.reason === 'bad-manifest') {
      return { state: 'bad', detail: ru ? 'Список файлов выпуска не прошёл проверку подписи.' : 'The release file list failed the signature check.' };
    }
    // Сервер, который уже проходил проверку, без подписанного выпуска для своей версии подозрителен.
    const noRelease = ru ? `Нет подписанного выпуска ${version}.` : `No signed release ${version}.`;
    if (typeof seen === 'string' && got.reason !== 'network') return { state: 'bad', detail: noRelease };
    return { state: 'unknown', detail: noRelease };
  }
  if (unverified.length) {
    return { state: 'bad', detail: `${ru ? 'Скрипты не из выпуска' : 'Scripts outside the release'}: ${unverified.slice(0, 3).join(', ')}` };
  }

  const files = got.manifest.files;
  const bad = [];
  for (const path of paths) {
    const want = files[path];
    if (!want) {
      bad.push(`${path} (${ru ? 'нет в выпуске' : 'not in the release'})`);
      continue;
    }
    const url = path === 'index.html' ? `${origin}/` : `${origin}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) {
      bad.push(`${path} (HTTP ${res.status})`);
      continue;
    }
    if (`sha256-${b64(await crypto.subtle.digest('SHA-256', await res.arrayBuffer()))}` !== want) bad.push(path);
    // Копия, которую получила сама страница, тоже должна совпасть с выпуском.
    else if (pageHashes[path] !== undefined && pageHashes[path] !== want) bad.push(`${path} (${ru ? 'копия страницы' : 'page copy'})`);
  }
  if (bad.length) return { state: 'bad', detail: bad.slice(0, 5).join(', ') };

  if (typeof seen !== 'string' || cmpVersion(version, seen) > 0) await api.storage.local.set({ [seenKey]: version });
  return { state: 'ok', detail: ru ? `Версия ${version}, проверено файлов: ${paths.length}.` : `Version ${version}, files checked: ${paths.length}.` };
}

const BADGES = {
  ok: { text: '✓', color: '#2E7D5B', title: 'Dela Verify: files match the release' },
  bad: { text: '!', color: '#C8402F', title: 'Dela Verify: files do NOT match the release' },
  unknown: { text: '?', color: '#8A918C', title: 'Dela Verify: no signed release for this version' },
};

api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'check') {
    check(msg).then(reply, () => reply({ state: 'bad', detail: 'check failed' }));
    return true;
  }
  if (msg?.type === 'report' && sender.tab?.id !== undefined) {
    const b = BADGES[msg.state] ?? BADGES.unknown;
    api.action.setBadgeText({ tabId: sender.tab.id, text: b.text });
    api.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: b.color });
    api.action.setTitle({ tabId: sender.tab.id, title: msg.detail ? `${b.title}\n${msg.detail}` : b.title });
  }
  return false;
});

/** Скрипт проверки подключается только к адресам серверов, которые добавил пользователь. */
async function registerServers() {
  const { servers = [] } = await api.storage.local.get('servers');
  const existing = await api.scripting.getRegisteredContentScripts();
  if (existing.length) await api.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  const allowed = [];
  for (const origin of servers) {
    if (await api.permissions.contains({ origins: [`${origin}/*`] })) allowed.push(origin);
  }
  if (allowed.length) {
    await api.scripting.registerContentScripts([
      { id: 'dela-verify', matches: allowed.map((o) => `${o}/*`), js: ['content.js'], runAt: 'document_idle' },
    ]);
  }
}

api.runtime.onInstalled.addListener((details) => {
  void registerServers();
  if (details.reason === 'install') api.runtime.openOptionsPage();
});
api.runtime.onStartup.addListener(() => void registerServers());
api.storage.onChanged.addListener((changes) => {
  if (changes.servers) void registerServers();
});
