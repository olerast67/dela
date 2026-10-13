import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeText } from '#core';
import { controller } from '../controller.ts';
import { navigate, useDoc, type Route } from '../hooks.ts';
import { applyTheme } from './Views.tsx';

interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly hint?: string;
  readonly run: () => void;
}

export function CommandPalette({ onClose, onQuickAdd, onOpen }: { onClose: () => void; onQuickAdd: () => void; onOpen: (id: string) => void }) {
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
      { id: 'add', label: 'Новая задача', group: 'Действия', hint: 'Q', run: onQuickAdd },
      { id: 'inbox', label: 'Входящие', group: 'Перейти', run: go({ view: 'inbox' }) },
      { id: 'today', label: 'Сегодня', group: 'Перейти', run: go({ view: 'today' }) },
      { id: 'upcoming', label: 'Предстоящие', group: 'Перейти', run: go({ view: 'upcoming' }) },
      { id: 'calendar', label: 'Календарь', group: 'Перейти', run: go({ view: 'calendar', mode: null, date: null }) },
      { id: 'completed', label: 'Выполненные', group: 'Перейти', run: go({ view: 'completed' }) },
      { id: 'trash', label: 'Корзина', group: 'Перейти', run: go({ view: 'trash' }) },
      { id: 'settings', label: 'Настройки', group: 'Перейти', run: go({ view: 'settings' }) },
      ...doc.projects().map((p) => ({ id: `p${p.project.id}`, label: `# ${p.project.name}`, group: 'Проекты', run: go({ view: 'project', id: p.project.id }) })),
      ...doc.filters().map((f) => ({ id: `f${f.id}`, label: f.name, group: 'Фильтры', run: go({ view: 'filter', id: f.id }) })),
      ...doc.labels().map((l) => ({ id: `l${l.id}`, label: `@ ${l.name}`, group: 'Метки', run: go({ view: 'label', id: l.id }) })),
      { id: 'new-filter', label: 'Новый фильтр', group: 'Действия', run: go({ view: 'filter', id: 'new' }) },
      { id: 'sync', label: 'Синхронизировать сейчас', group: 'Действия', run: () => void controller.syncNow() },
      { id: 'undo', label: 'Отменить последнее действие', group: 'Действия', hint: 'Ctrl+Z', run: () => doc.undo() },
      { id: 'dark', label: 'Тёмная тема', group: 'Действия', run: setTheme('dark') },
      { id: 'light', label: 'Светлая тема', group: 'Действия', run: setTheme('light') },
      { id: 'system', label: 'Тема как в системе', group: 'Действия', run: setTheme('system') },
    ];
    return out;
  }, [doc, onQuickAdd]);

  const needle = normalizeText(query);
  const matched = needle ? commands.filter((c) => normalizeText(c.label).includes(needle)) : commands;
  const tasks: Command[] =
    needle.length >= 2
      ? doc.search(query).slice(0, 8).map((t) => ({ id: `t${t.id}`, label: t.title, group: 'Задачи', run: () => onOpen(t.id) }))
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
      <div className="modal palette" role="dialog" aria-label="Команды">
        <input
          autoFocus
          className="palette-input"
          placeholder="Куда перейти или что сделать…"
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
          aria-label="Команда"
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
          {items.length === 0 && <p className="empty">Ничего не найдено.</p>}
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Q', 'Новая задача'],
  ['Ctrl+K', 'Команды и переход'],
  ['/', 'Поиск'],
  ['↓ ↑ или J K', 'Перейти по задачам'],
  ['Enter', 'Открыть задачу'],
  ['E', 'Выполнить задачу'],
  ['T', 'Перенести на сегодня'],
  ['Delete', 'Удалить задачу'],
  ['Ctrl+Z', 'Отменить'],
  ['G затем T / U / C / I', 'Сегодня, Предстоящие, Календарь, Входящие'],
  ['Esc', 'Закрыть'],
  ['?', 'Эта справка'],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-label="Горячие клавиши">
        <h2 className="palette-title">Горячие клавиши</h2>
        <p className="muted palette-note">Работают в любой раскладке.</p>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, v]) => [<dt key={`k${k}`}><kbd>{k}</kbd></dt>, <dd key={`v${k}`}>{v}</dd>])}
        </dl>
        <div className="row palette-foot">
          <button onClick={onClose} autoFocus>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
