import { useCallback, useEffect, useRef, useState } from 'react';
import { controller } from './controller.ts';
import { useAppState, useDoc, useMedia, useRoute } from './hooks.ts';
import { AuthScreen, RecoveryScreen } from './ui/Auth.tsx';
import { IconPlus } from './ui/icons.tsx';
import { TabBar } from './ui/TabBar.tsx';
import { QuickAdd } from './ui/QuickAdd.tsx';
import { Sidebar } from './ui/Sidebar.tsx';
import { TaskPanel } from './ui/TaskPanel.tsx';
import { ToastHost, showToast } from './ui/toast.tsx';
import { CommandPalette, ShortcutsHelp } from './ui/CommandPalette.tsx';
import { completeWithUndo } from './ui/Task.tsx';
import { checkDesktopUpdate, onBackButton, onNotificationOpen, onQuickAddRequest, onSharedText, onWidgetLaunch } from './platform.ts';
import { CalendarView } from './ui/Calendar.tsx';
import { LockScreen } from './ui/Lock.tsx';
import { ActivityView, TemplatesView } from './ui/History.tsx';
import type { QuickAddDefaults } from './ui/QuickAdd.tsx';
import { CompletedView, FilterView, LabelView, ProjectView, SearchView, SettingsView, TodayView, TrashView, UpcomingView } from './ui/Views.tsx';

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
  const [quickOverride, setQuickOverride] = useState<QuickAddDefaults | null>(null);
  const [quickVoice, setQuickVoice] = useState(false);
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [sharedText, setSharedText] = useState('');
  const [help, setHelp] = useState(false);

  const open = useCallback((id: string) => setSelected(id), []);
  const close = useCallback(() => setSelected(null), []);

  useEffect(() => {
    let gPressed = 0;
    const rows = () => [...document.querySelectorAll<HTMLElement>('.content .task[data-id]')];
    const focusedRow = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.task[data-id]') ?? null;
    const moveFocus = (delta: number) => {
      const list = rows();
      if (list.length === 0) return;
      const i = list.indexOf(focusedRow()!);
      const next = list[i === -1 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + delta))]!;
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    };

    const onKey = (e: KeyboardEvent) => {
      // Ctrl+K работает даже в поле ввода.
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (typing(e) || e.metaKey || e.altKey) return;
      if (e.ctrlKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault();
          if (doc.undo()) showToast('Отменено');
        }
        return;
      }
      const row = focusedRow();
      const taskId = row?.dataset.id ?? null;
      // «G, затем T» — переход, как в Todoist и Gmail.
      if (Date.now() - gPressed < 1000) {
        gPressed = 0;
        const target = { KeyT: 'today', KeyU: 'upcoming', KeyC: 'calendar', KeyI: 'inbox', KeyS: 'settings' }[e.code];
        if (target) {
          e.preventDefault();
          location.hash = `#/${target}`;
          return;
        }
      }
      switch (e.code) {
        case 'KeyQ':
        case 'KeyN':
          e.preventDefault();
          setQuickAdd(true);
          return;
        case 'KeyG':
          gPressed = Date.now();
          return;
        case 'ArrowDown':
        case 'KeyJ':
          e.preventDefault();
          moveFocus(1);
          return;
        case 'ArrowUp':
        case 'KeyK':
          e.preventDefault();
          moveFocus(-1);
          return;
        case 'KeyE':
          if (taskId) {
            const t = doc.task(taskId);
            if (t && t.completedAt === null) {
              moveFocus(1);
              completeWithUndo(doc, t);
            }
          }
          return;
        case 'KeyT':
          if (taskId) {
            const t = doc.task(taskId);
            if (t) {
              doc.updateTask(taskId, { due: { ...(t.due ?? {}), date: new Intl.DateTimeFormat('en-CA').format(new Date()) } });
              showToast('Перенесено на сегодня', { label: 'Отменить', run: () => doc.undo() });
            }
          }
          return;
        case 'Delete':
        case 'Backspace':
          if (taskId) {
            moveFocus(1);
            doc.deleteTask(taskId);
            if (selected === taskId) setSelected(null);
            showToast('Задача удалена', { label: 'Отменить', run: () => doc.undo() });
          }
          return;
        case 'Slash':
          e.preventDefault();
          if (e.shiftKey) setHelp(true);
          else document.getElementById('search')?.focus();
          return;
        case 'Escape':
          setQuickAdd(false);
          setSelected(null);
          return;
      }
      if (e.key === '?') setHelp(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, selected]);

  useEffect(() => setMenu(false), [route]);

  // Телефон: тап по уведомлению и кнопка «Назад».
  const backState = useRef({ quickAdd, selected, palette, help, menu });
  backState.current = { quickAdd, selected, palette, help, menu };
  useEffect(() => {
    const offs: Array<() => void> = [];
    let cancelled = false;
    const keep = (p: Promise<() => void>) =>
      void p.then((fn) => {
        if (cancelled) fn();
        else offs.push(fn);
      });
    keep(onNotificationOpen((id) => setSelected(id)));
    // Программа для Windows: через несколько секунд после запуска проверяем новую версию на GitHub.
    const updateTimer = setTimeout(() => {
      void checkDesktopUpdate()
        .then((u) => u && showToast(`Вышла версия ${u.version}`, { label: 'Обновить', run: () => void u.install() }, 60_000))
        .catch(() => undefined);
    }, 4000);
    keep(Promise.resolve(() => clearTimeout(updateTimer)));
    keep(
      onWidgetLaunch((e) => {
        if (e.taskId) setSelected(e.taskId);
        if (e.quickAdd || e.voice) setQuickAdd(true);
        if (e.voice) setQuickVoice(true);
      }),
    );
    keep(
      onSharedText((text) => {
        setSharedText(text);
        setQuickAdd(true);
      }),
    );
    keep(
      onBackButton(() => {
        const s = backState.current;
        if (s.quickAdd) setQuickAdd(false);
        else if (s.palette) setPalette(false);
        else if (s.help) setHelp(false);
        else if (s.selected) setSelected(null);
        else if (s.menu) setMenu(false);
        else if (!/^#\/(today)?$/.test(location.hash || '#/')) location.hash = '#/today';
        else return false;
        return true;
      }),
    );
    return () => {
      cancelled = true;
      offs.forEach((fn) => fn());
    };
  }, []);

  // Оболочка компьютера: «Новая задача» из трея и по Ctrl+Shift+Space из любой программы.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onQuickAddRequest(() => setQuickAdd(true)).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    controller.onReminder = (r) => showToast(`⏰ ${r.title}`, { label: 'Открыть', run: () => setSelected(r.taskId) }, 60_000);
    const onMessage = (e: MessageEvent<{ type?: string; taskId?: string; key?: string; title?: string }>) => {
      if (e.data?.type === 'open-task' && e.data.taskId) setSelected(e.data.taskId);
      if (e.data?.type === 'push-reminder' && e.data.key && e.data.taskId)
        controller.receivePushReminder({ key: e.data.key, title: e.data.title ?? '', taskId: e.data.taskId });
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    const fromUrl = new URLSearchParams(location.hash.split('?')[1] ?? '').get('task');
    if (fromUrl) setSelected(fromUrl);
    return () => {
      controller.onReminder = null;
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, []);

  const props = { onOpen: open, selectedId: selected };
  let view: React.ReactNode;
  switch (route.view) {
    case 'inbox':
      view = <ProjectView id={doc.inboxId} {...props} />;
      break;
    case 'upcoming':
      view = <UpcomingView {...props} />;
      break;
    case 'calendar':
      view = (
        <CalendarView
          mode={route.mode}
          date={route.date}
          {...props}
          onQuickAdd={(d) => {
            setQuickOverride(d);
            setQuickAdd(true);
          }}
        />
      );
      break;
    case 'project':
      view = <ProjectView id={route.id} {...props} />;
      break;
    case 'label':
      view = <LabelView id={route.id} {...props} />;
      break;
    case 'filter':
      view = <FilterView id={route.id} {...props} />;
      break;
    case 'search':
      view = <SearchView q={route.q} {...props} />;
      break;
    case 'completed':
      view = <CompletedView {...props} />;
      break;
    case 'activity':
      view = <ActivityView onOpen={open} />;
      break;
    case 'templates':
      view = <TemplatesView />;
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

  const quickDefaults: QuickAddDefaults = quickOverride ??
    (route.view === 'project' ? { projectId: route.id } : route.view === 'today' ? { due: { date: new Intl.DateTimeFormat('en-CA').format(new Date()) } } : {});

  return (
    <div className={`shell${selected ? ' with-panel' : ''}`}>
      {(!narrow || menu) && (
        <>
          {narrow && <div className="scrim" onClick={() => setMenu(false)} />}
          <Sidebar route={route} onNavigate={() => setMenu(false)} />
        </>
      )}
      <main className="content">
        <div className="content-inner">{view}</div>
      </main>
      {selected && narrow && <div className="panel-scrim" onClick={close} />}
      {selected && <TaskPanel id={selected} onClose={close} onOpen={open} />}
      {quickAdd && (
        <div
          className="modal-scrim"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            setQuickAdd(false);
            setQuickOverride(null);
          }}
        >
          <div className="modal">
            <QuickAdd
              defaults={quickDefaults}
              initialText={sharedText}
              autoVoice={quickVoice}
              onClose={() => {
                setQuickAdd(false);
                setQuickOverride(null);
                setQuickVoice(false);
                setSharedText('');
              }}
              compact={false}
            />
          </div>
        </div>
      )}
      {narrow && !selected && <TabBar route={route} onMore={() => setMenu(true)} />}
      <button className="fab" onClick={() => setQuickAdd(true)} aria-label="Добавить задачу (Q)">
        <IconPlus width={24} height={24} />
      </button>
      {palette && <CommandPalette onClose={() => setPalette(false)} onQuickAdd={() => setQuickAdd(true)} onOpen={open} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      <ToastHost />
    </div>
  );
}

export function App() {
  const { phase, locked } = useAppState();
  if (phase === 'loading') return <div className="splash" aria-busy="true" />;
  if (phase === 'auth') return <AuthScreen />;
  if (phase === 'recovery') return <RecoveryScreen />;
  if (locked) return <LockScreen />;
  if (!controller.doc) return <div className="splash" aria-busy="true" />;
  return <Shell />;
}
