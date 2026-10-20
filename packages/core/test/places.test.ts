import { describe, expect, it } from 'vitest';
import {
  Doc,
  HybridClock,
  Workspace,
  distance,
  initCrypto,
  nearestPlace,
  newKey,
  openEnvelope,
  placeZones,
  sealOp,
  spaceKeys,
  type Op,
} from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 20, 9, 0);
const LATER = '999999999999999-0000-00000000000000ff';
const HOME = { lat: 55.75222, lon: 37.61556 };

function doc(node = 'aa') {
  return new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000eeee', clock: new HybridClock(node.padStart(16, '0'), () => NOW), now: () => NOW, timeZone: 'Europe/Moscow' });
}

describe('напоминание по месту: поле задачи', () => {
  it('старые задачи без поля читаются как раньше, поле пишется и читается', () => {
    const d = doc();
    const old = d.createTask({ title: 'Старая' });
    expect(d.task(old)?.place).toBeNull();
    const id = d.createTask({ title: 'Купить хлеб', place: { ...HOME, radius: 200, on: 'arrive', name: ' Дом ' } });
    expect(d.task(id)?.place).toEqual({ ...HOME, radius: 200, on: 'arrive', name: 'Дом' });
    d.updateTask(id, { place: { ...HOME, radius: 500, on: 'leave', name: '' } });
    expect(d.task(id)?.place).toEqual({ ...HOME, radius: 500, on: 'leave', name: '' });
    d.updateTask(id, { place: null });
    expect(d.task(id)?.place).toBeNull();
  });

  it('испорченное значение — без напоминания, радиус ограничен, координаты округлены до метра', () => {
    const d = doc();
    const id = d.createTask({ title: 'X' });
    let n = 0;
    // Каждая следующая правка с большей меткой: равная метка проиграла бы уже записанной.
    const put = (value: unknown) => d.applyRemote([{ table: 'task', record: id, field: 'place', value: value as never, hlc: LATER.replace('-0000-', `-${String(++n).padStart(4, '0')}-`) }]);
    put({ lat: 91, lon: 0, on: 'arrive' });
    expect(d.task(id)?.place).toBeNull();
    put({ lat: 10, lon: 20, on: 'near' });
    expect(d.task(id)?.place).toBeNull();
    put('55.7,37.6');
    expect(d.task(id)?.place).toBeNull();
    put({ lat: 10.1234567, lon: -20.7654321, radius: 1e9, on: 'leave', name: 42 });
    expect(d.task(id)?.place).toEqual({ lat: 10.12346, lon: -20.76543, radius: 5000, on: 'leave', name: '' });
    put({ lat: 10, lon: 20, radius: 1, on: 'arrive' });
    expect(d.task(id)?.place?.radius).toBe(50);
    put({ lat: 10, lon: 20, on: 'arrive' });
    expect(d.task(id)?.place?.radius).toBe(200);
  });

  it('поле синхронизируется между устройствами как остальные', () => {
    const a = doc('aa');
    const b = doc('bb');
    a.subscribe((ops, origin) => origin === 'local' && b.applyRemote(ops));
    const id = a.createTask({ title: 'Забрать посылку', place: { lat: 59.93, lon: 30.31, radius: 100, on: 'arrive', name: 'Почта' } });
    expect(b.task(id)?.place).toEqual({ lat: 59.93, lon: 30.31, radius: 100, on: 'arrive', name: 'Почта' });
    a.updateTask(id, { place: null });
    expect(b.task(id)?.place).toBeNull();
  });

  it('координаты уходят на сервер только внутри шифротекста', async () => {
    await initCrypto();
    const keys = spaceKeys(newKey());
    const d = doc();
    const ops: Op[] = [];
    d.subscribe((o) => ops.push(...o));
    d.createTask({ title: 'Секрет', place: { lat: 12.34567, lon: 76.54321, radius: 200, on: 'leave', name: 'Тайник' } });
    const op = ops.find((o) => o.field === 'place')!;
    const env = sealOp('space-1', keys, op);
    expect(JSON.stringify(env)).not.toMatch(/12\.34567|76\.54321|Тайник/);
    expect(openEnvelope('space-1', keys, env).value).toEqual(op.value);
  });

  it('при переносе задачи между пространствами место сохраняется', () => {
    const ws = new Workspace(doc());
    const place = { ...HOME, radius: 100, on: 'arrive' as const, name: 'Дом' };
    const id = ws.createTask({ title: 'Полить цветы', place });
    expect(ws.task(id)?.place).toEqual(place);
  });
});

describe('зоны для телефона', () => {
  it('только открытые задачи с местом; выполненные и удалённые снимаются', () => {
    const d = doc();
    const a = d.createTask({ title: 'A', place: { ...HOME, radius: 200, on: 'arrive', name: 'Дом' }, alarm: true });
    const b = d.createTask({ title: 'B', place: { lat: 1, lon: 2, radius: 500, on: 'leave', name: '' } });
    const c = d.createTask({ title: 'C', place: { lat: 3, lon: 4, radius: 100, on: 'arrive', name: '' } });
    d.createTask({ title: 'Без места' });
    expect(placeZones(d)).toEqual([
      { taskId: a, title: 'A', alarm: true, ...HOME, radius: 200, on: 'arrive', name: 'Дом' },
      { taskId: b, title: 'B', alarm: false, lat: 1, lon: 2, radius: 500, on: 'leave', name: '' },
      { taskId: c, title: 'C', alarm: false, lat: 3, lon: 4, radius: 100, on: 'arrive', name: '' },
    ]);
    d.completeTask(b);
    d.deleteTask(c);
    expect(placeZones(d).map((z) => z.taskId)).toEqual([a]);
    expect(placeZones(d, 0)).toEqual([]);
  });
});

describe('сохранённые места', () => {
  it('сохраняются в личном пространстве, удаление стирает координаты', () => {
    const ws = new Workspace(doc());
    const home = ws.savePlace({ name: 'Дом', ...HOME, radius: 200 });
    ws.savePlace({ name: 'Работа', lat: 55.7, lon: 37.5, radius: 9999 });
    expect(ws.places().map((p) => [p.name, p.radius])).toEqual([
      ['Дом', 200],
      ['Работа', 5000],
    ]);
    ws.deletePlace(home);
    expect(ws.places().map((p) => p.name)).toEqual(['Работа']);
    expect(ws.personal.replica.all('place').get(home)?.lat).toBeNull();
  });

  it('«Где я сейчас» узнаёт сохранённое место, если точка в его радиусе', () => {
    const ws = new Workspace(doc());
    ws.savePlace({ name: 'Дом', ...HOME, radius: 200 });
    ws.savePlace({ name: 'Работа', lat: 55.7601, lon: 37.6186, radius: 200 });
    // ~110 м к северу от дома.
    expect(nearestPlace(ws.places(), HOME.lat + 0.001, HOME.lon)?.name).toBe('Дом');
    expect(nearestPlace(ws.places(), 55.8, 37.7)).toBeNull();
  });
});

describe('расстояние', () => {
  it('гаверсинус: известные расстояния', () => {
    expect(distance(HOME.lat, HOME.lon, HOME.lat, HOME.lon)).toBe(0);
    // Градус широты — около 111,2 км.
    expect(distance(0, 0, 1, 0)).toBeCloseTo(111_195, -1);
    // Москва — Санкт-Петербург, около 634 км.
    expect(distance(55.7558, 37.6173, 59.9343, 30.3351) / 1000).toBeCloseTo(634, -1);
    // Через линию перемены дат — короткий путь.
    expect(distance(0, 179.999, 0, -179.999)).toBeLessThan(250);
  });
});
