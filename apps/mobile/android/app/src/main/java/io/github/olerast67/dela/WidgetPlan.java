package io.github.olerast67.dela;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Режим «План» виджета: строки плана на сегодня из снимка, сдвиги «+15», нажатые на виджете
 * (до того как их применит приложение), дыры и текущее дело по часам телефона.
 * Обновление не раз в минуту, а на границах блоков: будильник без пробуждения телефона.
 */
final class WidgetPlan {
    static final String LIST = "plan";
    static final String ACTION_TICK = "io.github.olerast67.dela.WIDGET_PLAN_TICK";
    static final int DAY = 24 * 60;
    /** Минимальная дыра, как MIN_GAP в ядре. */
    private static final int MIN_GAP = 5;
    /** Внутри длинного блока остаток минут обновляется не реже, чем раз в столько минут. */
    private static final int LEFT_STEP = 5;

    private WidgetPlan() {}

    /** Строка плана: задача, событие календаря или дыра. */
    static final class Row {
        final char kind;
        final JSONObject task;
        final String title;
        int start;
        int end;
        final boolean fixed;

        Row(char kind, JSONObject task, String title, int start, int end, boolean fixed) {
            this.kind = kind;
            this.task = task;
            this.title = title;
            this.start = start;
            this.end = end;
            this.fixed = fixed;
        }

        String id() {
            return task == null ? "" : task.optString("id");
        }
    }

    static final class Plan {
        /** Дела и дыры, ещё не закончившиеся, по началу; текущее (если есть) первым. */
        final List<Row> rows = new ArrayList<>();
        Row current;
        /** Конец последнего дела плана (минуты) или -1: отсюда «+» и микрофон добавляют дальше. */
        int lastEnd = -1;
        /** Минута, когда план надо перерисовать, или -1. */
        int nextTick = -1;
    }

