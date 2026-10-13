import { useState } from 'react';
import { useAppState, useDoc, href, navigate, type Route } from '../hooks.ts';
import { TZ, todayDate } from '../format.ts';
import { dropZone } from './dnd.ts';
import { IconDone, IconFilter, IconUsers, IconInbox, IconPlus, IconSearch, IconSettings, IconTag, IconToday, IconTrash, IconUpcoming } from './icons.tsx';

function same(a: Route, b: Route): boolean {
  return href(a) === href(b);
}

function SyncBadge() {
  const { status } = useAppState();
  const text =
    status.state === 'syncing'
      ? 'Синхронизация…'
      : status.state === 'offline'
        ? 'Нет сети: изменения сохранены на устройстве'
        : status.state === 'error'
          ? 'Ошибка синхронизации'
          : status.pending > 0
            ? 'Есть неотправленные изменения'
            : 'Всё сохранено';
  return (
    <span className={`sync sync-${status.state}`} title={status.error ?? text}>
      <span className="dot" /> {text}
    </span>
  );
}

export function Sidebar({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const doc = useDoc();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState(route.view === 'search' ? route.q : '');
  const today = todayDate();
  const t = doc.today(today, TZ);
  const counts = {
    inbox: doc.projectTasks(doc.inboxId).unsectioned.length,
    today: t.today.length + t.overdue.length,
  };
  const open = doc.openTasks();
  const countIn = (projectId: string) => open.filter((x) => x.projectId === projectId && x.parentId === null).length;

  /** Что значит бросить задачу на пункт меню. */
  const dropFor = (r: Route) => {
    if (r.view === 'inbox') return dropZone((t) => doc.moveTask(t, { projectId: doc.inboxId }));
    if (r.view === 'today')
      return dropZone((t) => {
        const task = doc.task(t);
        if (task) doc.updateTask(t, { due: { ...(task.due ?? {}), date: today } });
      });
    if (r.view === 'label')
      return dropZone((t) => {
        const task = doc.task(t);
        if (task && !task.labels.includes(r.id)) doc.setLabels(t, [...task.labels, r.id]);
      });
    return {};
  };

  const item = (r: Route, icon: React.ReactNode, label: string, count?: number) => (
    <a
      key={href(r)}
      href={href(r)}
      {...dropFor(r)}
      className={`nav-item${same(r, route) ? ' active' : ''}`}
      onClick={onNavigate}
      aria-current={same(r, route) ? 'page' : undefined}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </a>
  );

  return (
    <nav className="sidebar" aria-label="Разделы">
      <div className="brand">
        <img src="/icon.svg" alt="" width="26" height="26" />
        <span>Dela</span>
      </div>
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          navigate({ view: 'search', q: query });
          onNavigate?.();
        }}
      >
        <IconSearch width={16} height={16} />
        <input id="search" type="search" placeholder="Поиск" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск" />
      </form>
      {item({ view: 'inbox' }, <IconInbox />, 'Входящие', counts.inbox)}
      {item({ view: 'today' }, <IconToday />, 'Сегодня', counts.today)}
      {item({ view: 'upcoming' }, <IconUpcoming />, 'Предстоящие')}

      <div className="nav-head">
        <span>Проекты</span>
        <button className="icon small" onClick={() => setAdding(true)} aria-label="Новый проект">
          <IconPlus width={16} height={16} />
        </button>
      </div>
      {adding && (
        <input
          className="nav-input"
          autoFocus
          placeholder="Название проекта"
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => {
            const v = e.currentTarget.value.trim();
            if (e.key === 'Enter' && v) {
              const id = doc.createProject({ name: v });
              setAdding(false);
              navigate({ view: 'project', id });
              onNavigate?.();
            } else if (e.key === 'Escape') setAdding(false);
          }}
        />
      )}
      {doc.projects().map((p) => (
        <a
          key={p.project.id}
          href={href({ view: 'project', id: p.project.id })}
          className={`nav-item${same({ view: 'project', id: p.project.id }, route) ? ' active' : ''}`}
          style={{ paddingLeft: `${12 + p.depth * 16}px` }}
          onClick={onNavigate}
          {...dropZone((t) => doc.moveTask(t, { projectId: p.project.id }))}
        >
          <span className={`dot-color c-${p.project.color}`} />
          <span className="nav-label">{p.project.name}</span>
          {doc.isShared(p.project.id) && <IconUsers width={14} height={14} aria-label="общий" />}
          {countIn(p.project.id) ? <span className="count">{countIn(p.project.id)}</span> : null}
        </a>
      ))}

      <div className="nav-head">
        <span>Фильтры</span>
        <a className="icon small" href={href({ view: 'filter', id: 'new' })} aria-label="Новый фильтр" onClick={onNavigate}>
          <IconPlus width={16} height={16} />
        </a>
      </div>
      {doc.filters().map((f) =>
        item({ view: 'filter', id: f.id }, <IconFilter width={16} height={16} className={`c-${f.color}`} />, f.name),
      )}

      {doc.labels().length > 0 && (
        <>
          <div className="nav-head">
            <span>Метки</span>
          </div>
          {doc.labels().map((l) => item({ view: 'label', id: l.id }, <IconTag width={16} height={16} className={`c-${l.color}`} />, l.name))}
        </>
      )}

      <div className="nav-foot">
        {item({ view: 'completed' }, <IconDone />, 'Выполненные')}
        {item({ view: 'trash' }, <IconTrash />, 'Корзина')}
        {item({ view: 'settings' }, <IconSettings />, 'Настройки')}
        <SyncBadge />
      </div>
    </nav>
  );
}
