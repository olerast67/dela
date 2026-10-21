import { useEffect, useMemo, useRef, useState } from 'react';
import { gameFeature, normalizeText } from '#core';
import { controller } from '../controller.ts';
import { navigate, useDoc, type Route } from '../hooks.ts';
import { applyTheme } from './Views.tsx';
import { tr } from '../i18n.ts';

interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly hint?: string;
  readonly run: () => void;
}

export function CommandPalette({ onClose, onQuickAdd, onOpen, onCopyLink }: { onClose: () => void; onQuickAdd: () => void; onOpen: (id: string) => void; onCopyLink: () => void }) {
  const doc = useDoc();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const go = (r: Route) => () => navigate(r);
  const setTheme = (t: string) => () => {
    try {
      localStorage.setItem('theme', t);
    } catch {
      // без localStorage тема действует до перезагрузки
    }
    applyTheme(t);
  };

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [
      { id: 'add', label: tr('Новая задача'), group: tr('Действия'), hint: 'Q', run: onQuickAdd },
      { id: 'inbox', label: tr('Входящие'), group: tr('Перейти'), run: go({ view: 'inbox' }) },
      { id: 'today', label: tr('Сегодня'), group: tr('Перейти'), run: go({ view: 'today' }) },
      { id: 'upcoming', label: tr('Предстоящие'), group: tr('Перейти'), run: go({ view: 'upcoming' }) },
      { id: 'calendar', label: tr('Календарь'), group: tr('Перейти'), run: go({ view: 'calendar', mode: null, date: null }) },
      { id: 'completed', label: tr('Выполненные'), group: tr('Перейти'), run: go({ view: 'completed' }) },
      { id: 'stats', label: tr('Статистика'), group: tr('Перейти'), run: go({ view: 'stats' }) },
      ...(gameFeature(doc.getGameSettings(), 'garden') ? [{ id: 'garden', label: tr('Сад'), group: tr('Перейти'), run: go({ view: 'garden' }) }] : []),
      { id: 'activity', label: tr('История'), group: tr('Перейти'), run: go({ view: 'activity' }) },
      { id: 'templates', label: tr('Шаблоны'), group: tr('Перейти'), run: go({ view: 'templates' }) },
      { id: 'trash', label: tr('Корзина'), group: tr('Перейти'), run: go({ view: 'trash' }) },
      { id: 'settings', label: tr('Настройки'), group: tr('Перейти'), run: go({ view: 'settings' }) },
      ...doc.projects().map((p) => ({ id: `p${p.project.id}`, label: `# ${p.project.name}`, group: tr('Проекты'), run: go({ view: 'project', id: p.project.id }) })),
      ...doc.filters().map((f) => ({ id: `f${f.id}`, label: f.name, group: tr('Фильтры'), run: go({ view: 'filter', id: f.id }) })),
      ...doc.labels().map((l) => ({ id: `l${l.id}`, label: `@ ${l.name}`, group: tr('Метки'), run: go({ view: 'label', id: l.id }) })),
      { id: 'new-filter', label: tr('Новый фильтр'), group: tr('Действия'), run: go({ view: 'filter', id: 'new' }) },
      { id: 'link', label: tr('Копировать ссылку'), group: tr('Действия'), hint: 'Ctrl+Shift+C', run: onCopyLink },
      { id: 'sync', label: tr('Синхронизировать сейчас'), group: tr('Действия'), run: () => void controller.syncNow() },
      ...(controller.getState().lockEnabled ? [{ id: 'lock', label: tr('Заблокировать'), group: tr('Действия'), run: () => controller.lockNow() }] : []),
      { id: 'undo', label: tr('Отменить последнее действие'), group: tr('Действия'), hint: 'Ctrl+Z', run: () => doc.undo() },
      { id: 'dark', label: tr('Тёмная тема'), group: tr('Действия'), run: setTheme('dark') },
      { id: 'light', label: tr('Светлая тема'), group: tr('Действия'), run: setTheme('light') },
      { id: 'system', label: tr('Тема как в системе'), group: tr('Действия'), run: setTheme('system') },
    ];
    return out;
  }, [doc, onQuickAdd, onCopyLink]);

  const needle = normalizeText(query);
  const matched = needle ? commands.filter((c) => normalizeText(c.label).includes(needle)) : commands;
  const tasks: Command[] =
    needle.length >= 2
      ? doc.search(query).slice(0, 8).map((t) => ({ id: `t${t.id}`, label: t.title, group: tr('Задачи'), run: () => onOpen(t.id) }))
      : [];
  const items = [...matched, ...tasks];
  const current = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.cmd.active')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  function run(c: Command | undefined) {
    if (!c) return;
    onClose();
    c.run();
  }

  let lastGroup = '';
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-label={tr('Команды')}>
        <input
          autoFocus
          className="palette-input"
          placeholder={tr('Куда перейти или что сделать…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((current + 1) % Math.max(1, items.length));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((current - 1 + items.length) % Math.max(1, items.length));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(items[current]);
            } else if (e.key === 'Escape') onClose();
          }}
          aria-label={tr('Команда')}
        />
        <div className="palette-list" ref={list} role="listbox">
          {items.map((c, i) => {
            const head = c.group !== lastGroup ? <div className="cmd-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head}
                <div
                  className={`cmd${i === current ? ' active' : ''}`}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  <span>{c.label}</span>
                  {c.hint && <kbd>{c.hint}</kbd>}
                </div>
              </div>
            );
          })}
          {items.length === 0 && <p className="empty">{tr('Ничего не найдено.')}</p>}
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Q', tr('Новая задача')],
  ['Ctrl+K', tr('Команды и переход')],
  ['/', tr('Поиск')],
  [tr('↓ ↑ или J K'), tr('Перейти по задачам')],
  ['Enter', tr('Открыть задачу')],
  ['E', tr('Выполнить задачу')],
  ['T', tr('Перенести на сегодня')],
  ['Delete', tr('Удалить задачу')],
  ['Ctrl+Z', tr('Отменить')],
  ['Ctrl+Shift+C', tr('Копировать ссылку на задачу или экран')],
  [tr('G затем T / U / C / I'), tr('Сегодня, Предстоящие, Календарь, Входящие')],
  ['Esc', tr('Закрыть')],
  ['?', tr('Эта справка')],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-label={tr('Горячие клавиши')}>
        <h2 className="palette-title">{tr('Горячие клавиши')}</h2>
        <p className="muted palette-note">{tr('Работают в любой раскладке.')}</p>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, v]) => [<dt key={`k${k}`}><kbd>{k}</kbd></dt>, <dd key={`v${k}`}>{v}</dd>])}
        </dl>
        <div className="row palette-foot">
          <button onClick={onClose} autoFocus>
            {tr('Закрыть')}
          </button>
        </div>
      </div>
    </div>
  );
}
