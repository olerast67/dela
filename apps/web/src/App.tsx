import { useCallback, useEffect, useRef, useState } from 'react';
import { controller } from './controller.ts';
import { href, useAppState, useDoc, useMedia, useRoute, type Route } from './hooks.ts';
import { AuthScreen, RecoveryScreen } from './ui/Auth.tsx';
import { IconPlus, IconX } from './ui/icons.tsx';
import { TabBar } from './ui/TabBar.tsx';
import { QuickAdd } from './ui/QuickAdd.tsx';
import { Sidebar } from './ui/Sidebar.tsx';
import { TaskPanel } from './ui/TaskPanel.tsx';
import { PomodoroChip } from './ui/Pomodoro.tsx';
import { ToastHost, showToast } from './ui/toast.tsx';
import { RecognizeBar, recognition } from './ui/Recognition.tsx';
import { SelectionBar } from './ui/SelectionBar.tsx';
import { clearPicked, pickedIds } from './ui/selection.ts';
import { CommandPalette, ShortcutsHelp } from './ui/CommandPalette.tsx';
import { completeWithUndo } from './ui/Task.tsx';
import { checkDesktopUpdate, closeViewWindow, onBackButton, onNotificationOpen, onQuickAddRequest, onSharedText, onWidgetLaunch, platform } from './platform.ts';
import { CalendarView } from './ui/Calendar.tsx';
import { LockScreen } from './ui/Lock.tsx';
import { StatsView } from './ui/Stats.tsx';
import { ActivityView, TemplatesView } from './ui/History.tsx';
import type { QuickAddDefaults } from './ui/QuickAdd.tsx';
import { CompletedView, FilterView, LabelView, ProjectView, SearchView, SettingsView, TodayView, TrashView, UpcomingView } from './ui/Views.tsx';
import { tr } from './i18n.ts';
import { offerAndroidUpdate } from './ui/AppUpdate.tsx';
import { appLink, copyLink, taskHash } from './links.ts';
import { isQuickWindow, isViewWindow, windowTaskId } from './viewWindow.ts';
import { QuickWindow } from './ui/QuickWindow.tsx';

