import { useState } from 'react';
import { dateParts, describeRule, firstOnOrAfter, formatRule, isoWeekday, parseRule, type DateSpec, type Freq, type Recurrence, type Rule } from '#core';
import { LANG, tn, tr } from '../i18n.ts';

const FREQS: ReadonlyArray<readonly [Freq, string]> = [
  ['DAILY', tr('День')],
  ['WEEKLY', tr('Неделя')],
  ['MONTHLY', tr('Месяц')],
  ['YEARLY', tr('Год')],
];
const WEEKDAYS: ReadonlyArray<readonly [string, string]> = [
  [tr('Пн'), tr('Понедельник')],
  [tr('Вт'), tr('Вторник')],
  [tr('Ср'), tr('Среда')],
  [tr('Чт'), tr('Четверг')],
  [tr('Пт'), tr('Пятница')],
  [tr('Сб'), tr('Суббота')],
  [tr('Вс'), tr('Воскресенье')],
];

interface Form {
  freq: Freq;
  interval: number;
  days: number[];
  /** Число месяца; −1 — последний день. */
  monthDay: number;
  until: string;
  completion: boolean;
}

/** Начальные значения: из текущего правила, а без него из даты срока (как сделал бы разбор фразы). */
function initialForm(recurrence: Recurrence | null, anchor: string): Form {
  const rule = recurrence ? parseRule(recurrence.rule) : null;
  const md = rule?.byMonthDay?.length === 1 ? rule.byMonthDay[0]! : null;
  return {
    freq: rule?.freq ?? 'WEEKLY',
    interval: rule?.interval ?? 1,
    days: rule?.freq === 'WEEKLY' && rule.byDay?.length ? [...new Set(rule.byDay.map((d) => d.day))].sort((a, b) => a - b) : [isoWeekday(anchor)],
    monthDay: rule?.freq === 'MONTHLY' && md !== null && (md > 0 || md === -1) ? md : dateParts(anchor).day,
    until: rule?.until ?? '',
    completion: recurrence?.mode === 'completion',
  };
}

/**
 * Правило из формы. Явные поля заполняются так же, как при разборе фразы в parse.ts:
 * неделя без дней — день срока, месяц — число, год — месяц и число срока, чтобы серия не «дрейфовала».
 */
function buildRule(f: Form, anchor: string, prev: Rule | null): Rule {
  const rule: { -readonly [K in keyof Rule]: Rule[K] } = { freq: f.freq, interval: Math.max(1, Math.min(999, Math.round(f.interval) || 1)) };
  if (f.freq === 'WEEKLY') rule.byDay = (f.days.length ? [...f.days].sort((a, b) => a - b) : [isoWeekday(anchor)]).map((day) => ({ day }));
  if (f.freq === 'MONTHLY') rule.byMonthDay = [f.monthDay];
  if (f.freq === 'YEARLY') {
    // Годовое правило из фразы («каждое 15 ноября») сохраняется; иначе берётся дата срока.
    if (prev?.freq === 'YEARLY' && (prev.byMonth?.length || prev.byMonthDay?.length || prev.byDay?.length)) {
      if (prev.byMonth?.length) rule.byMonth = prev.byMonth;
      if (prev.byMonthDay?.length) rule.byMonthDay = prev.byMonthDay;
      if (prev.byDay?.length) rule.byDay = prev.byDay;
    } else {
      rule.byMonth = [dateParts(anchor).month];
      rule.byMonthDay = [dateParts(anchor).day];
    }
  }
  if (f.until) rule.until = f.until;
  return rule;
}

/** Слово единицы после числа: «каждые 3 [дня]». */
function unitWord(freq: Freq, n: number): string {
  const forms: Readonly<Record<Freq, readonly [string, string, string]>> = {
    DAILY: ['день', 'дня', 'дней'],
    WEEKLY: ['неделю', 'недели', 'недель'],
    MONTHLY: ['месяц', 'месяца', 'месяцев'],
    YEARLY: ['год', 'года', 'лет'],
  };
  return tn(n, ...forms[freq]).replace(/^\d+\s/, '');
}

/**
 * Повтор кнопками: частота, интервал, дни недели, число месяца, окончание и режим.
 * Даёт тот же объект повтора, что и текстовая фраза, и ставит срок на первый экземпляр
 * не раньше даты срока (или сегодня), сохраняя время.
 */
