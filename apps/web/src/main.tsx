import '@fontsource-variable/onest';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { controller } from './controller.ts';
import { applyTheme } from './ui/Views.tsx';

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
