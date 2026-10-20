import '@fontsource-variable/manrope';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { controller } from './controller.ts';
import { applyTheme } from './ui/Views.tsx';
import { registerSW } from 'virtual:pwa-register';
import { showToast } from './ui/toast.tsx';
import { isNative, localizeTray, onAppLink } from './platform.ts';
import { linkHash, openLinkHash } from './links.ts';
import { tr } from './i18n.ts';

try {
  applyTheme(localStorage.getItem('theme') ?? 'system');
} catch {
  // localStorage недоступен (приватный режим) — тема по системе
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void controller.init();

// Новая версия приложения: предлагаем обновиться, а не перезагружаем страницу посреди работы.
// В оболочках Tauri и Capacitor клиент встроен в приложение и обновляется вместе с ним.
if (!isNative()) {
  const updateSW = registerSW({
    onNeedRefresh() {
      showToast(tr('Доступна новая версия Dela'), { label: tr('Обновить'), run: () => void updateSW(true) }, 10 * 60_000);
    },
  });
}

void localizeTray().catch(() => undefined);

// Ссылка dela://open#/… ставит маршрут в адрес: экран откроется и после входа или разблокировки.
void onAppLink((url) => {
  const hash = linkHash(url);
  if (hash) openLinkHash(hash);
}).catch(() => undefined);
