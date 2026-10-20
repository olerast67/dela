/**
 * Напоминания по месту. У задачи поле place: точка, радиус и событие (вход или выход).
 * Координаты лежат в записи задачи и шифруются вместе с ней, сервер их не видит.
 * Срабатывает напоминание только в приложении для Android: зоны отслеживает сам телефон.
 * Сохранённые места («Дом», «Работа») — записи таблицы place в личном пространстве.
 */
import type { Doc, TaskView } from './doc.ts';
import type { Json } from './op.ts';

export type PlaceEvent = 'arrive' | 'leave';

export interface PlaceReminder {
  readonly lat: number;
  readonly lon: number;
  /** Радиус зоны в метрах. */
  readonly radius: number;
  readonly on: PlaceEvent;
  /** Имя места для показа: «Дом»; '' — без имени. */
  readonly name: string;
}

export interface SavedPlace {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly radius: number;
  readonly createdAt: number;
  readonly deletedAt: number | null;
}

/** Зона для телефона: открытая задача с напоминанием по месту. */
export interface PlaceZone extends PlaceReminder {
  readonly taskId: string;
  readonly title: string;
  /** Срочная задача: на Android звенит будильником. */
  readonly alarm: boolean;
}

/** Радиусы на выбор в карточке задачи. */
export const PLACE_RADII = [100, 200, 500] as const;
export const DEFAULT_PLACE_RADIUS = 200;
export const MIN_PLACE_RADIUS = 50;
export const MAX_PLACE_RADIUS = 5000;
/** Сколько зон отдаём телефону: точность и расход батареи от числа зон не зависят, это защита от мусора. */
export const MAX_PLACE_ZONES = 100;

/** Пять знаков после запятой — около метра: точнее приёмник всё равно не даёт. */
export function coordValue(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function finite(v: Json | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function clampRadius(v: number): number {
  return Math.min(MAX_PLACE_RADIUS, Math.max(MIN_PLACE_RADIUS, Math.round(v)));
}

export function isLatLon(lat: unknown, lon: unknown): boolean {
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Разбор поля place из записи задачи; испорченное значение — как будто напоминания нет. */
export function placeReminder(v: Json | undefined): PlaceReminder | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { lat, lon, radius, on, name } = v;
  if (!isLatLon(lat, lon) || !finite(lat) || !finite(lon)) return null;
  if (on !== 'arrive' && on !== 'leave') return null;
  return {
    lat: coordValue(lat),
    lon: coordValue(lon),
    radius: finite(radius) ? clampRadius(radius) : DEFAULT_PLACE_RADIUS,
    on,
    name: typeof name === 'string' ? name.trim().slice(0, 100) : '',
  };
}

/** Значение для записи: то же, что потом прочитает placeReminder. */
export function placeValue(p: PlaceReminder): Json {
  const r = placeReminder(p as unknown as Json);
  if (!r) throw new Error('bad place');
  return { lat: r.lat, lon: r.lon, radius: r.radius, on: r.on, ...(r.name ? { name: r.name } : {}) };
}

export function toPlace(id: string, r: Readonly<Record<string, Json>>): SavedPlace | null {
  if (!isLatLon(r.lat, r.lon)) return null;
  return {
    id,
    name: typeof r.name === 'string' ? r.name.trim().slice(0, 100) : '',
    lat: coordValue(r.lat as number),
    lon: coordValue(r.lon as number),
    radius: finite(r.radius) ? clampRadius(r.radius) : DEFAULT_PLACE_RADIUS,
    createdAt: finite(r.created_at) ? r.created_at : 0,
    deletedAt: finite(r.deleted_at) ? r.deleted_at : null,
  };
}

/** Расстояние по поверхности Земли в метрах (гаверсинус, сфера радиусом 6371 км). */
export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Сохранённое место, в зоне которого точка: «Где я сейчас» дома получает имя «Дом». */
export function nearestPlace(places: readonly SavedPlace[], lat: number, lon: number): SavedPlace | null {
  let best: SavedPlace | null = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = distance(p.lat, p.lon, lat, lon);
    if (d <= p.radius && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Зоны для телефона: открытые задачи с напоминанием по месту. Выполненные и удалённые в список не попадают — телефон их снимает. */
export function placeZones(doc: Pick<Doc, 'openTasks'>, limit = MAX_PLACE_ZONES): PlaceZone[] {
  const out: PlaceZone[] = [];
  for (const t of doc.openTasks() as readonly TaskView[]) {
    if (out.length >= limit) break;
    if (t.place) out.push({ taskId: t.id, title: t.title, alarm: t.alarm, ...t.place });
  }
  return out;
}
