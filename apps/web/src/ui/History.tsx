/** История действий и шаблоны проектов. */
import { useRef, useState } from 'react';
import { applyTemplate, builtinTemplates, parseTemplate, projectToTemplate, type ProjectTemplate } from '#core';
import { controller } from '../controller.ts';
import { TZ, dayHeading, todayDate } from '../format.ts';
import { navigate, useDoc } from '../hooks.ts';
import { showToast } from './toast.tsx';
import { LANG, LOCALE, tr } from '../i18n.ts';

const KIND: Record<string, string> = { created: tr('Создана'), completed: tr('Выполнена'), deleted: tr('Удалена'), comment: tr('Комментарий') };

export function ActivityView({ onOpen }: { onOpen: (id: string) => void }) {
  const doc = useDoc();
  const [project, setProject] = useState('');
  const [limit, setLimit] = useState(200);
  const events = doc.activity(2000).filter((e) => !project || e.projectId === project);
  const shown = events.slice(0, limit);
  const day = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(at));
  const today = todayDate();
  let current = '';
  return (
    <>
      <header className="view-head">
        <h1>{tr('История')}</h1>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label={tr('Проект')}>
          <option value="">{tr('Все проекты')}</option>
          <option value={doc.inboxId}>{tr('Входящие')}</option>
          {doc.projects().map((p) => (
            <option key={p.project.id} value={p.project.id}>
              {p.project.name}
            </option>
          ))}
        </select>
      </header>
      {shown.length === 0 && <p className="empty">{tr('Здесь появятся созданные, выполненные и удалённые задачи и комментарии.')}</p>}
      {shown.map((e, i) => {
        const d = day(e.at);
        const head = d !== current;
        current = d;
        const who = e.actor && e.actor !== controller.userId ? controller.memberEmail(e.spaceId, e.actor) : null;
        const alive = doc.isAlive(e.taskId);
        return (
          <div key={`${e.kind}-${e.taskId}-${e.at}-${i}`}>
            {head && <h2>{dayHeading(d, today)}</h2>}
            <div className={`activity-row kind-${e.kind}${alive ? ' link' : ''}`} onClick={() => alive && onOpen(e.taskId)}>
              <span className="activity-time">{new Date(e.at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="activity-kind">{KIND[e.kind]}</span>
              <span className="activity-title">
                {e.title || tr('Без названия')}
                {e.kind === 'comment' && e.text ? <span className="muted"> · {e.text.slice(0, 80)}</span> : null}
              </span>
              {who && <span className="muted activity-who">{who}</span>}
            </div>
          </div>
        );
      })}
      {events.length > limit && (
        <button className="add-row" onClick={() => setLimit(limit + 200)}>
          {tr('Показать ещё')}
        </button>
      )}
    </>
  );
}

function download(name: string, data: unknown): void {
  const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = `${name}.dela-template.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Сохранить проект как шаблон (кнопка в заголовке проекта). */
export function saveProjectAsTemplate(doc: ReturnType<typeof useDoc>, projectId: string): void {
  const tpl = projectToTemplate(doc, projectId, todayDate(), TZ, tr('Входящие'));
  doc.saveTemplate(tpl.name, tpl);
  showToast(tr('Шаблон сохранён'), { label: tr('Открыть'), run: () => navigate({ view: 'templates' }) });
}

export function TemplatesView() {
  const doc = useDoc();
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const create = (tpl: ProjectTemplate) => {
    const id = applyTemplate(doc, tpl, todayDate());
    navigate({ view: 'project', id });
  };
  const own = doc.templates();
  return (
    <>
      <header className="view-head">
        <h1>{tr('Шаблоны')}</h1>
        <button onClick={() => file.current?.click()}>{tr('Загрузить из файла')}</button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label={tr('Файл шаблона')}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const tpl = parseTemplate(JSON.parse(await f.text()));
              doc.saveTemplate(tpl.name, tpl);
              setMsg(tr('Шаблон «{name}» добавлен.', { name: tpl.name }));
            } catch (err) {
              setMsg(err instanceof Error ? tr(err.message) : tr('Файл не подошёл'));
            }
          }}
        />
      </header>
      {msg && <p className="muted">{msg}</p>}
      <p className="muted">{tr('Шаблон создаёт проект с разделами и задачами. Сроки считаются от дня создания. Свой шаблон: кнопка «Шаблон» в заголовке проекта.')}</p>
      {own.length > 0 && <h2>{tr('Мои')}</h2>}
      <div className="template-grid">
        {own.map((t) => {
          let tpl: ProjectTemplate | null = null;
          try {
            tpl = parseTemplate(t.data);
          } catch {
            tpl = null;
          }
          const count = tpl ? tpl.tasks.length + tpl.sections.reduce((n, s) => n + s.tasks.length, 0) : 0;
          return (
            <div key={t.id} className="template-card">
              <b>{t.name}</b>
              <span className="muted">{tpl ? tr('{length} разд. · {count} задач', { length: tpl.sections.length, count: count }) : tr('Шаблон повреждён')}</span>
              <div className="row">
                {tpl && (
                  <button className="primary" onClick={() => create(tpl!)}>
                    {tr('Создать проект')}
                  </button>
                )}
                {tpl && <button onClick={() => download(t.name, tpl)}>{tr('Скачать')}</button>}
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(tr('Удалить шаблон «{name}»?', { name: t.name }))) doc.deleteTemplate(t.id);
                  }}
                >
                  {tr('Удалить')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <h2>{tr('Готовые')}</h2>
      <div className="template-grid">
        {builtinTemplates(LANG).map((t) => (
          <div key={t.name} className="template-card">
            <b>{t.name}</b>
            <span className="muted">{t.description}</span>
            <div className="row">
              <button className="primary" onClick={() => create(t)}>
                {tr('Создать проект')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
