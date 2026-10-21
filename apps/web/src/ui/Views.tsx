import { useEffect, useState } from 'react';
import { COLORS, FilterSyntaxError, type Priority, type ProjectTasks, type TaskNode, exportJson, exportMarkdown, fetchTodoist, importTodoist, normalizeText, runFilter, type DeviceInfo, type TaskView, type TodoistData } from '#core';
import { controller, type MorningDigest } from '../controller.ts';
import { TZ, dayHeading, plural, todayDate } from '../format.ts';
import { href, navigate, setStartHash, startHash, useAppState, useDoc } from '../hooks.ts';
import { DropContext, dropZone, type DropOnTask } from './dnd.ts';
import { QuickAdd, type QuickAddDefaults } from './QuickAdd.tsx';
import { EmptyArt, type EmptyKind } from './EmptyArt.tsx';
import { CalendarSettings, TodayEvents } from './Events.tsx';
import { LockSettings } from './Lock.tsx';
import { passkeysSupported } from '../passkey.ts';
import { passwordProof } from '#core';
import { saveProjectAsTemplate } from './History.tsx';
import { allowExactReminders, autostartEnabled, canOpenViewWindow, checkDesktopUpdate, exactRemindersAllowed, openViewWindow, platform, setAutostart } from '../platform.ts';
import { isViewWindow } from '../viewWindow.ts';
import { ShareDialog } from './Share.tsx';
import { Description } from './Description.tsx';
import { REMINDER_OPTIONS } from './TaskPanel.tsx';
import { PomodoroSettings } from './Pomodoro.tsx';
import { RecognitionSettings } from './Recognition.tsx';
import { AndroidUpdates } from './AppUpdate.tsx';
import { TaskList, TaskTree } from './Task.tsx';
import { ViewOptionsButton, groupNodes, priorityTitle, sortNodes, sortTasks, useViewOptions, type SortBy, type TaskGroup, type ViewOptions } from './ViewOptions.tsx';
import { showToast } from './toast.tsx';
import { LANG, LANG_CHOICE, LOCALE, setLang, tr, tn, type Lang } from '../i18n.ts';

interface ViewProps {
  readonly onOpen: (id: string) => void;
  readonly selectedId: string | null;
}

function AddTask({ defaults, label = tr('Добавить задачу') }: { defaults: QuickAddDefaults; label?: string }) {
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

/** Задачи по группам: заголовок группы принимает брошенную задачу, если в группу можно перенести. */
function Groups({
  groups,
  onOpen,
  selectedId,
  showProject = true,
  matched,
}: ViewProps & { groups: readonly TaskGroup[]; showProject?: boolean; matched?: ReadonlySet<string> }) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.key} className="task-group">
          {g.title && (
            <h2 {...(g.drop ? dropZone(g.drop) : {})}>
              {g.title} <span className="muted">{g.nodes.length}</span>
            </h2>
          )}
          <TaskTree nodes={g.nodes} onOpen={onOpen} selectedId={selectedId} showProject={showProject} {...(matched ? { matched } : {})} />
        </section>
      ))}
    </>
  );
}

const ids = (tasks: readonly TaskView[]): Set<string> => new Set(tasks.map((t) => t.id));

/** Список задач деревом: под задачей её подзадачи (свёрнуты, пока среди них нет задачи из этого же списка). */
function Nested({
  tasks,
  sort,
  onOpen,
  selectedId,
  showDate = true,
}: ViewProps & { tasks: readonly TaskView[]; sort: SortBy; showDate?: boolean }) {
  const doc = useDoc();
  return <TaskTree nodes={sortNodes(doc.nested(tasks), sort)} matched={ids(tasks)} onOpen={onOpen} selectedId={selectedId} showProject showDate={showDate} />;
}

/** Список с выбранной группировкой и сортировкой; без группировки — одним деревом. */
function Arranged({ tasks, opts, onOpen, selectedId }: ViewProps & { tasks: readonly TaskView[]; opts: ViewOptions }) {
  const doc = useDoc();
  if (opts.group === 'none') return <Nested tasks={tasks} sort={opts.sort} onOpen={onOpen} selectedId={selectedId} />;
  return <Groups groups={groupNodes(doc, doc.nested(tasks), opts.group, opts.sort, todayDate())} matched={ids(tasks)} onOpen={onOpen} selectedId={selectedId} />;
}

