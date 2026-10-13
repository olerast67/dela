import '@fontsource-variable/onest';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { controller } from './controller.ts';
import { applyTheme } from './ui/Views.tsx';
import { registerSW } from 'virtual:pwa-register';
import { showToast } from './ui/toast.tsx';

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
const updateSW = registerSW({
  onNeedRefresh() {
    showToast('Доступна новая версия Dela', { label: 'Обновить', run: () => void updateSW(true) }, 10 * 60_000);
  },
});