/** Отдельное окно проекта или задачи (программа для Windows): без боковой панели и панели вкладок. */
const compact = typeof location !== 'undefined' && isViewWindow(location.search);
/** Отдельное окно задачи: только карточка на всё окно. */
const windowTask = compact ? windowTaskId(location.hash) : null;
/** Всплывающая строка быстрого добавления (Ctrl+Shift+Space). */
const quickWindow = typeof location !== 'undefined' && isQuickWindow(location.search);

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
  // Текст с картинки открывается сразу для правки: распознавание ошибается.
  const [sharedEdit, setSharedEdit] = useState(false);
  // Новое присланное открывает быстрое добавление заново, даже если оно уже открыто.
  const [sharedSeq, setSharedSeq] = useState(0);
  const [help, setHelp] = useState(false);

  const open = useCallback((id: string) => setSelected(id), []);
  const close = useCallback(() => setSelected(null), []);

  // Ссылка на открытую задачу, иначе на текущий экран.
  const linkTarget = useRef('');
  linkTarget.current = selected ? taskHash(selected) : href(route);
  const copyCurrentLink = useCallback(() => void copyLink(linkTarget.current, controller.getState().local, (text) => showToast(text)), []);

  // Ссылка #/task/<id>: проект задачи с открытой карточкой. Пока задача не пришла с сервера, ждём.
  const linked = route.view === 'task' ? doc.task(route.id) : undefined;
  useEffect(() => {
    if (!linked) return;
    const target: Route = !doc.isAlive(linked.id) ? { view: 'trash' } : linked.projectId === doc.inboxId ? { view: 'inbox' } : { view: 'project', id: linked.projectId };
    setSelected(linked.id);
    location.replace(href(target));
  }, [doc, linked]);

  // Пока открыта экранная клавиатура, панель вкладок и кнопка «+» не висят над ней и не закрывают список.
  useEffect(() => {
    const typing = (el: Element | null) =>
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(el.type)) ||
      (el instanceof HTMLElement && el.isContentEditable);
    const update = () => document.documentElement.classList.toggle('typing', typing(document.activeElement));
    const later = () => setTimeout(update, 0);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', later);
    };
  }, []);

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
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyC') {
        e.preventDefault();
        copyCurrentLink();
        return;
      }
      if (typing(e) || e.metaKey || e.altKey) return;
      if (e.ctrlKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault();
          if (doc.undo()) showToast(tr('Отменено'));
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
              showToast(tr('Перенесено на сегодня'), { label: tr('Отменить'), run: () => doc.undo() });
            }
          }
          return;
        case 'Delete':
        case 'Backspace':
          if (taskId) {
            moveFocus(1);
            doc.deleteTask(taskId);
            if (selected === taskId) setSelected(null);
            showToast(tr('Задача удалена'), { label: tr('Отменить'), run: () => doc.undo() });
          }
          return;
        case 'Slash':
          e.preventDefault();
          if (e.shiftKey) setHelp(true);
          else document.getElementById('search')?.focus();
          return;
        case 'Escape':
          if (pickedIds().size > 0) {
            clearPicked();
            return;
          }
          setQuickAdd(false);
          setSelected(null);
          return;
      }
      if (e.key === '?') setHelp(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, selected, copyCurrentLink]);

  useEffect(() => setMenu(false), [route]);
  useEffect(() => clearPicked(), [route]);

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
    keep(
      onNotificationOpen(
        (id) => setSelected(id),
        () => {
          // Утренняя сводка: экран «Сегодня» без открытой карточки.
          setSelected(null);
          location.hash = '#/today';
        },
      ),
    );
    // Программа для Windows и Android: через несколько секунд после запуска проверяем новую версию на GitHub.
    const updateTimer = setTimeout(() => {
      void checkDesktopUpdate()
        .then((u) => u && showToast(tr('Вышла версия {version}', { version: u.version }), { label: tr('Обновить'), run: () => void u.install() }, 60_000))
        .catch(() => undefined);
      // Android, APK из выпусков GitHub: та же плашка, не чаще раза в сутки.
      void offerAndroidUpdate().catch(() => undefined);
    }, 4000);
    keep(Promise.resolve(() => clearTimeout(updateTimer)));
    keep(
      onWidgetLaunch((e) => {
        if (e.taskId) setSelected(e.taskId);
        // Push утренней сводки на Android открывает «Сегодня».
        if (e.today && !e.taskId) {
          setSelected(null);
          location.hash = '#/today';
        }
        if (e.quickAdd || e.voice) setQuickAdd(true);
        if (e.voice) setQuickVoice(true);
      }),
    );
    keep(
      onSharedText(
        (text) => {
          setSharedText(text);
          setSharedEdit(false);
          setSharedSeq((n) => n + 1);
          setQuickAdd(true);
        },
        (kind) => void recognition.shared(kind),
      ),
    );
    // Картинка и голосовое распознаются в фоне; готовый текст открывается в быстром добавлении.
    recognition.setHandlers(
      (r) => {
        setSharedText(r.text);
        setSharedEdit(r.kind === 'image');
        setSharedSeq((n) => n + 1);
        setQuickAdd(true);
      },
      (text) => showToast(text),
    );
    keep(Promise.resolve(() => recognition.setHandlers(null, null)));
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
    // У утренней сводки нет задачи: «Открыть» ведёт на «Сегодня».
    const openToday = () => {
      setSelected(null);
      location.hash = '#/today';
    };
    controller.onReminder = (r) => showToast(`⏰ ${r.title}`, { label: tr('Открыть'), run: () => (r.taskId ? setSelected(r.taskId) : openToday()) }, 60_000);
    const onMessage = (e: MessageEvent<{ type?: string; taskId?: string; key?: string; title?: string }>) => {
      if (e.data?.type === 'open-task' && e.data.taskId) setSelected(e.data.taskId);
      if (e.data?.type === 'open-today') openToday();
      if (e.data?.type === 'push-reminder' && e.data.key)
        controller.receivePushReminder({ key: e.data.key, title: e.data.title ?? '', taskId: e.data.taskId ?? '' });
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
    case 'stats':
      view = <StatsView />;
      break;
    case 'templates':
      view = <TemplatesView />;
      break;
    case 'trash':
      view = <TrashView />;
      break;
    case 'task':
      view = linked ? null : <p className="empty">{tr('Задача не найдена: она ещё не загрузилась или удалена навсегда.')}</p>;
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
    <div className={`shell${selected ? ' with-panel' : ''}${compact ? ' compact' : ''}`}>
      {!compact && (!narrow || menu) && (
        <>
          {narrow && <div className="scrim" onClick={() => setMenu(false)} />}
          <Sidebar route={route} onNavigate={() => setMenu(false)} />
        </>
      )}
      <main className="content">
        <div className="content-inner">{view}</div>
      </main>
      {selected && narrow && <div className="panel-scrim" onClick={close} />}
      {selected && <TaskPanel id={selected} onClose={close} onOpen={open} onCopyLink={copyCurrentLink} />}
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
              key={sharedSeq}
              defaults={quickDefaults}
              initialText={sharedText}
              initialEdit={sharedEdit}
              autoVoice={quickVoice}
              onClose={() => {
                setQuickAdd(false);
                setQuickOverride(null);
                setQuickVoice(false);
                setSharedText('');
                setSharedEdit(false);
              }}
              compact={false}
            />
          </div>
        </div>
      )}
      {narrow && !selected && !compact && <TabBar route={route} onMore={() => setMenu(true)} />}
      <button className="fab" onClick={() => setQuickAdd(true)} aria-label={tr('Добавить задачу (Q)')}>
        <IconPlus width={24} height={24} />
      </button>
      {palette && <CommandPalette onClose={() => setPalette(false)} onQuickAdd={() => setQuickAdd(true)} onOpen={open} onCopyLink={copyCurrentLink} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      <SelectionBar />
      <RecognizeBar />
      <PomodoroChip onOpen={open} />
      <ToastHost />
    </div>
  );
}

