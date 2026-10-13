import { useEffect, useState } from 'react';
import { COLORS, normalizeText, type DeviceInfo, type TaskView } from '#core';
import { controller } from '../controller.ts';
import { TZ, dayHeading, plural, todayDate } from '../format.ts';
import { navigate, useAppState, useDoc } from '../hooks.ts';
import { QuickAdd, type QuickAddDefaults } from './QuickAdd.tsx';
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

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function TodayView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const today = todayDate();
  const { overdue, today: todays } = doc.today(today, TZ);
  return (
    <>
      <header className="view-head">
        <h1>Сегодня</h1>
        <span className="muted">{plural(overdue.length + todays.length, 'задача', 'задачи', 'задач')}</span>
      </header>
      {overdue.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Просрочено</h2>
            <button
              className="link"
              onClick={() => {
                const changes = overdue.map((t) => ['task', t.id, 'due', { ...t.due!, date: today }] as const);
                doc.write(changes);
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
      {overdue.length + todays.length === 0 && <Empty>На сегодня всё. Новые задачи с датой «сегодня» появятся здесь.</Empty>}
    </>
  );
}

export function UpcomingView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const today = todayDate();
  const [days, setDays] = useState(14);
  const overdue = doc.today(today, TZ).overdue;
  const groups = doc.upcoming(today, days, TZ);
  return (
    <>
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
          <h2>{dayHeading(g.date, today)}</h2>
          <TaskList tasks={g.tasks} onOpen={onOpen} selectedId={selectedId} showDate={false} />
          <AddTask defaults={{ due: { date: g.date } }} />
        </section>
      ))}
      <button className="add-row" onClick={() => setDays(days + 14)}>
        Показать ещё две недели
      </button>
    </>
  );
}

export function ProjectView({ id, onOpen, selectedId }: ViewProps & { id: string }) {
  const doc = useDoc();
  const project = doc.project(id);
  const [renaming, setRenaming] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  if (!project || (!doc.projects().some((p) => p.project.id === id) && !project.isInbox)) {
    return <Empty>Проект не найден или удалён.</Empty>;
  }
  const view = doc.projectTasks(id);
  const isInbox = project.isInbox;
  const total = view.unsectioned.length + view.sections.reduce((n, s) => n + s.tasks.length, 0);

  return (
    <>
      <header className="view-head">
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
        {!isInbox && (
          <div className="head-actions">
            <select value={project.color} onChange={(e) => doc.updateProject(id, { color: e.target.value })} aria-label="Цвет проекта">
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button onClick={() => setRenaming(true)}>Переименовать</button>
            <button onClick={() => setAddingSection(true)}>Раздел</button>
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
          </div>
        )}
      </header>
      <section>
        <TaskTree nodes={view.unsectioned} onOpen={onOpen} selectedId={selectedId} />
        <AddTask defaults={{ projectId: id, sectionId: null }} />
      </section>
      {view.sections.map(({ section, tasks }) => (
        <section key={section.id}>
          <div className="section-head">
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
      {total === 0 && <Empty>{isInbox ? 'Входящие пусты. Всё, что не разобрано по проектам, попадает сюда.' : 'В проекте пока нет задач.'}</Empty>}
    </>
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
        <label className="check">
          <input type="checkbox" checked={withDone} onChange={(e) => setWithDone(e.target.checked)} /> с выполненными
        </label>
      </header>
      <TaskList tasks={results} onOpen={onOpen} selectedId={selectedId} />
      {normalizeText(q) && results.length === 0 && <Empty>Ничего не найдено.</Empty>}
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
      {tasks.length === 0 && <Empty>Здесь будут выполненные задачи.</Empty>}
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
      </header>
      {tasks.map((t) => (
        <div key={t.id} className="trash-row">
          <span>{t.title}</span>
          <button onClick={() => doc.restoreTask(t.id)}>Восстановить</button>
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
