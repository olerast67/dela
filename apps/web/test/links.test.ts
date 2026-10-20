import { describe, expect, it } from 'vitest';
import { appLink, linkHash, shareLink, taskHash } from '../src/links.ts';

describe('ссылки на экран и задачу', () => {
  it('https-ссылка: адрес сервера и hash-маршрут', () => {
    expect(shareLink('https://dela.example.com', taskHash('0192-abc'))).toBe('https://dela.example.com/#/task/0192-abc');
    expect(shareLink('https://dela.example.com/', '#/today')).toBe('https://dela.example.com/#/today');
    // Страница клиента в браузере: путь сохраняется, старые hash и query отбрасываются.
    expect(shareLink('https://example.org/dela/?x=1#/inbox', '#/project/p1')).toBe('https://example.org/dela/#/project/p1');
    expect(shareLink('http://localhost:4173', '#/upcoming')).toBe('http://localhost:4173/#/upcoming');
  });

  it('id задачи кодируется', () => {
    expect(taskHash('a/b c')).toBe('#/task/a%2Fb%20c');
  });

  it('ссылка в приложение', () => {
    expect(appLink('#/task/x1')).toBe('dela://open#/task/x1');
  });

  it('разбор dela:// в маршрут', () => {
    expect(linkHash('dela://open#/task/x1')).toBe('#/task/x1');
    expect(linkHash('dela://open/#/project/p1')).toBe('#/project/p1');
    expect(linkHash(' dela://open#/search?q=%D0%BA%D0%BE%D1%82 ')).toBe('#/search?q=%D0%BA%D0%BE%D1%82');
    expect(linkHash(appLink(taskHash('a/b')))).toBe('#/task/a%2Fb');
    expect(linkHash('https://dela.example.com/#/today')).toBe('#/today');
  });

  it('чужие схемы и ссылки без маршрута отбрасываются', () => {
    expect(linkHash('dela://open')).toBeNull();
    expect(linkHash('dela://open#task')).toBeNull();
    expect(linkHash('javascript:alert(1)//#/today')).toBeNull();
    expect(linkHash('file:///c:/x#/today')).toBeNull();
    expect(linkHash('не ссылка')).toBeNull();
  });
});