/** Заголовок «Сегодня»: дата и кольцо прогресса (выполнено сегодня из запланированного на сегодня). */
function TodayHead({ open, today, children }: { open: number; today: string; children?: React.ReactNode }) {
  const doc = useDoc();
  // Выполненные сегодня: обычные задачи и экземпляры повторов (сама повторяющаяся задача остаётся открытой).
  const done =
    doc.completedTasks().filter((t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t.completedAt!)) === today).length +
    doc.doneToday(today, TZ).length;
  const total = open + done;
  const r = 20;
  const c = 2 * Math.PI * r;
  const part = total ? (c * done) / total : 0;
  const date = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${today}T12:00:00`));
  return (
    <header className="view-head today-head">
      <div>
        <h1>{tr('Сегодня')}</h1>
        <div className="today-date">{date[0]!.toUpperCase() + date.slice(1)}</div>
      </div>
      <div className="head-tools">
      {children}
      {total > 0 && (
        <div className="ring" role="img" aria-label={tr('Выполнено {done} из {total}', { done: done, total: total })} title={tr('Выполнено {done} из {total}', { done: done, total: total })}>
          <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
            <circle cx="26" cy="26" r={r} className="ring-track" />
            {done > 0 && <circle cx="26" cy="26" r={r} className="ring-value" strokeDasharray={`${part} ${c}`} transform="rotate(-90 26 26)" />}
          </svg>
          <span>
            {done}/{total}
          </span>
        </div>
      )}
      </div>
    </header>
  );
}

/** «Сегодня» доской: колонка на каждый приоритет, перенос карточки в колонку меняет приоритет. */
function TodayBoard({ tasks, sort, today, onOpen, selectedId }: ViewProps & { tasks: readonly TaskView[]; sort: SortBy; today: string }) {
  const doc = useDoc();
  const prios: Priority[] = [1, 2, 3, 4];
  return (
    <div className="board today-board">
      {prios.map((p) => {
        const col = sortTasks(
          tasks.filter((t) => t.priority === p),
          sort,
        );
        return (
          <div key={p} className={`column prio-col prio-${p}`} data-priority={p} {...dropZone((id) => doc.task(id)?.priority !== p && doc.updateTask(id, { priority: p }))}>
            <div className="column-head">
              <span>{priorityTitle(p)}</span>
              <span className="muted">{col.length || ''}</span>
            </div>
            <div className="cards">
              <TaskList tasks={col} onOpen={onOpen} selectedId={selectedId} />
            </div>
            <AddTask defaults={{ due: { date: today }, priority: p }} label={tr('Добавить')} />
          </div>
        );
      })}
    </div>
  );
}

export function TodayView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const today = todayDate();
  const { overdue: overdueRaw, today: todaysRaw } = doc.today(today, TZ);
  const [opts, setOpts] = useViewOptions('today', { group: 'date' });
  const overdue = sortTasks(overdueRaw, opts.sort);
  const todays = sortTasks(todaysRaw, opts.sort);
  const doneRows = doc.doneToday(today, TZ);
  const board = opts.layout === 'board';
  // Выполненные сегодня повторы остаются в списке отмеченными до конца дня.
  const doneList = doneRows.length > 0 && (
    <div className="done-today">
      <TaskList tasks={doneRows} onOpen={onOpen} selectedId={selectedId} showDate={opts.group !== 'date'} />
    </div>
  );
  const head = (
    <TodayHead open={overdue.length + todays.length} today={today}>
      <ViewOptionsButton opts={opts} onChange={setOpts} {...(board ? { groups: [] } : {})} defaults={{ group: 'date' }} manualLabel={tr('По умолчанию')} />
      <div className="segmented" role="group" aria-label={tr('Вид')}>
        <button className={!board ? 'active' : ''} onClick={() => setOpts({ layout: 'list' })}>
          {tr('Список')}
        </button>
        <button className={board ? 'active' : ''} onClick={() => setOpts({ layout: 'board' })}>
          {tr('Доска')}
        </button>
      </div>
    </TodayHead>
  );
  if (board)
    return (
      <>
        {head}
        <TodayEvents date={today} />
        <TodayBoard tasks={[...overdue, ...todays]} sort={opts.sort} today={today} onOpen={onOpen} selectedId={selectedId} />
      </>
    );
  if (opts.group !== 'date')
    return (
      <>
        {head}
        <TodayEvents date={today} />
        <Groups
          groups={groupNodes(doc, doc.nested([...overdue, ...todays]), opts.group, opts.sort, today)}
          matched={ids([...overdue, ...todays])}
          onOpen={onOpen}
          selectedId={selectedId}
        />
        {doneList}
        <AddTask defaults={{ due: { date: today } }} />
        {overdue.length + todays.length === 0 && <Empty art="today">{tr('На сегодня всё. Новые задачи с датой «сегодня» появятся здесь.')}</Empty>}
      </>
    );
  // Подзадача встаёт под родителя, даже если он просрочен, а она на сегодня: один список на весь экран.
  const matched = ids([...overdue, ...todays]);
  const overdueIds = ids(overdue);
  const nodes = sortNodes(doc.nested([...overdue, ...todays]), opts.sort);
  const overdueNodes = nodes.filter((n) => overdueIds.has(n.task.id));
  const todayNodes = nodes.filter((n) => !overdueIds.has(n.task.id));
  return (
    <>
      {head}
      <TodayEvents date={today} />
      {overdue.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{tr('Просрочено')}</h2>
            <button
              className="link"
              onClick={() => {
                const changes = overdue.map((t) => ['task', t.id, 'due', { ...t.due!, date: today }] as const);
                doc.writeTasks(changes);
                showToast(tn(overdue.length, 'задача перенесена на сегодня', 'задачи перенесены на сегодня', 'задач перенесено на сегодня'), {
                  label: tr('Отменить'),
                  run: () => doc.undo(),
                });
              }}
            >
              {tr('Перенести на сегодня')}
            </button>
          </div>
          <TaskTree nodes={overdueNodes} matched={matched} onOpen={onOpen} selectedId={selectedId} showProject />
        </section>
      )}
      <section>
        {overdue.length > 0 && <h2>{dayHeading(today)}</h2>}
        <TaskTree nodes={todayNodes} matched={matched} onOpen={onOpen} selectedId={selectedId} showProject showDate={false} />
        {doneList}
        <AddTask defaults={{ due: { date: today } }} />
      </section>
      {overdue.length + todays.length === 0 && <Empty art="today">{tr('На сегодня всё. Новые задачи с датой «сегодня» появятся здесь.')}</Empty>}
    </>
  );
}

export function UpcomingView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const today = todayDate();
  const [days, setDays] = useState(14);
  const UP_SORTS = ['manual', 'priority', 'name'] as const;
  const [opts, setOpts] = useViewOptions('upcoming', {}, { groups: ['none'], sorts: UP_SORTS });
  const overdue = sortTasks(doc.today(today, TZ).overdue, opts.sort);
  // «Предстоящие» уже разложены по дням: здесь меняется только порядок внутри дня.
  const groups = doc.upcoming(today, days, TZ).map((g) => ({ date: g.date, tasks: sortTasks(g.tasks, opts.sort) }));
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
        <h1>{tr('Предстоящие')}</h1>
        <ViewOptionsButton opts={opts} onChange={setOpts} groups={[]} sorts={UP_SORTS} manualLabel={tr('По времени')} />
      </header>
      {overdue.length > 0 && (
        <section>
          <h2>{tr('Просрочено')}</h2>
          <Nested tasks={overdue} sort={opts.sort} onOpen={onOpen} selectedId={selectedId} />
        </section>
      )}
      {groups.map((g) => (
        <section key={g.date} className="day">
          <h2 {...dropZone((t) => moveTo(t, g.date))}>{dayHeading(g.date, today)}</h2>
          <Nested tasks={g.tasks} sort={opts.sort} onOpen={onOpen} selectedId={selectedId} showDate={false} />
          <AddTask defaults={{ due: { date: g.date } }} />
        </section>
      ))}
      <button className="add-row" onClick={() => setDays(days + 14)}>
        {tr('Показать ещё две недели')}
      </button>
    </DropContext.Provider>
  );
}

const PROJECT_GROUPS = ['none', 'date', 'priority', 'label'] as const;

export function ProjectView({ id, onOpen, selectedId }: ViewProps & { id: string }) {
  const doc = useDoc();
  const project = doc.project(id);
  const [renaming, setRenaming] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Открытая правка описания: проекта ('project') или раздела (его id).
  const [editingDesc, setEditingDesc] = useState<string | null>(null);
  useEffect(() => setEditingDesc(null), [id]);
  const [opts, setOpts] = useViewOptions(`project:${id}`, {}, { groups: PROJECT_GROUPS });
  if (!project || (!doc.projects().some((p) => p.project.id === id) && !project.isInbox)) {
    return <Empty>{tr('Проект не найден или удалён.')}</Empty>;
  }
  const raw = doc.projectTasks(id);
  // Сортировка идёт внутри разделов; при группировке разделы не показываются.
  const view: ProjectTasks = {
    unsectioned: sortNodes(raw.unsectioned, opts.sort),
    sections: raw.sections.map((s) => ({ section: s.section, tasks: sortNodes(s.tasks, opts.sort) })),
  };
  // Ручной порядок виден только без группировки и сортировки: тогда перетаскивание переставляет задачи.
  const custom = opts.group !== 'none' || opts.sort !== 'manual';
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
      showToast(tr('Нельзя положить задачу внутрь её самой'));
    }
  };
  const total = view.unsectioned.length + view.sections.reduce((n, s) => n + s.tasks.length, 0);

  return (
    <DropContext.Provider value={custom ? null : onDropTask}>
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
          <h1 onDoubleClick={() => !isInbox && setRenaming(true)}>{isInbox ? tr('Входящие') : project.name}</h1>
        )}
        <div className="head-tools">
          <div className="segmented" role="group" aria-label={tr('Вид')}>
          <button className={project.view !== 'board' ? 'active' : ''} onClick={() => doc.updateProject(id, { view: 'list' })}>
            {tr('Список')}
          </button>
          <button className={project.view === 'board' ? 'active' : ''} onClick={() => doc.updateProject(id, { view: 'board' })}>
            {tr('Доска')}
          </button>
          </div>
          {project.view !== 'board' && <ViewOptionsButton opts={opts} onChange={setOpts} groups={PROJECT_GROUPS} />}
        </div>
        {!isInbox && (
          <div className="head-actions">
            <select value={project.color} onChange={(e) => doc.updateProject(id, { color: e.target.value })} aria-label={tr('Цвет проекта')}>
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {!controller.getState().local && <button onClick={() => setSharing(true)}>{doc.isShared(id) ? tr('Участники') : tr('Поделиться')}</button>}
            <button onClick={() => setRenaming(true)}>{tr('Переименовать')}</button>
            <button onClick={() => setEditingDesc('project')}>{tr('Описание')}</button>
            {canOpenViewWindow() && !isViewWindow(location.search) && (
              <button onClick={() => void openViewWindow(href({ view: 'project', id }), project.name)}>{tr('В отдельном окне')}</button>
            )}
            <button onClick={() => setAddingSection(true)}>{tr('Раздел')}</button>
            <button onClick={() => saveProjectAsTemplate(doc, id)} title={tr('Сохранить проект как шаблон')}>
              {tr('Шаблон')}
            </button>
            {(!doc.isShared(id) || controller.roleIn(id) === 'owner') && (
            <button
              className="danger"
              onClick={() => {
                if (!confirm(tr('Удалить проект «{name}» вместе с задачами?', { name: project.name }))) return;
                doc.deleteProject(id);
                navigate({ view: 'inbox' });
                showToast(tr('Проект удалён'), { label: tr('Отменить'), run: () => doc.undo() });
              }}
            >
              {tr('Удалить')}
            </button>
            )}
          </div>
        )}
      </header>
      {!isInbox && (
        <Description
          className="project-desc"
          text={project.description}
          editing={editingDesc === 'project'}
          onEditing={(v) => setEditingDesc(v ? 'project' : null)}
          onSave={(v) => doc.updateProject(id, { description: v })}
        />
      )}
      {sharing && <ShareDialog projectId={id} onClose={() => setSharing(false)} />}
      {project.view === 'board' ? (
        <Board projectId={id} view={view} onOpen={onOpen} selectedId={selectedId} onAddSection={() => setAddingSection(true)} />
      ) : opts.group !== 'none' ? (
        <>
          <Groups
            groups={groupNodes(doc, [...view.unsectioned, ...view.sections.flatMap((s) => s.tasks)], opts.group, opts.sort, todayDate())}
            onOpen={onOpen}
            selectedId={selectedId}
            showProject={false}
          />
          <AddTask defaults={{ projectId: id, sectionId: null }} />
        </>
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
                const name = prompt(tr('Название раздела'), section.name);
                if (name?.trim()) doc.updateSection(section.id, { name });
              }}
            >
              {section.name} <span className="muted">{tasks.length || ''}</span>
            </h2>
            <div className="section-actions">
              <button className="link" onClick={() => setEditingDesc(section.id)}>
                {tr('Описание')}
              </button>
              <button
                className="link"
                onClick={() => {
                  doc.deleteSection(section.id);
                  showToast(tr('Раздел удалён'), { label: tr('Отменить'), run: () => doc.undo() });
                }}
              >
                {tr('Удалить раздел')}
              </button>
            </div>
          </div>
          <Description
            className="section-desc"
            text={section.description}
            editing={editingDesc === section.id}
            onEditing={(v) => setEditingDesc(v ? section.id : null)}
            onSave={(v) => doc.updateSection(section.id, { description: v })}
          />
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
          placeholder={tr('Название раздела')}
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
      {total === 0 && <Empty art={isInbox ? 'inbox' : undefined}>{isInbox ? tr('Входящие пусты. Всё, что не разобрано по проектам, попадает сюда.') : tr('В проекте пока нет задач.')}</Empty>}
    </DropContext.Provider>
  );
}

const LABEL_GROUPS = ['none', 'date', 'priority', 'project'] as const;

export function LabelView({ id, onOpen, selectedId }: ViewProps & { id: string }) {
  const doc = useDoc();
  const label = doc.label(id);
  const [opts, setOpts] = useViewOptions(`label:${id}`, {}, { groups: LABEL_GROUPS });
  if (!label || label.deletedAt !== null) return <Empty>{tr('Метка не найдена.')}</Empty>;
  const tasks = doc.openTasks().filter((t) => t.labels.includes(id));
  return (
    <>
      <header className="view-head">
        <h1>{label.name}</h1>
        <ViewOptionsButton opts={opts} onChange={setOpts} groups={LABEL_GROUPS} manualLabel={tr('По умолчанию')} />
        <div className="head-actions">
          <button
            onClick={() => {
              const name = prompt(tr('Название метки'), label.name);
              if (name?.trim()) doc.updateLabel(id, { name });
            }}
          >
            {tr('Переименовать')}
          </button>
          <button
            className="danger"
            onClick={() => {
              doc.deleteLabel(id);
              navigate({ view: 'today' });
            }}
          >
            {tr('Удалить')}
          </button>
        </div>
      </header>
      <Arranged tasks={tasks} opts={opts} onOpen={onOpen} selectedId={selectedId} />
      {tasks.length === 0 && <Empty>{tr('Задач с этой меткой нет.')}</Empty>}
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
        <h1>{tr('Поиск:')} {q}</h1>
        <label className="checkline">
          <input type="checkbox" checked={withDone} onChange={(e) => setWithDone(e.target.checked)} /> {tr('с выполненными')}
        </label>
      </header>
      <TaskList tasks={results} onOpen={onOpen} selectedId={selectedId} />
      {normalizeText(q) && results.length === 0 && <Empty art="search">{tr('Ничего не найдено.')}</Empty>}
    </>
  );
}

export function CompletedView({ onOpen, selectedId }: ViewProps) {
  const doc = useDoc();
  const tasks: TaskView[] = doc.completedTasks().slice(0, 300);
  return (
    <>
      <header className="view-head">
        <h1>{tr('Выполненные')}</h1>
      </header>
      <TaskList tasks={tasks} onOpen={onOpen} selectedId={selectedId} />
      {tasks.length === 0 && <Empty art="done">{tr('Здесь будут выполненные задачи.')}</Empty>}
    </>
  );
}

export function TrashView() {
  const doc = useDoc();
  const tasks = doc.trash().slice(0, 300);
  return (
    <>
      <header className="view-head">
        <h1>{tr('Корзина')}</h1>
        {tasks.length > 0 && (
          <button
            onClick={() => {
              if (confirm(tr('Удалить навсегда {n}? Отменить это нельзя.', { n: tn(doc.trash().length, 'задачу', 'задачи', 'задач') }))) {
                const r = doc.emptyTrash();
                for (const f of r.files) void controller.api.deleteFile(f.spaceId, f.file.id).catch(() => undefined);
                showToast(tr('Удалено навсегда: {count}', { count: r.count }));
              }
            }}
          >
            {tr('Очистить корзину')}
          </button>
        )}
      </header>
      {tasks.map((t) => (
        <div key={t.id} className="trash-row">
          <span>{t.title}</span>
          <button onClick={() => doc.restoreTask(t.id)}>{tr('Восстановить')}</button>
          <button
            className="danger"
            onClick={() => {
              if (!confirm(tr('Удалить «{title}» навсегда? Отменить это нельзя.', { title: t.title }))) return;
              for (const f of doc.purgeTask(t.id)) void controller.api.deleteFile(f.spaceId, f.file.id).catch(() => undefined);
            }}
          >
            {tr('Удалить навсегда')}
          </button>
        </div>
      ))}
      {tasks.length === 0 && <Empty>{tr('Корзина пуста.')}</Empty>}
    </>
  );
}

const THEMES = [
  ['system', tr('Как в системе')],
  ['light', tr('Светлая')],
  ['dark', tr('Тёмная')],
] as const;

export function applyTheme(theme: string): void {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function ThemeSettings() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  return (
    <section className="settings">
      <h2>{tr('Тема')}</h2>
      <div className="row">
        {THEMES.map(([value, label]) => (
          <button
            key={value}
            className={theme === value ? 'active' : ''}
            onClick={() => {
              setTheme(value);
              try {
                localStorage.setItem('theme', value);
              } catch {
                // нет доступа к хранилищу
              }
              applyTheme(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <h2>{tr('Язык')}</h2>
      <div className="row">
        {LANGS.map(([value, label]) => (
          <button key={value ?? 'system'} className={LANG_CHOICE === value ? 'active' : ''} onClick={() => value !== LANG_CHOICE && setLang(value)}>
            {label}
          </button>
        ))}
      </div>
      <StartViewSetting />
    </section>
  );
}

function StartViewSetting() {
  const doc = useDoc();
  const [value, setValue] = useState(() => startHash() ?? '#/today');
  const options: Array<readonly [string, string]> = [
    ['#/today', tr('Сегодня')],
    ['#/inbox', tr('Входящие')],
    ['#/upcoming', tr('Предстоящие')],
    ['#/calendar', tr('Календарь')],
    ...doc.projects().filter((p) => !p.project.isInbox).map((p) => [`#/project/${encodeURIComponent(p.project.id)}`, `# ${p.project.name}`] as const),
    ...doc.filters().map((f) => [`#/filter/${encodeURIComponent(f.id)}`, `${tr('Фильтр')}: ${f.name}`] as const),
  ];
  // Удалённый проект или фильтр в списке не найдётся: тогда показывается «Сегодня».
  const current = options.some(([v]) => v === value) ? value : '#/today';
  return (
    <>
      <h2>{tr('Экран при запуске')}</h2>
      <select
        aria-label={tr('Экран при запуске')}
        value={current}
        onChange={(e) => {
          setValue(e.target.value);
          setStartHash(e.target.value === '#/today' ? null : e.target.value);
        }}
      >
        {options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </>
  );
}

