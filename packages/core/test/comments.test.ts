import { beforeAll, describe, expect, it } from 'vitest';
import { Doc, HybridClock, initCrypto, openFile, sealFile } from '../src/index.ts';

beforeAll(async () => {
  await initCrypto();
});

function make() {
  let time = 1_760_000_000_000;
  return new Doc({ spaceId: '01929c3e-0000-7000-8000-0000000000aa', clock: new HybridClock('00000000000000aa', () => (time += 1)), now: () => time });
}

describe('комментарии и исполнитель', () => {
  it('комментарии по порядку, счётчик у задачи, удаление затирает текст и возвращает файл', () => {
    const doc = make();
    const task = doc.createTask({ title: 'Ремонт' });
    const file = { id: '01929c3e-0000-7000-8000-0000000000f1', name: 'смета.pdf', size: 1200, type: 'application/pdf', key: 'a2V5' };
    const c1 = doc.addComment(task, { text: 'Первый', author: 'u1' });
    doc.addComment(task, { text: 'Смета во вложении', author: 'u2', file });
    expect(doc.comments(task).map((c) => c.text)).toEqual(['Первый', 'Смета во вложении']);
    expect(doc.comments(task)[1]!.file).toEqual(file);
    expect(doc.task(task)?.commentCount).toBe(2);
    expect(doc.deleteComment(c1)).toBeNull();
    expect(doc.comments(task)).toHaveLength(1);
    expect(doc.replica.get('comment', c1)?.text).toBeNull();
    expect(doc.task(task)?.commentCount).toBe(1);
  });

  it('исполнитель задачи и удаление навсегда вместе с комментариями', () => {
    const doc = make();
    const task = doc.createTask({ title: 'Покрасить стены' });
    doc.updateTask(task, { assignee: '01929c3e-0000-7000-8000-0000000000b2' });
    expect(doc.task(task)?.assignee).toBe('01929c3e-0000-7000-8000-0000000000b2');
    const file = { id: '01929c3e-0000-7000-8000-0000000000f2', name: 'цвет.jpg', size: 10, type: 'image/jpeg', key: 'a2V5' };
    const c = doc.addComment(task, { text: 'Цвет: белый', author: null, file });
    doc.deleteTask(task);
    expect(doc.purgeTask(task)).toEqual([file]);
    expect(doc.replica.get('comment', c)).toMatchObject({ text: null, author: null });
    expect(doc.replica.get('comment', c)?.deleted_at).not.toBeNull();
  });

  it('файл шифруется своим ключом и привязан к пространству и id', () => {
    const data = new TextEncoder().encode('секретная смета');
    const { key, blob } = sealFile(data, 'space-1', 'file-1');
    expect(new TextDecoder().decode(openFile(blob, key, 'space-1', 'file-1'))).toBe('секретная смета');
    expect(() => openFile(blob, key, 'space-1', 'file-2')).toThrow();
    expect(() => openFile(blob, key, 'space-2', 'file-1')).toThrow();
  });
});