export function RepeatEditor({
  recurrence,
  due,
  today,
  onApply,
  onCancel,
  onError,
}: {
  recurrence: Recurrence | null;
  due: DateSpec | null;
  today: string;
  onApply: (recurrence: Recurrence, due: DateSpec) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const anchor = due?.date ?? today;
  const [f, setF] = useState<Form>(() => initialForm(recurrence, anchor));
  const set = (patch: Partial<Form>) => setF((cur) => ({ ...cur, ...patch }));

  function apply() {
    const rule = buildRule(f, anchor, recurrence ? parseRule(recurrence.rule) : null);
    const first = firstOnOrAfter(rule, anchor, anchor);
    if (!first) {
      onError(tr('Дата окончания раньше первого повтора'));
      return;
    }
    onApply(
      { rule: formatRule(rule), mode: f.completion ? 'completion' : 'schedule', text: describeRule(rule, LANG) },
      { date: first, ...(due?.time ? { time: due.time } : {}), ...(due?.time && due.tz ? { tz: due.tz } : {}) },
    );
  }

  return (
    <div className="repeat-editor" role="group" aria-label={tr('Настройка повтора')}>
      <div className="segmented" role="group" aria-label={tr('Частота')}>
        {FREQS.map(([freq, label]) => (
          <button key={freq} className={f.freq === freq ? 'active' : ''} aria-pressed={f.freq === freq} onClick={() => set({ freq })}>
            {label}
          </button>
        ))}
      </div>

      <label className="row">
        {tr('Каждые')}
        <input
          type="number"
          className="repeat-interval"
          min={1}
          max={999}
          value={f.interval}
          onChange={(e) => set({ interval: Number(e.target.value) })}
          aria-label={tr('Интервал')}
        />
        {unitWord(f.freq, Math.max(1, f.interval || 1))}
      </label>

      {f.freq === 'WEEKLY' && (
        <div className="row wrap" role="group" aria-label={tr('Дни недели')}>
          {WEEKDAYS.map(([short, long], i) => {
            const day = i + 1;
            const on = f.days.includes(day);
            return (
              <button
                key={day}
                className={`pill toggle c-blue${on ? ' on' : ''}`}
                aria-pressed={on}
                aria-label={long}
                onClick={() => set({ days: on ? f.days.filter((d) => d !== day) : [...f.days, day] })}
              >
                {short}
              </button>
            );
          })}
        </div>
      )}

      {f.freq === 'MONTHLY' && (
        <label className="row">
          {tr('Число месяца')}
          <select value={f.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })} aria-label={tr('Число месяца')}>
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
            <option value={-1}>{tr('последний день')}</option>
          </select>
        </label>
      )}

      {f.freq === 'YEARLY' && <span className="muted">{tr('В тот же день, что и срок')}</span>}

      <div className="row wrap">
        {tr('Окончание')}
        <div className="segmented" role="group" aria-label={tr('Окончание')}>
          <button className={f.until ? '' : 'active'} aria-pressed={!f.until} onClick={() => set({ until: '' })}>
            {tr('Никогда')}
          </button>
          <button className={f.until ? 'active' : ''} aria-pressed={Boolean(f.until)} onClick={() => !f.until && set({ until: anchor })}>
            {tr('До даты')}
          </button>
        </div>
        {f.until && <input type="date" value={f.until} onChange={(e) => e.target.value && set({ until: e.target.value })} aria-label={tr('Дата окончания')} />}
      </div>

      <div className="segmented" role="group" aria-label={tr('Режим повтора')}>
        <button className={f.completion ? '' : 'active'} aria-pressed={!f.completion} onClick={() => set({ completion: false })}>
          {tr('По расписанию')}
        </button>
        <button className={f.completion ? 'active' : ''} aria-pressed={f.completion} onClick={() => set({ completion: true })}>
          {tr('От выполнения')}
        </button>
      </div>

      <div className="row">
        <button className="primary" onClick={apply}>
          {tr('Сохранить')}
        </button>
        <button onClick={onCancel}>{tr('Отмена')}</button>
      </div>
    </div>
  );
}