/** Названия языков пишутся на самих языках, чтобы их нашёл тот, кто не читает текущий. */
const LANGS: ReadonlyArray<readonly [Lang | null, string]> = [
  [null, tr('Как в системе')],
  ['ru', 'Русский'],
  ['en', 'English'],
];

export function SettingsView() {
  const { email, isAdmin, status, local } = useAppState();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  useEffect(() => {
    if (local) return;
    controller.api
      .devices()
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  }, []);

  if (local) {
    return (
      <>
        <header className="view-head">
          <h1>{tr('Настройки')}</h1>
        </header>
        <section className="settings">
          <h2>{tr('Без сервера')}</h2>
          <p className="muted">
            {tr('Задачи зашифрованы и хранятся только в этом браузере, на другие устройства они не попадают. Чтобы синхронизировать телефон и компьютер, поставьте сервер Dela и перенесите задачи через экспорт в JSON и импорт.')}
          </p>
          <a className="button-link" href="https://github.com/olerast67/dela#install-the-server" target="_blank" rel="noopener noreferrer">
            {tr('Как поставить сервер')}
          </a>
          <button className="danger" onClick={() => confirm(tr('Выйти? Все задачи из этого браузера удалятся.')) && controller.logout()}>
            {tr('Удалить данные и выйти')}
          </button>
        </section>
        <ThemeSettings />
        <CalendarSettings />
        <PomodoroSettings />
        <LockSettings />
        <RecognitionSettings />
        <ImportExport />
      </>
    );
  }

  return (
    <>
      <header className="view-head">
        <h1>{tr('Настройки')}</h1>
      </header>
      <section className="settings">
        <h2>{tr('Аккаунт')}</h2>
        <p>{email}</p>
        <p className="muted">
          {status.lastSyncedAt ? tr('Последняя синхронизация: {n}', { n: new Date(status.lastSyncedAt).toLocaleTimeString(LOCALE) }) : tr('Ещё не синхронизировано')}
        </p>
        <button className="danger" onClick={() => confirm(tr('Выйти? Неотправленные изменения на этом устройстве будут потеряны.')) && controller.logout()}>
          {tr('Выйти')}
        </button>
      </section>
      <ThemeSettings />
      <SignKeyNotice />
      <section className="settings">
        <h2>{tr('Устройства')}</h2>
        {devices === null && <p className="muted">{tr('Загрузка…')}</p>}
        {devices?.map((d) => (
          <div key={d.id} className="trash-row">
            <span>
              {d.name} {d.current && <span className="muted">{tr('· это устройство')}</span>}
              <br />
              <span className="muted">{tr('Активность:')} {new Date(d.lastSeenAt).toLocaleString(LOCALE)}</span>
            </span>
            {!d.current && (
              <button
                onClick={async () => {
                  await controller.api.revokeDevice(d.id);
                  setDevices(devices.filter((x) => x.id !== d.id));
                }}
              >
                {tr('Отключить')}
              </button>
            )}
          </div>
        ))}
      </section>
      <ReminderSettings />
      <CalendarSettings />
      <PomodoroSettings />
      <ChangePassword />
      <TwoFactor />
      <Passkeys />
      <LockSettings />
      <RecognitionSettings />
      <DesktopAutostart />
      <DesktopUpdates />
      <AndroidUpdates />
      <DeleteAccount />
      <ImportExport />
      {isAdmin && (
        <section className="settings">
          <h2>{tr('Приглашения')}</h2>
          <p className="muted">{tr('Регистрация на сервере закрыта. Приглашение действует 7 дней и подходит одному человеку.')}</p>
          <button
            onClick={async () => {
              const r = await controller.api.createInvite();
              setInvite(r.code);
            }}
          >
            {tr('Создать приглашение')}
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
    const s = importTodoist(doc.personal, data, { lang: LANG });
    const parts = [
      tn(s.tasks, 'задача', 'задачи', 'задач'),
      tn(s.projects, 'проект', 'проекта', 'проектов'),
      tn(s.labels, 'метка', 'метки', 'меток'),
      tn(s.filters, 'фильтр', 'фильтра', 'фильтров'),
    ];
    const warn = s.unparsedRecurrences.length
      ? tr(' Не распознаны повторы: {n}. Их текст сохранён в описании задач.', { n: s.unparsedRecurrences.join('; ') })
      : '';
    setResult(tr('Перенесено: {n}.{warn}', { n: parts.join(', '), warn: warn }));
  }

  const confirmImport = () => confirm(tr('Импорт добавит задачи к уже существующим. Повторный импорт создаст копии. Продолжить?'));

  return (
    <section className="settings">
      <h2>{tr('Импорт из Todoist')}</h2>
      <p className="muted">
        {tr('Токен: Todoist → Настройки → Интеграции → Для разработчиков. Запрос идёт из браузера напрямую в Todoist, сервер Dela токен не видит.')}
      </p>
      <div className="row wrap">
        <input type="password" placeholder={tr('Токен API Todoist')} value={token} onChange={(e) => setToken(e.target.value)} aria-label={tr('Токен Todoist')} />
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
              if (err instanceof Error && err.message === 'todoist_unauthorized') setResult(tr('Todoist не принял токен.'));
              else {
                setResult(tr('Браузер не смог обратиться к Todoist. Загрузите данные файлом.'));
                setFallback(true);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? tr('Загрузка…') : tr('Импортировать')}
        </button>
      </div>
      {fallback && (
        <p className="muted">
          {tr('Выполните в терминале и загрузите получившийся файл:')}
          <code className="recovery-key">
            {tr('curl https://api.todoist.com/api/v1/sync -H "Authorization: Bearer ТОКЕН" -d sync_token=* -d \'resource_types=["all"]\' -o todoist.json')}
          </code>
        </p>
      )}
      <label className="row">
        <span className="muted">{tr('или файл JSON:')}</span>
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
              setResult(tr('Файл не похож на выгрузку Todoist.'));
            }
          }}
        />
      </label>
      {result && <p className="notice">{result}</p>}

      <h2>{tr('Экспорт')}</h2>
      <p className="muted">{tr('Выгрузка собирается на этом устройстве из расшифрованных данных.')}</p>
      <div className="row">
        <button onClick={() => download(`dela-${todayDate()}.json`, JSON.stringify({ ...exportJson(doc.personal), shared: doc.docs().filter((d) => d.kind === 'shared').map((d) => exportJson(d)) }, null, 2), 'application/json')}>JSON</button>
        <button onClick={() => download(`dela-${todayDate()}.md`, doc.docs().map((d) => exportMarkdown(d, tr('Входящие'), tr('привычка'))).join(String.fromCharCode(10)), 'text/markdown')}>Markdown</button>
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
      <h2>{tr('Пароль')}</h2>
      <p className="muted">{tr('При смене пароля данные не перешифровываются, меняется только обёртка ключа. Другие устройства войдут заново.')}</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          if (next.length < 10) return setMsg(tr('Новый пароль должен быть не короче 10 символов.'));
          if (next !== repeat) return setMsg(tr('Пароли не совпадают.'));
          setBusy(true);
          await new Promise((r) => setTimeout(r, 30));
          try {
            await controller.changePassword(current, next);
            setMsg(tr('Пароль изменён.'));
            setCurrent('');
            setNext('');
            setRepeat('');
          } catch (err) {
            setMsg(err instanceof Error && err.name === 'DecryptError' ? tr('Текущий пароль неверный.') : tr('Не удалось изменить пароль.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input type="password" autoComplete="current-password" placeholder={tr('Текущий пароль')} value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder={tr('Новый пароль')} value={next} onChange={(e) => setNext(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder={tr('Новый пароль ещё раз')} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        <button disabled={busy}>{busy ? tr('Подождите…') : tr('Сменить пароль')}</button>
      </form>
      {msg && <p className="notice">{msg}</p>}
    </section>
  );
}

const FILTER_EXAMPLES = [tr('сегодня | просрочено'), '(today | overdue) & p1', tr('#Работа & !@ждёт'), tr('следующие 7 дней'), tr('без даты & !подзадачи'), tr('поиск: молоко')];

export function FilterView({ id, onOpen, selectedId }: ViewProps & { id: string }) {
  const doc = useDoc();
  const existing = id === 'new' ? undefined : doc.filters().find((f) => f.id === id);
  const [editing, setEditing] = useState(id === 'new');
  const [name, setName] = useState(existing?.name ?? '');
  const [query, setQuery] = useState(existing?.query ?? '');
  const [opts, setOpts] = useViewOptions(`filter:${id}`);
  useEffect(() => {
    setEditing(id === 'new');
    setName(existing?.name ?? '');
    setQuery(existing?.query ?? '');
  }, [id]);

  if (id !== 'new' && !existing) return <Empty>{tr('Фильтр не найден.')}</Empty>;
  const q = editing ? query : existing!.query;
  let result: { tasks: TaskView[]; unknown: string[] } | null = null;
  let error: string | null = null;
  if (q.trim()) {
    try {
      result = runFilter(doc, q, todayDate(), TZ);
    } catch (err) {
      error = err instanceof FilterSyntaxError ? filterError(err.message) : tr('ошибка в запросе');
    }
  }

  return (
    <>
      <header className="view-head">
        <h1>{editing ? (id === 'new' ? tr('Новый фильтр') : tr('Фильтр')) : existing!.name}</h1>
        {!editing && <ViewOptionsButton opts={opts} onChange={setOpts} manualLabel={tr('По умолчанию')} />}
        {!editing && (
          <div className="head-actions">
            <button onClick={() => setEditing(true)}>{tr('Изменить')}</button>
            <button
              className="danger"
              onClick={() => {
                doc.deleteFilter(id);
                navigate({ view: 'today' });
                showToast(tr('Фильтр удалён'), { label: tr('Отменить'), run: () => doc.undo() });
              }}
            >
              {tr('Удалить')}
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
          <input placeholder={tr('Название')} value={name} onChange={(e) => setName(e.target.value)} autoFocus required aria-label={tr('Название фильтра')} />
          <input placeholder={tr('Запрос, например: сегодня | просрочено')} value={query} onChange={(e) => setQuery(e.target.value)} required aria-label={tr('Запрос')} />
          <div className="chips">
            {FILTER_EXAMPLES.map((ex) => (
              <button type="button" key={ex} className="chip" onClick={() => setQuery(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div className="row">
            <button className="primary" disabled={!name.trim() || !query.trim() || !!error}>
              {tr('Сохранить')}
            </button>
            {id !== 'new' && (
              <button type="button" onClick={() => setEditing(false)}>
                {tr('Отмена')}
              </button>
            )}
          </div>
        </form>
      )}
      {!editing && <p className="muted mono">{existing!.query}</p>}
      {error && <p className="error">{tr('Ошибка в запросе:')} {error}</p>}
      {result && result.unknown.length > 0 && <p className="notice">{tr('Не понял:')} {result.unknown.map((u) => `«${u}»`).join(', ')}</p>}
      {result && <Arranged tasks={result.tasks} opts={opts} onOpen={onOpen} selectedId={selectedId} />}
      {result && result.tasks.length === 0 && !error && <Empty>{tr('Под фильтр ничего не попадает.')}</Empty>}
    </>
  );
}

export function ReminderSettings() {
  const [permission, setPermission] = useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const [defaults, setDefaults] = useState(() => controller.reminderDefaults());
  const [digest, setDigest] = useState(() => controller.morningDigest());
  const changeDigest = (next: MorningDigest) => {
    setDigest(next);
    controller.setMorningDigest(next);
  };
  const [push, setPush] = useState(() => controller.pushEnabled());
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [exact, setExact] = useState<boolean | null>(null);
  useEffect(() => {
    const check = () => void exactRemindersAllowed().then(setExact, () => setExact(null));
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);
  return (
    <section className="settings">
      <h2>{tr('Напоминания')}</h2>
      <p className="muted">
        {tr('Задачам со временем Dela напоминает по умолчанию так, как выбрано ниже. У отдельной задачи это можно изменить в её карточке.')}{' '}
        {platform() !== 'capacitor'
          ? tr('Пока приложение закрыто, напоминания приходят через push: сервер знает только время отправки, текст зашифрован ключом этого устройства.')
          : tr('Задачи, которые уже есть на телефоне, напоминают о себе и без интернета. Push нужен для задач, добавленных на другом устройстве, пока Dela на телефоне закрыта: сервер знает только время отправки, текст зашифрован ключом этого телефона.')}
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
                else
                  setPushMsg(
                    r === 'no_distributor'
                      ? tr('Нужно приложение-распространитель UnifiedPush, например ntfy из F-Droid или Google Play. Поставьте его и включите снова.')
                      : r === 'denied'
                        ? tr('Уведомления запрещены в браузере.')
                        : tr('Этот браузер не поддерживает push-уведомления.'),
                  );
                setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
              } else {
                await controller.disablePush();
                setPush(false);
              }
            } catch {
              setPushMsg(tr('Не удалось включить push. Проверьте, что сервер открыт по HTTPS.'));
            }
          }}
        />
        {platform() === 'capacitor' ? tr('Push для задач с других устройств') : tr('Напоминать, когда приложение закрыто')}
      </label>
      {pushMsg && <p className="notice">{pushMsg}</p>}
      {exact === false && (
        <div className="notice">
          <p>{tr('Android сейчас может сдвинуть напоминание на несколько минут. Чтобы оно приходило точно в срок, разрешите Dela будильники и напоминания.')}</p>
          <button
            onClick={async () => {
              setExact(await allowExactReminders().catch(() => false));
              controller.scheduleReminders();
            }}
          >
            {tr('Разрешить точное время')}
          </button>
        </div>
      )}
      {permission === 'default' && (
        <button className="primary" onClick={async () => setPermission(await Notification.requestPermission())}>
          {tr('Разрешить уведомления')}
        </button>
      )}
      {permission === 'denied' && <p className="notice">{tr('Уведомления запрещены в настройках браузера. Напоминания будут видны только внутри приложения.')}</p>}
      {permission === 'unsupported' && platform() !== 'capacitor' && <p className="notice">{tr('Этот браузер не умеет показывать уведомления.')}</p>}
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
      <div className="row wrap" style={{ marginTop: 14 }}>
        <label className="checkline">
          <input type="checkbox" checked={digest.on} onChange={(e) => changeDigest({ ...digest, on: e.target.checked })} />
          {tr('Утренняя сводка')}
        </label>
        <input
          type="time"
          value={digest.time}
          disabled={!digest.on}
          onChange={(e) => e.target.value && changeDigest({ ...digest, time: e.target.value })}
          aria-label={tr('Время утренней сводки')}
        />
      </div>
      <p className="muted">
        {tr('Одно уведомление в день: сколько задач на сегодня и сколько просрочено. Считается на этом устройстве; в дни без задач уведомления нет.')}
      </p>
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
    { id: null, name: tr('Без раздела'), tasks: view.unsectioned },
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
          <AddTask defaults={{ projectId, sectionId: col.id }} label={tr('Добавить')} />
        </div>
      ))}
      <button className="column add-column" onClick={onAddSection}>
        {tr('+ Раздел')}
      </button>
    </div>
  );
}

export function TwoFactor() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [totpPassword, setTotpPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [recoveryWant, setRecoveryWant] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');

  useEffect(() => {
    controller.api
      .account()
      .then((a) => {
        setEnabled(a.totpEnabled);
        setRecovery(a.recoveryTotp === true);
        setRecoveryWant(a.recoveryTotp === true);
      })
      .catch(() => setEnabled(null));
  }, []);

  const fail = (err: unknown) =>
    setMsg(err instanceof Error && err.message === 'invalid_totp' ? tr('Код не подошёл. Введите новый код из приложения.') : tr('Не получилось. Нужна связь с сервером.'));

  return (
    <section className="settings">
      <h2>{tr('Двухфакторный вход')}</h2>
      <p className="muted">
        {tr('При входе на новом устройстве кроме пароля понадобится код из приложения-аутентификатора (Aegis, Google Authenticator, 2FAS). Вход по ключу восстановления кода не требует, если не включить это ниже.')}
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
              setMsg(tr('Двухфакторный вход отключён.'));
            } catch (err) {
              fail(err);
            }
          }}
        >
          <span>{tr('Включён.')}</span>
          <input inputMode="numeric" placeholder={tr('Код для отключения')} value={code} onChange={(e) => setCode(e.target.value)} required aria-label={tr('Код')} />
          <button>{tr('Отключить')}</button>
        </form>
      )}
      {enabled === true && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const authSecret = await passwordProof(controller.api, recoveryPassword);
              await controller.api.setRecoveryTotp({ enabled: recoveryWant, authSecret, totp: recoveryCode.replace(/\s/g, '') });
              setRecovery(recoveryWant);
              setRecoveryPassword('');
              setRecoveryCode('');
              setMsg(recoveryWant ? tr('Теперь ключ восстановления тоже спрашивает код.') : tr('Ключ восстановления больше не спрашивает код.'));
            } catch (err) {
              if (err instanceof Error && err.message === 'invalid_credentials') setMsg(tr('Пароль неверный.'));
              else fail(err);
            }
          }}
        >
          <label className="checkline">
            <input type="checkbox" checked={recoveryWant} onChange={(e) => setRecoveryWant(e.target.checked)} />
            {tr('Спрашивать код и при входе по ключу восстановления')}
          </label>
          <p className="muted">{tr('Тогда без телефона с приложением-аутентификатором ключ восстановления аккаунт не откроет. Сохраните резервные коды в самом приложении-аутентификаторе.')}</p>
          {recoveryWant !== recovery && (
            <div className="row wrap">
              <input type="password" placeholder={tr('Пароль')} aria-label={tr('Пароль')} autoComplete="current-password" value={recoveryPassword} onChange={(e) => setRecoveryPassword(e.target.value)} required />
              <input inputMode="numeric" placeholder={tr('Код из приложения')} aria-label={tr('Код из приложения')} value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} required />
              <button>{tr('Сохранить')}</button>
            </div>
          )}
        </form>
      )}
      {enabled === false && !setup && (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setSetup(await controller.api.totpSetup(await passwordProof(controller.api, totpPassword)));
              setTotpPassword('');
              setMsg(null);
            } catch (err) {
              setMsg(err instanceof Error && err.message === 'invalid_credentials' ? tr('Пароль неверный.') : tr('Не получилось. Нужна связь с сервером.'));
            }
          }}
        >
          <input type="password" placeholder={tr('Пароль')} aria-label={tr('Пароль для TOTP')} autoComplete="current-password" value={totpPassword} onChange={(e) => setTotpPassword(e.target.value)} required />
          <button>{tr('Включить')}</button>
        </form>
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
              setMsg(tr('Двухфакторный вход включён.'));
            } catch (err) {
              fail(err);
            }
          }}
        >
          <p>{tr('Добавьте ключ в приложение-аутентификатор и введите код, который оно покажет.')}</p>
          <code className="recovery-key">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
          <a href={setup.uri}>{tr('Открыть в приложении-аутентификаторе')}</a>
          <input inputMode="numeric" autoComplete="one-time-code" placeholder={tr('Код из приложения')} value={code} onChange={(e) => setCode(e.target.value)} required aria-label={tr('Код')} />
          <button className="primary">{tr('Подтвердить')}</button>
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
      <h2>{tr('Удаление аккаунта')}</h2>
      <p className="muted">
        {tr('Сервер удалит аккаунт, личные задачи и все устройства. Общие проекты, где есть другие участники, перейдут к ним. Отменить удаление нельзя: перед ним можно выгрузить задачи в разделе «Экспорт».')}
      </p>
      {!open ? (
        <button className="danger" onClick={() => setOpen(true)}>
          {tr('Удалить аккаунт')}
        </button>
      ) : (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!confirm(tr('Удалить аккаунт и все личные задачи навсегда?'))) return;
            setBusy(true);
            setMsg(null);
            try {
              await controller.deleteAccount(password, code.replace(/\s/g, '') || undefined);
            } catch (err) {
              const c = err instanceof Error ? err.message : '';
              setMsg(
                c === 'invalid_credentials'
                  ? tr('Пароль неверный.')
                  : c === 'totp_required'
                    ? tr('Введите код из приложения-аутентификатора.')
                    : c === 'invalid_totp'
                      ? tr('Код не подошёл.')
                      : c === 'rate_limited'
                        ? tr('Слишком много попыток. Подождите несколько минут.')
                        : tr('Не получилось. Нужна связь с сервером.'),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <input type="password" placeholder={tr('Пароль')} aria-label={tr('Пароль для удаления')} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <input inputMode="numeric" placeholder={tr('Код TOTP, если включён')} aria-label={tr('Код TOTP')} value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="danger" disabled={busy}>
            {tr('Удалить навсегда')}
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            {tr('Отмена')}
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

/** Программа для Windows: запуск при входе в систему, свёрнутой в трей. В браузере и на телефоне раздела нет. */
export function DesktopAutostart() {
  const [on, setOn] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void autostartEnabled()
      .then(setOn)
      .catch(() => setOn(false));
  }, []);
  if (platform() !== 'tauri') return null;
  return (
    <section className="settings">
      <h2>{tr('Запуск')}</h2>
      <label className="checkline">
        <input
          type="checkbox"
          checked={on === true}
          disabled={on === null}
          onChange={async (e) => {
            const want = e.target.checked;
            setMsg(null);
            try {
              await setAutostart(want);
              setOn(want);
            } catch {
              setMsg(tr('Не удалось изменить запуск при входе в Windows.'));
            }
          }}
        />
        {tr('Запускать при входе в Windows')}
      </label>
      <p className="muted">{tr('Dela запускается свёрнутой в трей, и напоминания приходят без открытого окна.')}</p>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </section>
  );
}

/** Программа для Windows: версия и проверка обновлений. В браузере и на телефоне раздела нет. */
export function DesktopUpdates() {
  const [version, setVersion] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (platform() !== 'tauri') return;
    void import('@tauri-apps/api/app').then(({ getVersion }) => getVersion().then(setVersion));
  }, []);
  if (platform() !== 'tauri') return null;
  return (
    <section className="settings">
      <h2>{tr('Обновления')}</h2>
      <p className="muted">{tr('Установлена версия {version}. Программа проверяет новую версию при запуске; обновление подписано ключом проекта.', { version: version ?? '...' })}</p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const u = await checkDesktopUpdate();
            if (!u) setMsg(tr('Установлена последняя версия.'));
            else {
              setMsg(tr('Скачиваю версию {version}...', { version: u.version }));
              await u.install();
            }
          } catch {
            setMsg(tr('Не удалось проверить обновления. Нужна связь с GitHub.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr('Проверить обновления')}
      </button>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

/** Passkey: вход без пароля в браузере на домене сервера. */
export function Passkeys() {
  const [list, setList] = useState<Array<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }> | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    controller.api
      .passkeys()
      .then((r) => setList(r.passkeys))
      .catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);
  if (!passkeysSupported()) return null;
  return (
    <section className="settings">
      <h2>{tr('Вход по passkey')}</h2>
      <p className="muted">
        {tr('Вход отпечатком, лицом или Windows Hello без пароля. Ключ шифрования открывает секрет PRF самого passkey, сервер его не видит. Работает в браузере на адресе этого сервера.')}
      </p>
      {list?.map((p) => (
        <div key={p.id} className="trash-row">
          <span>
            {p.name}
            <br />
            <span className="muted">
              {tr('Добавлен')} {new Date(p.createdAt).toLocaleDateString(LOCALE)}
              {p.lastUsedAt ? tr(', вход {n}', { n: new Date(p.lastUsedAt).toLocaleDateString(LOCALE) }) : ''}
            </span>
          </span>
          <button
            onClick={async () => {
              if (!confirm(tr('Удалить passkey «{name}»?', { name: p.name }))) return;
              await controller.api.deletePasskey(p.id);
              void load();
            }}
          >
            {tr('Удалить')}
          </button>
        </div>
      ))}
      <input type="password" placeholder={tr('Пароль')} aria-label={tr('Пароль для passkey')} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <input inputMode="numeric" placeholder={tr('Код TOTP, если включён')} aria-label={tr('Код TOTP для passkey')} value={code} onChange={(e) => setCode(e.target.value)} />
      <button
        disabled={busy || !password}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            await controller.addPasskey(
              navigator.userAgent.includes('Windows') ? 'Windows' : navigator.userAgent.includes('Android') ? 'Android' : 'Passkey',
              password,
              code.replace(/\s/g, '') || undefined,
            );
            setPassword('');
            setCode('');
            setMsg(tr('Passkey добавлен. Теперь на экране входа можно нажать «Войти по passkey».'));
            void load();
          } catch (err) {
            const code = err instanceof Error ? err.message : '';
            setMsg(
              code === 'invalid_credentials'
                ? tr('Пароль неверный.')
                : code === 'totp_required' || code === 'invalid_totp'
                  ? tr('Нужен верный код из приложения-аутентификатора.')
                  : code === 'prf_unsupported'
                ? tr('Этот passkey не умеет PRF. Подойдут Google Password Manager, iCloud Keychain, Windows Hello на Windows 11 и ключи FIDO2.')
                : code === 'passkeys_disabled'
                  ? tr('На сервере не задан DELA_PUBLIC_URL, поэтому passkey выключены.')
                  : err instanceof Error && err.name === 'NotAllowedError'
                    ? tr('Добавление отменено.')
                    : tr('Не получилось добавить passkey.'),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr('Добавить passkey')}
      </button>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

/** Сообщение разбора фильтра из core на языке интерфейса. */
function filterError(message: string): string {
  const m = /^Лишнее: «(.*)»$/.exec(message);
  return m ? tr('Лишнее: «{n}»', { n: m[1]! }) : tr(message);
}

/** На сервере стоит чужой ключ подписи: комментарии этого пользователя у других не пройдут проверку. */
export function SignKeyNotice() {
  useDoc();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!controller.signKeyMismatch) return null;
  return (
    <section className="settings">
      <h2>{tr('Ключ подписи')}</h2>
      <p className="notice">
        {controller.signKeyMismatch === 'other'
          ? tr('На сервере для вашего аккаунта стоит другой ключ подписи комментариев. Его могли поставить по украденной сессии. Пока он стоит, другие участники видят ваши новые комментарии как неподписанные вами.')
          : tr('Комментарии теперь подписываются. Чтобы участники общих проектов могли проверить вашу подпись, подтвердите пароль один раз.')}
      </p>
      <form
        className="row wrap"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await controller.fixSignKey(password, code.replace(/\s/g, '') || undefined);
            setMsg(tr('Ключ подписи восстановлен. Смените пароль, если не ставили ключ сами.'));
          } catch (err) {
            setMsg(err instanceof Error && err.message === 'invalid_credentials' ? tr('Пароль неверный.') : tr('Не получилось. Нужна связь с сервером.'));
          }
        }}
      >
        <input type="password" placeholder={tr('Пароль')} aria-label={tr('Пароль')} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <input inputMode="numeric" placeholder={tr('Код TOTP, если включён')} aria-label={tr('Код TOTP')} value={code} onChange={(e) => setCode(e.target.value)} />
        <button>{tr('Вернуть свой ключ')}</button>
      </form>
      {msg && <p className="notice">{msg}</p>}
    </section>
  );
}
