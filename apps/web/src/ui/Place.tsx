/**
 * Напоминание по месту в карточке задачи: сохранённое место или «Где я сейчас», радиус, вход или выход, имя.
 * Карты и поиск адреса не используются: они отправили бы координаты чужому серверу.
 * Срабатывает напоминание только на телефоне с Android, на других устройствах его видно, но оно молчит.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_PLACE_RADIUS, PLACE_RADII, nearestPlace, type PlaceEvent, type PlaceReminder, type SavedPlace, type TaskView } from '#core';
import { currentPosition, placeStatus, platform, preparePlaces, setPlaceTracking, type PlaceStatus } from '../platform.ts';
import { useDoc } from '../hooks.ts';
import { tr } from '../i18n.ts';
import { IconX } from './icons.tsx';
import { showToast } from './toast.tsx';

const EVENTS: Array<[PlaceEvent, string]> = [
  ['arrive', tr('при входе')],
  ['leave', tr('при выходе')],
];

/** Подпись места: имя или координаты, если имени нет. */
export function placeLabel(p: Pick<PlaceReminder, 'name' | 'lat' | 'lon'>): string {
  return p.name || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
}

/** Состояние слежения на телефоне; обновляется, когда пользователь возвращается из системных настроек. */
function usePlaceStatus(): [PlaceStatus | null, (s: PlaceStatus | null) => void] {
  const [status, setStatus] = useState<PlaceStatus | null>(null);
  useEffect(() => {
    if (platform() !== 'capacitor') return;
    const load = () => void placeStatus().then(setStatus, () => undefined);
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return [status, setStatus];
}

const ASKED = 'placesAsked';

function askedBefore(): boolean {
  try {
    return localStorage.getItem(ASKED) === '1';
  } catch {
    return false;
  }
}

/**
 * Первое напоминание по месту на телефоне: объяснение, затем системные запросы геолокации.
 * Потом не спрашиваем сами: карточка показывает, чего не хватает, и кнопку «Разрешить».
 * force — пользователь нажал «Где я сейчас»: без разрешения координат не получить.
 */
async function askPermissions(status: PlaceStatus | null, force = false): Promise<PlaceStatus | null> {
  if (platform() !== 'capacitor') return null;
  if (status && status.location && status.precise && status.background) return status;
  if (!force && askedBefore()) return status;
  if (force && status?.location) return status;
  try {
    localStorage.setItem(ASKED, '1');
  } catch {
    // без localStorage объяснение покажется ещё раз
  }
  const ok = confirm(
    tr(
      'Чтобы напомнить у места, Dela должна знать, где телефон, даже когда приложение закрыто. Android спросит доступ к геолокации, затем откроет настройки: выберите «Разрешить всегда». Координаты остаются на телефоне, на сервер они уходят только зашифрованными внутри задачи.',
    ),
  );
  if (!ok) return status;
  return preparePlaces().catch(() => status);
}

export function PlaceField({ task }: { task: TaskView }) {
  const doc = useDoc();
  const [picking, setPicking] = useState(false);
  // Выбор места относится к открытой задаче: при переходе к другой он закрывается.
  useEffect(() => setPicking(false), [task.id]);
  const [locating, setLocating] = useState(false);
  const [status, setStatus] = usePlaceStatus();
  const place = task.place;
  const android = platform() === 'capacitor';
  const saved = doc.places();

  const set = (p: PlaceReminder | null) => doc.updateTask(task.id, { place: p });

  const choose = async (p: PlaceReminder) => {
    set(p);
    setPicking(false);
    setStatus(await askPermissions(status));
  };

  const here = async () => {
    setLocating(true);
    try {
      // На телефоне сначала разрешение: без него LocationManager не даст координаты.
      const st = await askPermissions(status, true);
      setStatus(st);
      if (android && !st?.location) {
        showToast(tr('Нет доступа к геолокации'));
        return;
      }
      const pos = await currentPosition();
      const known = nearestPlace(saved, pos.lat, pos.lon);
      set({ lat: pos.lat, lon: pos.lon, radius: known?.radius ?? DEFAULT_PLACE_RADIUS, on: place?.on ?? 'arrive', name: known?.name ?? '' });
      setPicking(false);
    } catch {
      showToast(tr('Не удалось узнать, где вы сейчас'));
    } finally {
      setLocating(false);
    }
  };

  const fromSaved = (s: SavedPlace) => void choose({ lat: s.lat, lon: s.lon, radius: s.radius, on: place?.on ?? 'arrive', name: s.name });

  return (
    <>
      <dt>{tr('По месту')}</dt>
      <dd className="place-field">
        {place && (
          <div className="place-current">
            <div className="row wrap">
              <span className="place-name" title={`${place.lat}, ${place.lon}`}>
                {placeLabel(place)}
              </span>
              <button className="icon small" onClick={() => set(null)} aria-label={tr('Убрать напоминание по месту')}>
                <IconX width={14} height={14} />
              </button>
            </div>
            <div className="row wrap">
              {EVENTS.map(([on, label]) => (
                <button key={on} className={`pill toggle c-green${place.on === on ? ' on' : ''}`} onClick={() => set({ ...place, on })}>
                  {label}
                </button>
              ))}
              {PLACE_RADII.map((r) => (
                <button key={r} className={`pill toggle c-blue${place.radius === r ? ' on' : ''}`} onClick={() => set({ ...place, radius: r })}>
                  {tr('{n} м', { n: r })}
                </button>
              ))}
            </div>
            <PlaceName place={place} onChange={(name) => set({ ...place, name })} />
            {place.name && !saved.some((s) => s.name === place.name && s.lat === place.lat && s.lon === place.lon) && (
              <button
                className="link"
                onClick={() => {
                  doc.savePlace({ name: place.name, lat: place.lat, lon: place.lon, radius: place.radius });
                  showToast(tr('Место «{name}» сохранено', { name: place.name }));
                }}
              >
                {tr('Сохранить место в список')}
              </button>
            )}
            {!android && <span className="muted">{tr('Сработает на телефоне с Android')}</span>}
            {android && status && <PlaceWarning status={status} onStatus={setStatus} />}
          </div>
        )}
        {place && !picking ? (
          <button className="link" onClick={() => setPicking(true)}>
            {tr('Другое место')}
          </button>
        ) : !place && !picking ? (
          <button className="link" onClick={() => setPicking(true)}>
            {tr('Добавить место')}
          </button>
        ) : (
          <div className="place-picker">
            <div className="row wrap">
              <button onClick={() => void here()} disabled={locating}>
                {locating ? tr('Определяю…') : tr('Где я сейчас')}
              </button>
              {saved.map((s) => (
                <span key={s.id} className="place-saved">
                  <button className="pill" onClick={() => fromSaved(s)}>
                    {s.name || placeLabel(s)}
                  </button>
                  <button
                    className="icon small"
                    aria-label={tr('Удалить место «{name}»', { name: s.name })}
                    onClick={() => confirm(tr('Удалить место «{name}» из списка? Напоминания задач останутся.', { name: s.name })) && doc.deletePlace(s.id)}
                  >
                    <IconX width={12} height={12} />
                  </button>
                </span>
              ))}
              <button className="link" onClick={() => setPicking(false)}>
                {tr('Отмена')}
              </button>
            </div>
          </div>
        )}
      </dd>
    </>
  );
}

function PlaceName({ place, onChange }: { place: PlaceReminder; onChange: (name: string) => void }) {
  const [draft, setDraft] = useState(place.name);
  useEffect(() => setDraft(place.name), [place.name]);
  const commit = () => draft.trim() !== place.name && onChange(draft.trim());
  return (
    <input
      className="place-name-input"
      value={draft}
      maxLength={100}
      placeholder={tr('Имя места: Дом, Работа, Магазин')}
      aria-label={tr('Имя места')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

/** Почему напоминание может не сработать на этом телефоне, и кнопка, которая это исправляет. */
function PlaceWarning({ status, onStatus }: { status: PlaceStatus; onStatus: (s: PlaceStatus | null) => void }) {
  if (!status.enabled) {
    return (
      <span className="muted">
        {tr('Слежение за местами выключено.')}{' '}
        <button className="link" onClick={() => void setPlaceTracking(true).then(onStatus)}>
          {tr('Включить')}
        </button>
      </span>
    );
  }
  if (!status.location || !status.precise || !status.background) {
    return (
      <span className="muted">
        {!status.location
          ? tr('Нет доступа к геолокации: напоминание не сработает.')
          : !status.precise
            ? tr('Разрешите точную геолокацию: по приблизительной зону в сотни метров не различить.')
            : tr('Без доступа «Разрешить всегда» слежение не возобновится после перезагрузки телефона.')}{' '}
        <button className="link" onClick={() => void preparePlaces(true).then(onStatus)}>
          {tr('Разрешить')}
        </button>
      </span>
    );
  }
  return null;
}