/** Отдельное окно задачи: карточка на всё окно, без списка за ней. Закрытие карточки закрывает окно. */
function TaskWindow({ id: first }: { id: string }) {
  // Подзадача или родитель открываются в этом же окне.
  const [id, setId] = useState(first);
  const close = useCallback(() => void closeViewWindow(), []);
  const copy = useCallback(() => void copyLink(taskHash(id), controller.getState().local, (text) => showToast(text)), [id]);
  return (
    <div className="task-window">
      <TaskPanel id={id} onClose={close} onOpen={setId} onCopyLink={copy} inWindow />
      <ToastHost />
    </div>
  );
}

// Hash, с которым открыта страница: по нему браузер телефона предлагает открыть ссылку в приложении.
const openedHash = typeof location === 'undefined' ? '' : location.hash;

/**
 * Браузер на Android открыл ссылку на задачу: кнопка «Открыть в приложении» по схеме dela://.
 * Если приложения нет, кнопка ничего не делает; закрывается крестиком.
 */
function OpenInApp() {
  const [shown, setShown] = useState(() => platform() === 'web' && /Android/i.test(navigator.userAgent) && /^#\/task\//.test(openedHash));
  if (!shown) return null;
  return (
    <div className="open-in-app" role="region" aria-label={tr('Открыть в приложении')}>
      <a className="open-in-app-link" href={appLink(openedHash)} onClick={() => setTimeout(() => setShown(false), 500)}>
        {tr('Открыть в приложении Dela')}
      </a>
      <button className="icon" onClick={() => setShown(false)} aria-label={tr('Закрыть')}>
        <IconX />
      </button>
    </div>
  );
}

function Screen() {
  const { phase, locked } = useAppState();
  if (phase === 'loading') return <div className="splash" aria-busy="true" />;
  if (phase === 'auth') return <AuthScreen />;
  if (phase === 'recovery') return <RecoveryScreen />;
  if (locked) return <LockScreen />;
  if (!controller.doc) return <div className="splash" aria-busy="true" />;
  return windowTask ? <TaskWindow id={windowTask} /> : <Shell />;
}

export function App() {
  if (quickWindow) return <QuickWindow />;
  return (
    <>
      <Screen />
      <OpenInApp />
    </>
  );
}
