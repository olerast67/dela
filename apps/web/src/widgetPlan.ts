/**
 * Режим «План» виджета Android: кнопка «+15» на виджете кладёт сдвиг в очередь на телефоне
 * (минуты и момент нажатия), виджет сразу рисует сдвинутый план сам, а приложение при открытии
 * или сразу, если оно запущено, применяет сдвиг к задачам через shiftRest, как «+15» в ленте.
 */
import { planPatch, shiftRest, type Workspace } from '#core';
import { TZ } from './format.ts';
import { nativePlugin } from './platform.ts';

interface WidgetShift {
  /** Момент нажатия, мс. */
  readonly at: number;
  /** Минуты сдвига. */
  readonly m: number;
}

interface DelaWidgetShifts {
  takeShifts(): Promise<{ shifts: WidgetShift[] }>;
}

const dateOf = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));

/**
 * Применить сдвиги с виджета. completed — задачи, отмеченные на виджете в ту же очередь:
 * они уже сделаны и остаток дня не держат. Сдвиг за прошлый день пропускается.
 */
export async function applyWidgetShifts(doc: Workspace, completed: readonly string[] = []): Promise<void> {
  const w = (await nativePlugin<DelaWidgetShifts>('DelaWidget'))?.p;
  if (!w) return;
  const shifts = (await w.takeShifts().catch(() => ({ shifts: [] as WidgetShift[] }))).shifts;
  if (!shifts.length) return;
  const today = dateOf(Date.now());
  const done = new Set(completed);
  const defaultDuration = doc.getPlanSettings().duration;
  doc.group(() => {
    for (const s of shifts) {
      if (!(s.m > 0) || dateOf(s.at) !== today) continue;
      const tasks = doc.openTasks().map((t) => (done.has(t.id) ? { ...t, completedAt: s.at } : t));
      const { changes } = shiftRest({ date: today, tz: TZ, tasks, defaultDuration }, s.at, s.m);
      for (const c of changes) {
        const t = doc.task(c.taskId);
        if (t) doc.updateTask(c.taskId, planPatch(t, c, TZ));
      }
    }
  });
}
