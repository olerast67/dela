import { beforeAll, describe, expect, it } from 'vitest';
import { Doc, HybridClock, initCrypto, newKey, openFile, sealFile, signComment, signingKeys, toB64, verifyComment, type Comment } from '../src/index.ts';

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
    const file = { id: '01929c3e-0000-7000-8000-0000000000f1', name: 'смета.pdf', size: 1200, type: 'application/pdf', key: 'a2V5'.repeat(11) };
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
    const file = { id: '01929c3e-0000-7000-8000-0000000000f2', name: 'цвет.jpg', size: 10, type: 'image/jpeg', key: 'a2V5'.repeat(11) };
    const c = doc.addComment(task, { text: 'Цвет: белый', author: null, file });
    doc.deleteTask(task);
    expect(doc.purgeTask(task)).toEqual([file]);
    expect(doc.replica.get('comment', c)).toMatchObject({ text: null, author: null });
    expect(doc.replica.get('comment', c)?.deleted_at).not.toBeNull();
  });

  it('файл с подложным id отбрасывается: id попадает в адрес запроса', () => {
    const doc = make();
    const task = doc.createTask({ title: 'Задача' });
    doc.addComment(task, { text: 'атака', author: 'u1', file: { id: '../members/01929c3e-0000-7000-8000-0000000000b2', name: 'x', size: 1, type: '', key: 'a2V5'.repeat(11) } });
    expect(doc.comments(task)[0]!.file).toBeNull();
  });

  it('файл шифруется своим ключом и привязан к пространству и id', () => {
    const data = new TextEncoder().encode('секретная смета');
    const { key, blob } = sealFile(data, 'space-1', 'file-1');
    expect(new TextDecoder().decode(openFile(blob, key, 'space-1', 'file-1'))).toBe('секретная смета');
    expect(() => openFile(blob, key, 'space-1', 'file-2')).toThrow();
    expect(() => openFile(blob, key, 'space-2', 'file-1')).toThrow();
  });

  it('подпись комментария: проверяется ключом автора, ломается при подмене текста, автора или файла', () => {
    const doc = make();
    const task = doc.createTask({ title: 'Ремонт' });
    const alice = signingKeys(newKey());
    const mallory = signingKeys(newKey());
    const id = doc.addComment(task, { text: '  Смета готова ', author: 'alice', sign: (c) => signComment(alice.secretKey, c) });
    const c = doc.comments(task).find((x) => x.id === id)!;
    const check = (x: Comment, key = alice.publicKey) =>
      verifyComment(toB64(key), x.sig!, { spaceId: doc.spaceId, id: x.id, taskId: x.taskId, author: x.author, createdAt: x.createdAt, text: x.text, file: x.file });
    expect(c.text).toBe('Смета готова');
    expect(check(c)).toBe(true);
    expect(check(c, mallory.publicKey)).toBe(false);
    expect(check({ ...c, text: 'Смета не нужна' })).toBe(false);
    expect(check({ ...c, author: 'bob' })).toBe(false);
    expect(check({ ...c, sig: 'не подпись' })).toBe(false);
    // Ключ выводится из мастер-ключа и одинаков на всех устройствах.
    const master = newKey();
    expect(toB64(signingKeys(master).publicKey)).toBe(toB64(signingKeys(master).publicKey));
  });
  it('файл по частям: формат и число частей в записи, подпись та же, что у старых клиентов', () => {
    const doc = make();
    const task = doc.createTask({ title: 'Видео' });
    const alice = signingKeys(newKey());
    const file = { id: '01929c3e-0000-7000-8000-0000000000f3', name: 'ролик.mp4', size: 9_000_000, type: 'video/mp4', key: 'a2V5'.repeat(11), v: 2 as const, parts: 3 };
    const id = doc.addComment(task, { text: '', author: 'alice', file, sign: (c) => signComment(alice.secretKey, c) });
    const c = doc.comments(task).find((x) => x.id === id)!;
    expect(c.file).toEqual(file);
    const signed = { spaceId: doc.spaceId, id: c.id, taskId: c.taskId, author: c.author, createdAt: c.createdAt, text: c.text };
    expect(verifyComment(toB64(alice.publicKey), c.sig!, { ...signed, file: c.file })).toBe(true);
    // Старый клиент не знает полей v и parts: подпись у него тоже сходится.
    const { v: _v, parts: _p, ...old } = file;
    expect(verifyComment(toB64(alice.publicKey), c.sig!, { ...signed, file: old })).toBe(true);
    expect(verifyComment(toB64(alice.publicKey), c.sig!, { ...signed, file: { ...file, size: 1 } })).toBe(false);
  });
});
