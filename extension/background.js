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

const BADGES = {
  ok: { text: '✓', color: '#2E7D5B', title: 'Dela Verify: files match the release' },
  bad: { text: '!', color: '#C8402F', title: 'Dela Verify: files do NOT match the release' },
  unknown: { text: '?', color: '#8A918C', title: 'Dela Verify: no signed release for this version' },
};

api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'manifest') {
    loadManifest(String(msg.version)).then(reply);
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
