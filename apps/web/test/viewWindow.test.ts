import { describe, expect, it } from 'vitest';
import { taskHash } from '../src/links.ts';
import { isViewWindow, viewWindowLabel, viewWindowUrl } from '../src/viewWindow.ts';

describe('отдельное окно проекта или задачи', () => {
  it('адрес окна: параметр компактного вида и hash-маршрут', () => {
    expect(viewWindowUrl('#/project/0192-abc')).toBe('?window=1#/project/0192-abc');
    expect(viewWindowUrl(taskHash('t1'))).toBe('?window=1#/task/t1');
  });

  it('метка окна одна на маршрут и годится для Tauri', () => {
    expect(viewWindowLabel('#/project/0192-abc')).toBe('view-project_0192-abc');
    expect(viewWindowLabel('#/task/t1')).toBe('view-task_t1');
    expect(viewWindowLabel(taskHash('a/b c'))).toMatch(/^view-[A-Za-z0-9_-]+$/);
    // Проект и задача с одинаковым id — разные окна.
    expect(viewWindowLabel('#/project/x')).not.toBe(viewWindowLabel('#/task/x'));
    // Параметры внутри hash на метку не влияют.
    expect(viewWindowLabel('#/project/x?task=1')).toBe(viewWindowLabel('#/project/x'));
  });

  it('компактный вид узнаётся по ?window=1', () => {
    expect(isViewWindow('?window=1')).toBe(true);
    expect(isViewWindow('?a=2&window=1')).toBe(true);
    expect(isViewWindow('')).toBe(false);
    expect(isViewWindow('?window=0')).toBe(false);
    expect(isViewWindow('?windows=1')).toBe(false);
    // Адрес окна целиком: search до hash.
    expect(isViewWindow(new URL(viewWindowUrl('#/task/t1'), 'http://tauri.localhost/').search)).toBe(true);
  });
});
