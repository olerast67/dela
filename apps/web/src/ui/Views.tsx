import { useEffect, useState } from 'react';
import { COLORS, FilterSyntaxError, type ProjectTasks, type TaskNode, exportJson, exportMarkdown, fetchTodoist, importTodoist, normalizeText, runFilter, type DeviceInfo, type TaskView, type TodoistData } from '#core';
import { controller } from '../controller.ts';
import { TZ, dayHeading, plural, todayDate } from '../format.ts';
import { navigate, useAppState, useDoc } from '../hooks.ts';
import { DropContext, dropZone, type DropOnTask } from './dnd.ts';
import { QuickAdd, type QuickAddDefaults } from './QuickAdd.tsx';
import { EmptyArt, type EmptyKind } from './EmptyArt.tsx';
import { LockSettings } from './Lock.tsx';
import { ShareDialog } from './Share.tsx';
import { REMINDER_OPTIONS } from './TaskPanel.tsx';
import { TaskList, TaskTree } from './Task.tsx';
import { showToast } from './toast.tsx';

interface ViewProps {
  readonly onOpen: (id: string) => void;
  readonly selectedId: string | null;
}

function AddTask({ defaults, label = 'Добавить задачу' }: { defaults: QuickAddDefaults; label?: string }) {
  const [open, setOpen] = useState(false);
  if (open) return <QuickAdd defaults={defaults} onClose={() => setOpen(false)} />;
  return (
    <button className="add-row" onClick={() => setOpen(true)}>
      + {label}
    </button>
  );
}

function Empty({ children, art }: { children: React.ReactNode; art?: EmptyKind | undefined }) {
  if (!art) return <p className="empty">{children}</p>;
  return (
    <div className="empty with-art">
      <EmptyArt kind={art} />
      <p>{children}</p>
    </div>
  );
}

