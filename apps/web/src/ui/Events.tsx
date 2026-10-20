/**
 * События календарей поверх задач: список в «Сегодня», подробности по щелчку и настройки подписок.
 * События только для чтения: у них нет кружка выполнения, их нельзя перетащить, они не попадают
 * в поиск, фильтры и статистику задач.
 */
import { useEffect, useState } from 'react';
import { COLORS, eventsOnDay, normalizeCalendarUrl, wallClock, type CalEvent } from '#core';
import {
  deviceCalendars,
  deviceCalendarsSupported,
  devicePrefs,
  feedStatus,
  refreshCalendars,
  requestDeviceAccess,
  setDevicePrefs,
  useCalendarEvents,
  useCalendarsVersion,
  type DeviceCalendar,
  type FeedStatus,
} from '../calendars.ts';
import { TZ, clockLabel, dateLabel, timeLabel, todayDate } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { LOCALE, tr } from '../i18n.ts';
import { platform } from '../platform.ts';
import { IconCalendar, IconX } from './icons.tsx';

/** Цвет календаря для CSS: события красятся через --ec. */
export function eventStyle(e: CalEvent): React.CSSProperties {
  return { ['--ec' as string]: e.color };
}

function when(e: CalEvent): string {
  const today = todayDate();
  if (e.allDay) {
    const last = new Date(Date.parse(`${e.endDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const first = dateLabel(e.startDate, today);
    return last === e.startDate ? `${first}, ${tr('весь день')}` : `${first} - ${dateLabel(last, today)}`;
  }
  const s = wallClock(e.start, TZ);
  const f = wallClock(e.end, TZ);
  const start = `${dateLabel(s.date, today)}, ${timeLabel(s.time)}`;
  if (e.end <= e.start) return start;
  return s.date === f.date ? `${start}-${timeLabel(f.time)}` : `${start} - ${dateLabel(f.date, today)}, ${timeLabel(f.time)}`;
}

/** Подробности события: время, место, описание. Всё выводится текстом, HTML из календаря не исполняется. */
export function EventDetails({ event, onClose }: { event: CalEvent; onClose: () => void }) {
  const doc = useDoc();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const source = event.calendar.startsWith('device:') ? tr('Календарь телефона') : (doc.calendars().find((c) => c.id === event.calendar)?.name ?? '');
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette event-details" role="dialog" aria-label={tr('Событие календаря')} style={eventStyle(event)}>
        <div className="share-head">
          <h2 className="palette-title">
            <span className="event-swatch" aria-hidden="true" />
            {event.title || tr('Без названия')}
          </h2>
          <button className="icon" onClick={onClose} aria-label={tr('Закрыть')}>
            <IconX />
          </button>
        </div>
        <div className="event-body">
          <p>{when(event)}</p>
          {event.location && <p className="muted">{event.location}</p>}
          {event.description && <p className="event-desc">{event.description}</p>}
          {source && (
            <p className="muted event-source">
              <IconCalendar width={14} height={14} /> {source}
            </p>
          )}
          <p className="muted">{tr('Событие только для чтения: изменить его можно в самом календаре.')}</p>
        </div>
      </div>
    </div>
  );
}

/** События дня сверху «Сегодня»: время, название, цвет календаря. */
export function TodayEvents({ date }: { date: string }) {
  const events = useCalendarEvents(date, 1);
  const [open, setOpen] = useState<CalEvent | null>(null);
  const day = eventsOnDay(events, date, TZ);
  if (day.allDay.length + day.timed.length === 0) return null;
  const rows = [...day.allDay.map((e) => ({ e, label: tr('Весь день') })), ...day.timed.map((t) => ({ e: t.event as CalEvent, label: `${clockLabel(t.start)}-${clockLabel(t.end)}` }))];
  return (
    <section className="day-events" aria-label={tr('События календарей')}>
      {rows.map(({ e, label }) => (
        <button key={e.id} className="day-event" style={eventStyle(e)} onClick={() => setOpen(e)}>
          <IconCalendar width={15} height={15} className="day-event-icon" />
          <span className="day-event-time">{label}</span>
          <span className="day-event-title">{e.title || tr('Без названия')}</span>
        </button>
      ))}
      {open && <EventDetails event={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function statusText(s: FeedStatus | null, enabled: boolean): string {
  if (!enabled) return tr('Выключен');
  if (!s || (s.busy && !s.fetchedAt)) return tr('Загрузка…');
  if (s.error === 'cors') return tr('Календарь не разрешает загрузку из браузера. Подписка работает в приложениях Dela для Windows и Android.');
  if (s.error === 'http') return tr('Сервер календаря ответил ошибкой {n}. Проверьте ссылку.', { n: s.code ?? '' });
  if (s.error === 'parse') return tr('По ссылке не календарь iCal.');
  if (s.error === 'large') return tr('Календарь слишком большой.');
  if (s.error === 'network') return tr('Нет связи с сервером календаря.');
  if (s.fetchedAt) return tr('Обновлён в {t}', { t: new Date(s.fetchedAt).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) });
  return '';
}

/** Ссылка — секрет: в настройках видно только имя сервера. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function CalendarSettings() {
  const doc = useDoc();
  useCalendarsVersion();
  const subs = doc.calendars();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeCalendarUrl(url);
    if (!normalized) {
      setError(tr('Нужна ссылка https:// или webcal:// на календарь в формате iCal (.ics).'));
      return;
    }
    const color = COLORS.filter((c) => c !== 'gray')[subs.length % (COLORS.length - 1)]!;
    doc.addCalendar({ name: name.trim() || hostOf(normalized), url: normalized, color });
    setName('');
    setUrl('');
    setError(null);
  };

  return (
    <section className="settings calendar-settings">
      <h2>{tr('Календари')}</h2>
      <p className="muted">
        {tr('События календарей видны в «Сегодня» и в календаре поверх задач, только для чтения. Ссылка на календарь хранится зашифрованной и синхронизируется между вашими устройствами, а события каждое устройство загружает само, прямо с сервера календаря.')}
      </p>
      {platform() === 'web' && <p className="muted">{tr('В браузере подписка работает, только если календарь разрешает загрузку с других сайтов. Если нет, она заработает в приложениях Dela для Windows и Android.')}</p>}
      {subs.map((s) => (
        <div key={s.id} className="trash-row calendar-row">
          <span className="calendar-name">
            <span className={`event-swatch c-${s.color}`} aria-hidden="true" />
            <span>
              <b>{s.name}</b> <span className="muted">{hostOf(s.url)}</span>
              <br />
              <span className="muted calendar-status">{statusText(feedStatus(s.id), s.enabled)}</span>
            </span>
          </span>
          <span className="calendar-actions">
            <select value={s.color} onChange={(e) => doc.updateCalendar(s.id, { color: e.target.value })} aria-label={tr('Цвет календаря')}>
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="checkline">
              <input type="checkbox" checked={s.enabled} onChange={(e) => doc.updateCalendar(s.id, { enabled: e.target.checked })} />
              {tr('Показывать')}
            </label>
            <button onClick={() => confirm(tr('Отписаться от календаря «{name}»?', { name: s.name })) && doc.deleteCalendar(s.id)}>{tr('Удалить')}</button>
          </span>
        </div>
      ))}
      <form className="calendar-add" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('Название')} aria-label={tr('Название календаря')} maxLength={200} />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… .ics"
          aria-label={tr('Ссылка на календарь iCal')}
          autoComplete="off"
          spellCheck={false}
          type="url"
          inputMode="url"
        />
        <button type="submit" className="primary" disabled={!url.trim()}>
          {tr('Подписаться')}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <p className="muted">{tr('В Google Календаре это «Секретный адрес в формате iCal» в настройках календаря.')}</p>
      {subs.length > 0 && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await refreshCalendars().finally(() => setBusy(false));
          }}
        >
          {busy ? tr('Обновление…') : tr('Обновить календари')}
        </button>
      )}
      {deviceCalendarsSupported() && <DeviceCalendars />}
    </section>
  );
}

/** Календари телефона: включаются здесь, разрешение спрашивается при включении. Их события не покидают телефон. */
function DeviceCalendars() {
  const [prefs, setPrefs] = useState(devicePrefs);
  const [list, setList] = useState<DeviceCalendar[] | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (prefs.on) deviceCalendars().then(setList, () => setList([]));
  }, [prefs.on]);

  const save = (next: typeof prefs) => {
    setPrefs(next);
    setDevicePrefs(next);
  };

  return (
    <>
      <h2>{tr('Календари телефона')}</h2>
      <label className="checkline">
        <input
          type="checkbox"
          checked={prefs.on}
          onChange={async (e) => {
            if (!e.target.checked) return save({ ...prefs, on: false });
            const ok = await requestDeviceAccess().catch(() => false);
            setDenied(!ok);
            if (ok) save({ ...prefs, on: true });
          }}
        />
        {tr('Показывать события из календарей телефона')}
      </label>
      {denied && <p className="error">{tr('Нет доступа к календарю. Разрешите его Dela в настройках Android.')}</p>}
      <p className="muted">{tr('События календарей телефона остаются на этом телефоне и не синхронизируются.')}</p>
      {prefs.on &&
        list?.map((c) => {
          const checked = prefs.ids === null || prefs.ids.includes(c.id);
          return (
            <label key={c.id} className="checkline">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  const all = list.map((x) => x.id);
                  const current = prefs.ids ?? all;
                  const ids = e.target.checked ? [...current, c.id] : current.filter((x) => x !== c.id);
                  save({ ...prefs, ids: ids.length === all.length ? null : ids });
                }}
              />
              <span className="event-swatch" style={{ ['--ec' as string]: c.color }} aria-hidden="true" />
              {c.name} {c.account && <span className="muted">{c.account}</span>}
            </label>
          );
        })}
    </>
  );
}