    static int minuteOf(long ms) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
    }

    static String hhmm(int minute) {
        int m = Math.max(0, Math.min(DAY - 1, minute));
        return String.format(java.util.Locale.US, "%02d:%02d", m / 60, m % 60);
    }

    /** План на сегодня или null, если снимок старый, другого дня или без плана. */
    static Plan build(Context c, JSONObject snap, long now) {
        if (snap == null) return null;
        String today = TasksWidgetService.day(0);
        if (!today.equals(snap.optString("planDate"))) return null;
        JSONArray plan = snap.optJSONArray("plan");
        if (plan == null) return null;
        Map<String, JSONObject> tasks = new HashMap<>();
        JSONArray ts = snap.optJSONArray("tasks");
        for (int i = 0; ts != null && i < ts.length(); i++) {
            JSONObject t = ts.optJSONObject(i);
            if (t != null) tasks.put(t.optString("id"), t);
        }
        Set<String> done = WidgetStore.completed(c);
        List<Row> items = new ArrayList<>();
        for (int i = 0; i < plan.length(); i++) {
            JSONObject r = plan.optJSONObject(i);
            if (r == null) continue;
            String k = r.optString("k");
            int s = r.optInt("s"), e = r.optInt("e");
            if ("t".equals(k)) {
                JSONObject t = tasks.get(r.optString("id"));
                if (t == null || done.contains(t.optString("id"))) continue;
                items.add(new Row('t', t, t.optString("t"), s, e, t.optBoolean("fx") || t.optBoolean("r")));
            } else if ("e".equals(k)) {
                items.add(new Row('e', null, r.optString("t"), s, e, true));
            }
            // Дыры («f») считаются заново: задачи, отмеченные на виджете, освобождают время.
        }
        sort(items);
        JSONArray shifts = WidgetStore.shifts(c);
        for (int i = 0; i < shifts.length(); i++) {
            JSONObject sh = shifts.optJSONObject(i);
            if (sh == null) continue;
            long at = sh.optLong("at");
            if (!today.equals(dateOf(at))) continue;
            shiftRest(items, minuteOf(at), sh.optInt("m"));
            sort(items);
        }

        Plan out = new Plan();
        int nm = minuteOf(now);
        List<Row> all = new ArrayList<>();
        int latest = -1;
        for (Row r : items) {
            if (latest >= 0 && r.start - latest >= MIN_GAP) all.add(new Row('f', null, null, latest, r.start, false));
            all.add(r);
            latest = Math.max(latest, Math.min(DAY, r.end));
        }
        for (Row r : items) if (r.kind == 't') out.lastEnd = Math.max(out.lastEnd, Math.min(DAY, r.end));
        for (Row r : all) {
            if (r.end <= nm) continue;
            if (out.current == null && r.kind != 'f' && r.start <= nm) out.current = r;
            else out.rows.add(r);
        }
        if (out.current != null) out.rows.add(0, out.current);

        int next = DAY;
        for (Row r : all) {
            if (r.start > nm) next = Math.min(next, r.start);
            if (r.end > nm) next = Math.min(next, r.end);
        }
        // Остаток минут у текущего дела или дыры: не реже раза в LEFT_STEP минут.
        for (Row r : all) if (r.start <= nm && r.end > nm) next = Math.min(next, nm + LEFT_STEP);
        out.nextTick = next;
        return out;
    }

    private static void sort(List<Row> items) {
        Collections.sort(items, (a, b) -> a.start != b.start ? a.start - b.start : a.end != b.end ? a.end - b.end : a.id().compareTo(b.id()));
    }

    private static String dateOf(long ms) {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(new java.util.Date(ms));
    }

    /**
     * То же, что shiftRest в ядре: невыполненные подвижные блоки, которые ещё не закончились, сдвигаются на minutes;
     * дыры поглощают сдвиг, пересекавшиеся блоки сохраняют смещение, налезший на неподвижный блок встаёт после него,
     * не влезший до 24:00 и все после него остаются на месте.
     */
    static void shiftRest(List<Row> items, int now, int minutes) {
        if (minutes <= 0) return;
        List<Row> blocks = new ArrayList<>();
        List<Row> movable = new ArrayList<>();
        for (Row r : items) {
            if (r.fixed) blocks.add(r);
            else if (r.end > now) movable.add(r);
        }
        int prevOrigStart = 0, prevOrigEnd = 0, prevStart = 0, prevEnd = 0;
        boolean hasPrev = false;
        for (Row e : movable) {
            int d = e.end - e.start;
            int t = e.start + minutes;
            if (hasPrev) t = e.start >= prevOrigEnd ? Math.max(t, prevEnd) : Math.max(t, prevStart + (e.start - prevOrigStart));
            t = fitAt(t, d, blocks);
            if (t + d > DAY) return;
            prevOrigStart = e.start;
            prevOrigEnd = e.end;
            e.start = t;
            e.end = t + d;
            prevStart = e.start;
            prevEnd = e.end;
            hasPrev = true;
        }
    }

    private static int fitAt(int from, int d, List<Row> blocks) {
        int t = from;
        for (boolean moved = true; moved; ) {
            moved = false;
            for (Row b : blocks) {
                if (b.start < t + d && b.end > t) {
                    t = b.end;
                    moved = true;
                }
            }
        }
        return t;
    }

    /** Есть ли виджет в режиме «План». */
    static boolean anyPlanWidget(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (int id : m.getAppWidgetIds(new ComponentName(c, TasksWidgetProvider.class))) {
            if (LIST.equals(WidgetStore.config(c, id).list)) return true;
        }
        return false;
    }

    /**
     * Следующая перерисовка: ближайшая граница блока, шаг остатка минут или полночь.
     * Будильник RTC без пробуждения: при выключенном экране виджет никто не видит, перерисовка придёт при включении.
     */
    static void schedule(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(c, WidgetActionReceiver.class).setAction(ACTION_TICK);
        PendingIntent pi = PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (!anyPlanWidget(c)) {
            am.cancel(pi);
            return;
        }
        long now = System.currentTimeMillis();
        Plan plan = build(c, WidgetStore.snapshot(c), now);
        int minute = plan == null || plan.nextTick < 0 ? DAY : plan.nextTick;
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(now);
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        cal.add(Calendar.MINUTE, minute);
        long at = Math.max(now + 1000, cal.getTimeInMillis() + 1000);
        if (AlarmStore.canSchedule(c)) am.setExact(AlarmManager.RTC, at, pi);
        else am.setWindow(AlarmManager.RTC, at, 60_000, pi);
    }
}