/** Заголовок «Сегодня»: дата и кольцо прогресса (выполнено сегодня из запланированного на сегодня). */
function TodayHead({ open, today }: { open: number; today: string }) {
  const doc = useDoc();
  const done = doc.completedTasks().filter((t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t.completedAt!)) === today).length;
  const total = open + done;
  const r = 20;
  const c = 2 * Math.PI * r;
  const part = total ? (c * done) / total : 0;
  const date = new Intl.DateTimeFormat('ru', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${today}T12:00:00`));
  return (
    <header className="view-head today-head">
      <div>
        <h1>Сегодня</h1>
        <div className="today-date">{date[0]!.toUpperCase() + date.slice(1)}</div>
      </div>
      {total > 0 && (
        <div className="ring" role="img" aria-label={`Выполнено ${done} из ${total}`} title={`Выполнено ${done} из ${total}`}>
          <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
            <circle cx="26" cy="26" r={r} className="ring-track" />
            {done > 0 && <circle cx="26" cy="26" r={r} className="ring-value" strokeDasharray={`${part} ${c}`} transform="rotate(-90 26 26)" />}
          </svg>
          <span>
            {done}/{total}
          </span>
        </div>
      )}
    </header>
  );
}

export function TodayView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const today = todayDate();
  const { overdue, today: todays } = doc.today(today, TZ);
  return (
    <>
      <TodayHead open={overdue.length + todays.length} today={today} />
      {overdue.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Просрочено</h2>
            <button
              className="link"
              onClick={() => {
                const changes = overdue.map((t) => ['task', t.id, 'due', { ...t.due!, date: today }] as const);
                doc.writeTasks(changes);
                showToast(`${plural(overdue.length, 'задача перенесена', 'задачи перенесены', 'задач перенесено')} на сегодня`, {
                  label: 'Отменить',
                  run: () => doc.undo(),
                });
              }}
            >
              Перенести на сегодня
            </button>
          </div>
          <TaskList tasks={overdue} onOpen={onOpen} selectedId={selectedId} />
        </section>
      )}
      <section>
        {overdue.length > 0 && <h2>{dayHeading(today)}</h2>}
        <TaskList tasks={todays} onOpen={onOpen} selectedId={selectedId} showDate={false} />
        <AddTask defaults={{ due: { date: today } }} />
      </section>
      {overdue.length + todays.length === 0 && <Empty art="today">На сегодня всё. Новые задачи с датой «сегодня» появятся здесь.</Empty>}
    </>
  );
}

export function UpcomingView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const today = todayDate();
  const [days, setDays] = useState(14);
  const overdue = doc.today(today, TZ).overdue;
  const groups = doc.upcoming(today, days, TZ);
  const moveTo = (taskId: string, date: string) => {
    const t = doc.task(taskId);
    if (t) doc.updateTask(taskId, { due: { ...(t.due ?? {}), date } });
  };
  const onDropTask: DropOnTask = (dragId, target) => {
    if (target.due) moveTo(dragId, target.due.date);
  };
  return (
    <DropContext.Provider value={onDropTask}>
      <header className="view-head">
        <h1>Предстоящие</h1>
      </header>
      {overdue.length > 0 && (
        <section>
          <h2>Просрочено</h2>
          <TaskList tasks={overdue} onOpen={onOpen} selectedId={selectedId} />
        </section>
      )}
      {groups.map((g) => (
        <section key={g.date} className="day">
          <h2 {...dropZone((t) => moveTo(t, g.date))}>{dayHeading(g.date, today)}</h2>
          <TaskList tasks={g.tasks} onOpen={onOpen} selectedId={selectedId} showDate={false} />
          <AddTask defaults={{ due: { date: g.date } }} />
        </section>
      ))}
      <button className="add-row" onClick={() => setDays(days + 14)}>
        Показать ещё две недели
      </button>
    </DropContext.Provider>
  );
}

export function ProjectView({ id, onOpen, selectedId }: ViewProps & { id: string }) {
  const doc = useDoc();
  const project = doc.project(id);
  const [renaming, setRenaming] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  const [sharing, setSharing] = useState(false);
  if (!project || (!doc.projects().some((p) => p.project.id === id) && !project.isInbox)) {
    return <Empty>Проект не найден или удалён.</Empty>;
  }
  const view = doc.projectTasks(id);
  const isInbox = project.isInbox;
  const onDropTask: DropOnTask = (dragId, target, where) => {
    try {
      if (where === 'inside') doc.moveTask(dragId, { parentId: target.id });
      else
        doc.moveTask(dragId, {
          projectId: target.projectId,
          sectionId: target.parentId ? null : target.sectionId,
          parentId: target.parentId,
          position: where === 'before' ? { before: target.id } : { after: target.id },
        });
    } catch {
      showToast('Нельзя положить задачу внутрь её самой');
    }
  };
  const total = view.unsectioned.length + view.sections.reduce((n, s) => n + s.tasks.length, 0);

  return (
    <DropContext.Provider value={onDropTask}>
      <header className="view-head" {...dropZone((t) => doc.moveTask(t, { projectId: id, sectionId: null, position: { before: view.unsectioned[0]?.task.id ?? null } }))}>
        {renaming ? (
          <input
            className="h1-input"
            autoFocus
            defaultValue={project.name}
            onBlur={(e) => {
              if (e.target.value.trim()) doc.updateProject(id, { name: e.target.value });
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <h1 onDoubleClick={() => !isInbox && setRenaming(true)}>{isInbox ? 'Входящие' : project.name}</h1>
        )}
        <div className="segmented" role="group" aria-label="Вид">
          <button className={project.view !== 'board' ? 'active' : ''} onClick={() => doc.updateProject(id, { view: 'list' })}>
            Список
          </button>
          <button className={project.view === 'board' ? 'active' : ''} onClick={() => doc.updateProject(id, { view: 'board' })}>
            Доска
          </button>
        </div>
        {!isInbox && (
          <div className="head-actions">
            <select value={project.color} onChange={(e) => doc.updateProject(id, { color: e.target.value })} aria-label="Цвет проекта">
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button onClick={() => setSharing(true)}>{doc.isShared(id) ? 'Участники' : 'Поделиться'}</button>
            <button onClick={() => setRenaming(true)}>Переименовать</button>
            <button onClick={() => setAddingSection(true)}>Раздел</button>
            {(!doc.isShared(id) || controller.roleIn(id) === 'owner') && (
            <button
              className="danger"
              onClick={() => {
                if (!confirm(`Удалить проект «${project.name}» вместе с задачами?`)) return;
                doc.deleteProject(id);
                navigate({ view: 'inbox' });
                showToast('Проект удалён', { label: 'Отменить', run: () => doc.undo() });
              }}
            >
              Удалить
            </button>
            )}
          </div>
        )}
      </header>
      {sharing && <ShareDialog projectId={id} onClose={() => setSharing(false)} />}
      {project.view === 'board' ? (
        <Board projectId={id} view={view} onOpen={onOpen} selectedId={selectedId} onAddSection={() => setAddingSection(true)} />
      ) : (
        <>
      <section>
        <TaskTree nodes={view.unsectioned} onOpen={onOpen} selectedId={selectedId} />
        <AddTask defaults={{ projectId: id, sectionId: null }} />
      </section>
      {view.sections.map(({ section, tasks }) => (
        <section key={section.id}>
          <div className="section-head" {...dropZone((t) => doc.moveTask(t, { projectId: id, sectionId: section.id }))}>
            <h2
              onDoubleClick={() => {
                const name = prompt('Название раздела', section.name);
                if (name?.trim()) doc.updateSection(section.id, { name });
              }}
            >
              {section.name} <span className="muted">{tasks.length || ''}</span>
            </h2>
            <button
              className="link"
              onClick={() => {
                doc.deleteSection(section.id);
                showToast('Раздел удалён', { label: 'Отменить', run: () => doc.undo() });
              }}
            >
              Удалить раздел
            </button>
          </div>
          <TaskTree nodes={tasks} onOpen={onOpen} selectedId={selectedId} />
          <AddTask defaults={{ projectId: id, sectionId: section.id }} />
        </section>
      ))}
        </>
      )}
      {addingSection && (
        <input
          className="nav-input"
          autoFocus
          placeholder="Название раздела"
          onBlur={() => setAddingSection(false)}
          onKeyDown={(e) => {
            const v = e.currentTarget.value.trim();
            if (e.key === 'Enter' && v) {
              doc.createSection(id, v);
              setAddingSection(false);
            } else if (e.key === 'Escape') setAddingSection(false);
          }}
        />
      )}
      {total === 0 && <Empty art={isInbox ? 'inbox' : undefined}>{isInbox ? 'Входящие пусты. Всё, что не разобрано по проектам, попадает сюда.' : 'В проекте пока нет задач.'}</Empty>}
    </DropContext.Provider>
  );
}

export function LabelView({ id, onOpen, selectedId }: ViewProps & { id: string }) {
  const doc = useDoc();
  const label = doc.label(id);
  if (!label || label.deletedAt !== null) return <Empty>Метка не найдена.</Empty>;
  const tasks = doc.openTasks().filter((t) => t.labels.includes(id));
  return (
    <>
      <header className="view-head">
        <h1>{label.name}</h1>
        <div className="head-actions">
          <button
            onClick={() => {
              const name = prompt('Название метки', label.name);
              if (name?.trim()) doc.updateLabel(id, { name });
            }}
          >
            Переименовать
          </button>
          <button
            className="danger"
            onClick={() => {
              doc.deleteLabel(id);
              navigate({ view: 'today' });
            }}
          >
            Удалить
          </button>
        </div>
      </header>
      <TaskList tasks={tasks} onOpen={onOpen} selectedId={selectedId} />
      {tasks.length === 0 && <Empty>Задач с этой меткой нет.</Empty>}
    </>
  );
}

export function SearchView({ q, onOpen, selectedId }: ViewProps & { q: string }) {
  const doc = useDoc();
  const [withDone, setWithDone] = useState(false);
  const results = doc.search(q, { completed: withDone });
  return (
    <>
      <header className="view-head">
        <h1>Поиск: {q}</h1>
        <label className="checkline">
          <input type="checkbox" checked={withDone} onChange={(e) => setWithDone(e.target.checked)} /> с выполненными
        </label>
      </header>
      <TaskList tasks={results} onOpen={onOpen} selectedId={selectedId} />
      {normalizeText(q) && results.length === 0 && <Empty art="search">Ничего не найдено.</Empty>}
    </>
  );
}

export function CompletedView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const tasks: TaskView[] = doc.completedTasks().slice(0, 300);
  return (
    <>
      <header className="view-head">
        <h1>Выполненные</h1>
      </header>
      <TaskList tasks={tasks} onOpen={onOpen} selectedId={selectedId} />
      {tasks.length === 0 && <Empty art="done">Здесь будут выполненные задачи.</Empty>}
    </>
  );
}

export function TrashView() {
  const doc = useDoc();
  const tasks = doc.trash().slice(0, 300);
  return (
    <>
      <header className="view-head">
        <h1>Корзина</h1>
        {tasks.length > 0 && (
          <button
            onClick={() => {
              if (confirm(`Удалить навсегда ${plural(doc.trash().length, 'задачу', 'задачи', 'задач')}? Отменить это нельзя.`)) {
                const n = doc.emptyTrash();
                showToast(`Удалено навсегда: ${n}`);
              }
            }}
          >
            Очистить корзину
          </button>
        )}
      </header>
      {tasks.map((t) => (
        <div key={t.id} className="trash-row">
          <span>{t.title}</span>
          <button onClick={() => doc.restoreTask(t.id)}>Восстановить</button>
          <button
            className="danger"
            onClick={() => {
              if (confirm(`Удалить «${t.title}» навсегда? Отменить это нельзя.`)) doc.purgeTask(t.id);
            }}
          >
            Удалить навсегда
          </button>
        </div>
      ))}
      {tasks.length === 0 && <Empty>Корзина пуста.</Empty>}
    </>
  );
}

const THEMES = [
  ['system', 'Как в системе'],
  ['light', 'Светлая'],
  ['dark', 'Тёмная'],
] as const;

export function applyTheme(theme: string): void {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function SettingsView() {
  const { email, isAdmin, status } = useAppState();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') ?? 'system');

  useEffect(() => {
    controller.api
      .devices()
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  }, []);

  return (
    <>
      <header className="view-head">
        <h1>Настройки</h1>
      </header>
      <section className="settings">
        <h2>Аккаунт</h2>
        <p>{email}</p>
        <p className="muted">
          {status.lastSyncedAt ? `Последняя синхронизация: ${new Date(status.lastSyncedAt).toLocaleTimeString('ru')}` : 'Ещё не синхронизировано'}
        </p>
        <button className="danger" onClick={() => confirm('Выйти? Неотправленные изменения на этом устройстве будут потеряны.') && controller.logout()}>
          Выйти
        </button>
      </section>
      <section className="settings">
        <h2>Тема</h2>
        <div className="row">
          {THEMES.map(([value, label]) => (
            <button
              key={value}
              className={theme === value ? 'active' : ''}
              onClick={() => {
                setTheme(value);
                localStorage.setItem('theme', value);
                applyTheme(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings">
        <h2>Устройства</h2>
        {devices === null && <p className="muted">Загрузка…</p>}
        {devices?.map((d) => (
          <div key={d.id} className="trash-row">
            <span>
              {d.name} {d.current && <span className="muted">· это устройство</span>}
              <br />
              <span className="muted">Активность: {new Date(d.lastSeenAt).toLocaleString('ru')}</span>
            </span>
            {!d.current && (
              <button
                onClick={async () => {
                  await controller.api.revokeDevice(d.id);
                  setDevices(devices.filter((x) => x.id !== d.id));
                }}
              >
                Отключить
              </button>
            )}
          </div>
        ))}
      </section>
      <ReminderSettings />
      <ChangePassword />
      <TwoFactor />
      <LockSettings />
      <DeleteAccount />
      <ImportExport />
      {isAdmin && (
        <section className="settings">
          <h2>Приглашения</h2>
          <p className="muted">Регистрация на сервере закрыта. Приглашение действует 7 дней и подходит одному человеку.</p>
          <button
            onClick={async () => {
              const r = await controller.api.createInvite();
              setInvite(r.code);
            }}
          >
            Создать приглашение
          </button>
          {invite && <code className="recovery-key">{`${location.origin}/?invite=${invite}`}</code>}
        </section>
      )}
    </>
  );
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ImportExport() {
  const doc = useDoc();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);

  function apply(data: TodoistData) {
    const s = importTodoist(doc.personal, data);
    const parts = [
      plural(s.tasks, 'задача', 'задачи', 'задач'),
      plural(s.projects, 'проект', 'проекта', 'проектов'),
      plural(s.labels, 'метка', 'метки', 'меток'),
      plural(s.filters, 'фильтр', 'фильтра', 'фильтров'),
    ];
    const warn = s.unparsedRecurrences.length
      ? ` Не распознаны повторы: ${s.unparsedRecurrences.join('; ')}. Их текст сохранён в описании задач.`
      : '';
    setResult(`Перенесено: ${parts.join(', ')}.${warn}`);
  }

  const confirmImport = () => confirm('Импорт добавит задачи к уже существующим. Повторный импорт создаст копии. Продолжить?');

  return (
    <section className="settings">
      <h2>Импорт из Todoist</h2>
      <p className="muted">
        Токен: Todoist → Настройки → Интеграции → Для разработчиков. Запрос идёт из браузера напрямую в Todoist, сервер Dela токен не видит.
      </p>
      <div className="row wrap">
        <input type="password" placeholder="Токен API Todoist" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Токен Todoist" />
        <button
          className="primary"
          disabled={!token.trim() || busy}
          onClick={async () => {
            if (!confirmImport()) return;
            setBusy(true);
            setResult(null);
            try {
              apply(await fetchTodoist(token));
              setToken('');
            } catch (err) {
              if (err instanceof Error && err.message === 'todoist_unauthorized') setResult('Todoist не принял токен.');
              else {
                setResult('Браузер не смог обратиться к Todoist. Загрузите данные файлом.');
                setFallback(true);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Загрузка…' : 'Импортировать'}
        </button>
      </div>
      {fallback && (
        <p className="muted">
          Выполните в терминале и загрузите получившийся файл:
          <code className="recovery-key">
            curl https://api.todoist.com/api/v1/sync -H "Authorization: Bearer ТОКЕН" -d sync_token=* -d 'resource_types=["all"]' -o todoist.json
          </code>
        </p>
      )}
      <label className="row">
        <span className="muted">или файл JSON:</span>
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file || !confirmImport()) return;
            try {
              apply(JSON.parse(await file.text()) as TodoistData);
            } catch {
              setResult('Файл не похож на выгрузку Todoist.');
            }
          }}
        />
      </label>
      {result && <p className="notice">{result}</p>}

      <h2>Экспорт</h2>
      <p className="muted">Выгрузка собирается на этом устройстве из расшифрованных данных.</p>
      <div className="row">
        <button onClick={() => download(`dela-${todayDate()}.json`, JSON.stringify({ ...exportJson(doc.personal), shared: doc.docs().filter((d) => d.kind === 'shared').map((d) => exportJson(d)) }, null, 2), 'application/json')}>JSON</button>
        <button onClick={() => download(`dela-${todayDate()}.md`, doc.docs().map((d) => exportMarkdown(d)).join(String.fromCharCode(10)), 'text/markdown')}>Markdown</button>
      </div>
    </section>
  );
}

export function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section className="settings">
      <h2>Пароль</h2>
      <p className="muted">При смене пароля данные не перешифровываются, меняется только обёртка ключа. Другие устройства войдут заново.</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          if (next.length < 10) return setMsg('Новый пароль должен быть не короче 10 символов.');
          if (next !== repeat) return setMsg('Пароли не совпадают.');
          setBusy(true);
          await new Promise((r) => setTimeout(r, 30));
          try {
            await controller.changePassword(current, next);
            setMsg('Пароль изменён.');
            setCurrent('');
            setNext('');
            setRepeat('');
          } catch (err) {
            setMsg(err instanceof Error && err.name === 'DecryptError' ? 'Текущий пароль неверный.' : 'Не удалось изменить пароль.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <input type="password" autoComplete="current-password" placeholder="Текущий пароль" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder="Новый пароль" value={next} onChange={(e) => setNext(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder="Новый пароль ещё раз" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        <button disabled={busy}>{busy ? 'Подождите…' : 'Сменить пароль'}</button>
      </form>
      {msg && <p className="notice">{msg}</p>}
    </section>
  );
}

const FILTER_EXAMPLES = ['сегодня | просрочено', '(today | overdue) & p1', '#Работа & !@ждёт', 'следующие 7 дней', 'без даты & !подзадачи', 'поиск: молоко'];

export function FilterView({ id, onOpen, selectedId }: ViewProps & { id: string }) {
  const doc = useDoc();
  const existing = id === 'new' ? undefined : doc.filters().find((f) => f.id === id);
  const [editing, setEditing] = useState(id === 'new');
  const [name, setName] = useState(existing?.name ?? '');
  const [query, setQuery] = useState(existing?.query ?? '');
  useEffect(() => {
    setEditing(id === 'new');
    setName(existing?.name ?? '');
    setQuery(existing?.query ?? '');
  }, [id]);

  if (id !== 'new' && !existing) return <Empty>Фильтр не найден.</Empty>;
  const q = editing ? query : existing!.query;
  let result: { tasks: TaskView[]; unknown: string[] } | null = null;
  let error: string | null = null;
  if (q.trim()) {
    try {
      result = runFilter(doc, q, todayDate(), TZ);
    } catch (err) {
      error = err instanceof FilterSyntaxError ? err.message : 'ошибка в запросе';
    }
  }

  return (
    <>
      <header className="view-head">
        <h1>{editing ? (id === 'new' ? 'Новый фильтр' : 'Фильтр') : existing!.name}</h1>
        {!editing && (
          <div className="head-actions">
            <button onClick={() => setEditing(true)}>Изменить</button>
            <button
              className="danger"
              onClick={() => {
                doc.deleteFilter(id);
                navigate({ view: 'today' });
                showToast('Фильтр удалён', { label: 'Отменить', run: () => doc.undo() });
              }}
            >
              Удалить
            </button>
          </div>
        )}
      </header>
      {editing && (
        <form
          className="stack wide"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !query.trim() || error) return;
            if (id === 'new') navigate({ view: 'filter', id: doc.createFilter(name, query) });
            else {
              doc.updateFilter(id, { name, query });
              setEditing(false);
            }
          }}
        >
          <input placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} autoFocus required aria-label="Название фильтра" />
          <input placeholder="Запрос, например: сегодня | просрочено" value={query} onChange={(e) => setQuery(e.target.value)} required aria-label="Запрос" />
          <div className="chips">
            {FILTER_EXAMPLES.map((ex) => (
              <button type="button" key={ex} className="chip" onClick={() => setQuery(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div className="row">
            <button className="primary" disabled={!name.trim() || !query.trim() || !!error}>
              Сохранить
            </button>
            {id !== 'new' && (
              <button type="button" onClick={() => setEditing(false)}>
                Отмена
              </button>
            )}
          </div>
        </form>
      )}
      {!editing && <p className="muted mono">{existing!.query}</p>}
      {error && <p className="error">Ошибка в запросе: {error}</p>}
      {result && result.unknown.length > 0 && <p className="notice">Не понял: {result.unknown.map((u) => `«${u}»`).join(', ')}</p>}
      {result && <TaskList tasks={result.tasks} onOpen={onOpen} selectedId={selectedId} />}
      {result && result.tasks.length === 0 && !error && <Empty>Под фильтр ничего не попадает.</Empty>}
    </>
  );
}

export function ReminderSettings() {
  const [permission, setPermission] = useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const [defaults, setDefaults] = useState(() => controller.reminderDefaults());
  const [push, setPush] = useState(() => controller.pushEnabled());
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  return (
    <section className="settings">
      <h2>Напоминания</h2>
      <p className="muted">
        Задачам со временем Dela напоминает по умолчанию так, как выбрано ниже. У отдельной задачи это можно изменить в её карточке. Пока приложение
        закрыто, напоминания приходят через push: сервер знает только время отправки, текст зашифрован ключом этого устройства.
      </p>
      <label className="checkline">
        <input
          type="checkbox"
          checked={push}
          onChange={async (e) => {
            setPushMsg(null);
            try {
              if (e.target.checked) {
                const r = await controller.enablePush();
                if (r === 'ok') setPush(true);
                else setPushMsg(r === 'denied' ? 'Уведомления запрещены в браузере.' : 'Этот браузер не поддерживает push-уведомления.');
                setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
              } else {
                await controller.disablePush();
                setPush(false);
              }
            } catch {
              setPushMsg('Не удалось включить push. Проверьте, что сервер открыт по HTTPS.');
            }
          }}
        />
        Напоминать, когда приложение закрыто
      </label>
      {pushMsg && <p className="notice">{pushMsg}</p>}
      {permission === 'default' && (
        <button className="primary" onClick={async () => setPermission(await Notification.requestPermission())}>
          Разрешить уведомления
        </button>
      )}
      {permission === 'denied' && <p className="notice">Уведомления запрещены в настройках браузера. Напоминания будут видны только внутри приложения.</p>}
      {permission === 'unsupported' && <p className="notice">Этот браузер не умеет показывать уведомления.</p>}
      <div className="row wrap" style={{ marginTop: 10 }}>
        {REMINDER_OPTIONS.map(([m, label]) => {
          const on = defaults.includes(m);
          return (
            <button
              key={m}
              className={`pill toggle c-green${on ? ' on' : ''}`}
              onClick={() => {
                const next = on ? defaults.filter((x) => x !== m) : [...defaults, m].sort((a, b) => a - b);
                setDefaults(next);
                controller.setReminderDefaults(next);
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Доска: колонки — разделы проекта, карточки — задачи верхнего уровня. */
function Board({
  projectId,
  view,
  onOpen,
  selectedId,
  onAddSection,
}: ViewProps & { projectId: string; view: ProjectTasks; onAddSection: () => void }) {
  const doc = useDoc();
  const columns: Array<{ id: string | null; name: string; tasks: readonly TaskNode[] }> = [
    { id: null, name: 'Без раздела', tasks: view.unsectioned },
    ...view.sections.map((s) => ({ id: s.section.id, name: s.section.name, tasks: s.tasks })),
  ];
  return (
    <div className="board">
      {columns.map((col) => (
        <div key={col.id ?? 'none'} className="column" {...dropZone((t) => doc.moveTask(t, { projectId, sectionId: col.id }))}>
          <div className="column-head">
            <span>{col.name}</span>
            <span className="muted">{col.tasks.length || ''}</span>
          </div>
          <div className="cards">
            <TaskTree nodes={col.tasks.map((n) => ({ task: n.task, children: [] }))} onOpen={onOpen} selectedId={selectedId} />
          </div>
          <AddTask defaults={{ projectId, sectionId: col.id }} label="Добавить" />
        </div>
      ))}
      <button className="column add-column" onClick={onAddSection}>
        + Раздел
      </button>
    </div>
  );
}

export function TwoFactor() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    controller.api
      .account()
      .then((a) => setEnabled(a.totpEnabled))
      .catch(() => setEnabled(null));
  }, []);

  const fail = (err: unknown) =>
    setMsg(err instanceof Error && err.message === 'invalid_totp' ? 'Код не подошёл. Введите новый код из приложения.' : 'Не получилось. Нужна связь с сервером.');

  return (
    <section className="settings">
      <h2>Двухфакторный вход</h2>
      <p className="muted">
        При входе на новом устройстве кроме пароля понадобится код из приложения-аутентификатора (Aegis, Google Authenticator, 2FAS). Вход по ключу
        восстановления кода не требует.
      </p>
      {enabled === true && (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await controller.api.totpDisable(code.replace(/\s/g, ''));
              setEnabled(false);
              setCode('');
              setMsg('Двухфакторный вход отключён.');
            } catch (err) {
              fail(err);
            }
          }}
        >
          <span>Включён.</span>
          <input inputMode="numeric" placeholder="Код для отключения" value={code} onChange={(e) => setCode(e.target.value)} required aria-label="Код" />
          <button>Отключить</button>
        </form>
      )}
      {enabled === false && !setup && (
        <button
          onClick={async () => {
            try {
              setSetup(await controller.api.totpSetup());
              setMsg(null);
            } catch (err) {
              fail(err);
            }
          }}
        >
          Включить
        </button>
      )}
      {enabled === false && setup && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await controller.api.totpEnable(code.replace(/\s/g, ''));
              setEnabled(true);
              setSetup(null);
              setCode('');
              setMsg('Двухфакторный вход включён.');
            } catch (err) {
              fail(err);
            }
          }}
        >
          <p>Добавьте ключ в приложение-аутентификатор и введите код, который оно покажет.</p>
          <code className="recovery-key">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
          <a href={setup.uri}>Открыть в приложении-аутентификаторе</a>
          <input inputMode="numeric" autoComplete="one-time-code" placeholder="Код из приложения" value={code} onChange={(e) => setCode(e.target.value)} required aria-label="Код" />
          <button className="primary">Подтвердить</button>
        </form>
      )}
      {msg && <p className="notice">{msg}</p>}
    </section>
  );
}

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings">
      <h2>Удаление аккаунта</h2>
      <p className="muted">
        Сервер удалит аккаунт, личные задачи и все устройства. Общие проекты, где есть другие участники, перейдут к ним. Отменить удаление нельзя:
        перед ним можно выгрузить задачи в разделе «Экспорт».
      </p>
      {!open ? (
        <button className="danger" onClick={() => setOpen(true)}>
          Удалить аккаунт
        </button>
      ) : (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!confirm('Удалить аккаунт и все личные задачи навсегда?')) return;
            setBusy(true);
            setMsg(null);
            try {
              await controller.deleteAccount(password, code.replace(/\s/g, '') || undefined);
            } catch (err) {
              const c = err instanceof Error ? err.message : '';
              setMsg(
                c === 'invalid_credentials'
                  ? 'Пароль неверный.'
                  : c === 'totp_required'
                    ? 'Введите код из приложения-аутентификатора.'
                    : c === 'invalid_totp'
                      ? 'Код не подошёл.'
                      : c === 'rate_limited'
                        ? 'Слишком много попыток. Подождите несколько минут.'
                        : 'Не получилось. Нужна связь с сервером.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <input type="password" placeholder="Пароль" aria-label="Пароль для удаления" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <input inputMode="numeric" placeholder="Код TOTP, если включён" aria-label="Код TOTP" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="danger" disabled={busy}>
            Удалить навсегда
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Отмена
          </button>
        </form>
      )}
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </section>
  );
}
