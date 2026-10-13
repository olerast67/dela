import { useCallback, useEffect, useState } from 'react';
import { controller } from './controller.ts';
import { useAppState, useDoc, useMedia, useRoute } from './hooks.ts';
import { AuthScreen, RecoveryScreen } from './ui/Auth.tsx';
import { IconMenu, IconPlus } from './ui/icons.tsx';
import { QuickAdd } from './ui/QuickAdd.tsx';
import { Sidebar } from './ui/Sidebar.tsx';
import { TaskPanel } from './ui/TaskPanel.tsx';
import { ToastHost, showToast } from './ui/toast.tsx';
import { CompletedView, LabelView, ProjectView, SearchView, SettingsView, TodayView, TrashView, UpcomingView } from './ui/Views.tsx';

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function Shell() {
  const doc = useDoc();
  const route = useRoute();
  const narrow = useMedia('(max-width: 760px)');
  const [selected, setSelected] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [menu, setMenu] = useState(false);

  const open = useCallback((id: string) => setSelected(id), []);
  const close = useCallback(() => setSelected(null), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.altKey) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (doc.undo()) showToast('Отменено');
        return;
      }
      if (e.ctrlKey) return;
      if (e.key === 'q' || e.key === 'й' || e.key === 'n' || e.key === 'т') {
        e.preventDefault();
        setQuickAdd(true);
      } else if (e.key === '/') {
        e.preventDefault();
        document.getElementById('search')?.focus();
      } else if (e.key === 'Escape') {
        setQuickAdd(false);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc]);

  useEffect(() => setMenu(false), [route]);

  const props = { onOpen: open, selectedId: selected };
  let view: React.ReactNode;
  switch (route.view) {
    case 'inbox':
      view = <ProjectView id={doc.inboxId} {...props} />;
      break;
    case 'upcoming':
      view = <UpcomingView {...props} />;
      break;
    case 'project':
      view = <ProjectView id={route.id} {...props} />;
      break;
    case 'label':
      view = <LabelView id={route.id} {...props} />;
      break;
    case 'search':
      view = <SearchView q={route.q} {...props} />;
      break;
    case 'completed':
      view = <CompletedView {...props} />;
      break;
    case 'trash':
      view = <TrashView />;
      break;
    case 'settings':
      view = <SettingsView />;
      break;
    default:
      view = <TodayView {...props} />;
  }

  const quickDefaults =
    route.view === 'project' ? { projectId: route.id } : route.view === 'today' ? { due: { date: new Intl.DateTimeFormat('en-CA').format(new Date()) } } : {};

  return (
    <div className={`shell${selected ? ' with-panel' : ''}`}>
      {(!narrow || menu) && (
        <>
          {narrow && <div className="scrim" onClick={() => setMenu(false)} />}
          <Sidebar route={route} onNavigate={() => setMenu(false)} />
        </>
      )}
      <main className="content">
        {narrow && (
          <div className="topbar">
            <button className="icon" onClick={() => setMenu(true)} aria-label="Меню">
              <IconMenu />
            </button>
          </div>
        )}
        <div className="content-inner">{view}</div>
      </main>
      {selected && <TaskPanel id={selected} onClose={close} onOpen={open} />}
      {quickAdd && (
        <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && setQuickAdd(false)}>
          <div className="modal">
            <QuickAdd defaults={quickDefaults} onClose={() => setQuickAdd(false)} compact={false} />
          </div>
        </div>
      )}
      <button className="fab" onClick={() => setQuickAdd(true)} aria-label="Добавить задачу (Q)">
        <IconPlus width={24} height={24} />
      </button>
      <ToastHost />
    </div>
  );
}

export function App() {
  const { phase } = useAppState();
  if (phase === 'loading') return <div className="splash" aria-busy="true" />;
  if (phase === 'auth') return <AuthScreen />;
  if (phase === 'recovery') return <RecoveryScreen />;
  if (!controller.doc) return <div className="splash" aria-busy="true" />;
  return <Shell />;
}
