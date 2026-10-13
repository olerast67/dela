/** Нижняя панель вкладок на телефоне. «Ещё» открывает боковую панель с проектами, метками и настройками. */
import { href, type Route } from '../hooks.ts';
import { haptic } from '../platform.ts';
import { IconCalendar, IconInbox, IconMore, IconToday, IconUpcoming } from './icons.tsx';

const TABS: ReadonlyArray<{ route: Route; label: string; icon: React.ReactNode }> = [
  { route: { view: 'today' }, label: 'Сегодня', icon: <IconToday width={24} height={24} /> },
  { route: { view: 'upcoming' }, label: 'Скоро', icon: <IconUpcoming width={24} height={24} /> },
  { route: { view: 'calendar', mode: null, date: null }, label: 'Календарь', icon: <IconCalendar width={24} height={24} /> },
  { route: { view: 'inbox' }, label: 'Входящие', icon: <IconInbox width={24} height={24} /> },
];

export function TabBar({ route, onMore }: { route: Route; onMore: () => void }) {
  const active = (r: Route) => r.view === route.view;
  const inTabs = TABS.some((t) => active(t.route));
  return (
    <nav className="tabbar" aria-label="Разделы">
      {TABS.map((t) => (
        <a key={t.label} href={href(t.route)} className={`tab${active(t.route) ? ' on' : ''}`} aria-current={active(t.route) ? 'page' : undefined} onClick={() => haptic('light')}>
          <span className="tab-icon">{t.icon}</span>
          {t.label}
        </a>
      ))}
      <button
        className={`tab${inTabs ? '' : ' on'}`}
        onClick={() => {
          haptic('light');
          onMore();
        }}
      >
        <span className="tab-icon">
          <IconMore width={24} height={24} />
        </span>
        Ещё
      </button>
    </nav>
  );
}
