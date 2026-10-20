import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, MemoryReplica, Workspace, applyTemplate, exportJson, exportMarkdown, importTodoist, parseTemplate, projectToTemplate } from '../src/index.ts';

const SPACE = '01929c3e-0000-7000-8000-00000000dddd';
const SHARED = '01929c3e-0000-7000-8000-00000000eeee';

function device(node: string, start = 1_760_000_000_000, spaceId = SPACE, kind: 'personal' | 'shared' = 'personal') {
  let time = start;
  const doc = new Doc({ spaceId, clock: new HybridClock(node, () => time), now: () => time, replica: new MemoryReplica(), kind });
  return { doc, tick: (ms = 1) => (time += ms) };
}

/** Обмен очередями в обе стороны, как через сервер. */
function sync(...docs: Doc[]): void {
  const ops = docs.flatMap((d) => [...d.pending()]);
  for (const d of docs) {
    d.applyRemote(ops);
    d.acknowledge(d.pending());
  }
}

describe('описание проекта и раздела', () => {
  it('старые записи без поля читаются с пустым описанием', () => {
    const { doc } = device('00000000000000aa');
    const hlc = '000001760000000-0000-00000000000000bb';
    doc.applyRemote([
      { table: 'project', record: 'p1', field: 'name', value: 'Старый', hlc },
      { table: 'section', record: 's1', field: 'project', value: 'p1', hlc },
      { table: 'section', record: 's1', field: 'name', value: 'Раздел', hlc },
    ]);
    expect(doc.project('p1')).toMatchObject({ name: 'Старый', description: '' });
    expect(doc.sections('p1')[0]).toMatchObject({ name: 'Раздел', description: '' });
  });

  it('чужое значение не строкой заменяется пустым', () => {
    const { doc } = device('00000000000000aa');
    const p = doc.createProject({ name: 'Дом' });
    doc.applyRemote([{ table: 'project', record: p, field: 'description', value: { x: 1 }, hlc: '999999999999999-0000-00000000000000ff' }]);
    expect(doc.project(p)?.description).toBe('');
  });

  it('обновление и очистка, отмена', () => {
    const { doc, tick } = device('00000000000000aa');
    const p = doc.createProject({ name: 'Дом' });
    const s = doc.createSection(p, 'Кухня');
    tick();
    doc.updateProject(p, { description: '**Цель:** ремонт\n\n' });
    doc.updateSection(s, { description: 'Сначала плитка' });
    expect(doc.project(p)?.description).toBe('**Цель:** ремонт');
    expect(doc.sections(p)[0]?.description).toBe('Сначала плитка');
    // Другие поля не задеты.
    expect(doc.project(p)?.name).toBe('Дом');
    tick();
    doc.updateProject(p, { description: '' });
    expect(doc.project(p)?.description).toBe('');
    doc.undo();
    expect(doc.project(p)?.description).toBe('**Цель:** ремонт');
  });

  it('сливается поле за полем: описание и название с разных устройств не мешают друг другу', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb', 1_760_000_000_000);
    const p = a.doc.createProject({ name: 'Дом' });
    const s = a.doc.createSection(p, 'Кухня');
    sync(a.doc, b.doc);
    a.tick(10);
    b.tick(10);
    a.doc.updateProject(p, { name: 'Квартира' });
    b.doc.updateProject(p, { description: 'с телефона' });
    b.doc.updateSection(s, { description: 'раздел с телефона' });
    sync(a.doc, b.doc);
    for (const d of [a.doc, b.doc]) {
      expect(d.project(p)).toMatchObject({ name: 'Квартира', description: 'с телефона' });
      expect(d.sections(p)[0]?.description).toBe('раздел с телефона');
    }
    // Одновременная правка одного поля: побеждает более поздняя метка.
    a.tick(5);
    b.tick(20);
    a.doc.updateProject(p, { description: 'раньше' });
    b.doc.updateProject(p, { description: 'позже' });
    sync(a.doc, b.doc);
    expect(a.doc.project(p)?.description).toBe('позже');
    expect(b.doc.project(p)?.description).toBe('позже');
  });

  it('экспорт JSON и Markdown, импорт описания проекта из Todoist', () => {
    const { doc } = device('00000000000000aa');
    importTodoist(doc, { projects: [{ id: 'w', name: 'Работа', description: 'Всё по **работе**', child_order: 1 }], sections: [{ id: 's', name: 'Сейчас', project_id: 'w' }] }, { now: 1_760_000_000_000 });
    const work = doc.projects()[0]!.project;
    expect(work.description).toBe('Всё по **работе**');
    doc.updateSection(doc.sections(work.id)[0]!.id, { description: 'Горит' });
    const out = exportJson(doc);
    expect(out.projects).toContainEqual(expect.objectContaining({ name: 'Работа', description: 'Всё по **работе**' }));
    expect(out.sections).toContainEqual(expect.objectContaining({ name: 'Сейчас', description: 'Горит' }));
    const md = exportMarkdown(doc);
    expect(md).toContain('## Работа\n\nВсё по **работе**\n');
    expect(md).toContain('### Сейчас\n\nГорит\n');
  });

  it('шаблон сохраняет описания проекта и разделов', () => {
    const { doc } = device('00000000000000aa');
    const ws = new Workspace(doc);
    const p = ws.createProject({ name: 'Ремонт' });
    const s = ws.createSection(p, 'Кухня');
    ws.updateProject(p, { description: 'Бюджет 100к' });
    ws.updateSection(s, { description: 'Плитка' });
    const tpl = parseTemplate(JSON.parse(JSON.stringify(projectToTemplate(ws, p, '2026-10-13', 'Europe/Moscow'))));
    expect(tpl).toMatchObject({ projectDescription: 'Бюджет 100к', sections: [{ name: 'Кухня', description: 'Плитка' }] });
    const copy = applyTemplate(ws, tpl, '2026-11-01', 'Ремонт 2');
    expect(ws.project(copy)?.description).toBe('Бюджет 100к');
    expect(ws.sections(copy)[0]?.description).toBe('Плитка');
  });

  it('в общем проекте описание переходит при «Поделиться» и доходит до участника', () => {
    const { doc } = device('00000000000000aa');
    const ws = new Workspace(doc);
    const shared = device('00000000000000aa', 1_760_000_000_000, SHARED, 'shared').doc;
    const p = ws.createProject({ name: 'Семья' });
    const s = ws.createSection(p, 'Покупки');
    ws.updateProject(p, { description: 'Общие дела' });
    ws.updateSection(s, { description: 'По субботам' });
    ws.shareProject(p, shared);
    expect(ws.project(SHARED)?.description).toBe('Общие дела');

    const other = device('00000000000000cc', 1_760_000_000_000, SHARED, 'shared').doc;
    sync(shared, other);
    expect(other.project(SHARED)?.description).toBe('Общие дела');
    expect(other.sections(SHARED)[0]?.description).toBe('По субботам');

    // Правка участника приходит обратно, как и название.
    const otherSection = other.sections(SHARED)[0]!.id;
    other.updateProject(SHARED, { description: 'Новое от участника' });
    other.updateSection(otherSection, { description: 'По воскресеньям' });
    sync(shared, other);
    expect(ws.project(SHARED)?.description).toBe('Новое от участника');
    expect(ws.sections(SHARED)[0]?.description).toBe('По воскресеньям');
  });
});
