package io.github.olerast67.dela;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Строки списка виджета: разделы («Просрочено», дни недели) и задачи. */
public class TasksWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext(), intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0));
    }

    private static final class Item {
        final String header;
        final JSONObject task;
        final boolean overdue;

        Item(String header, JSONObject task, boolean overdue) {
            this.header = header;
            this.task = task;
            this.overdue = overdue;
        }
    }

    private static final Map<String, Integer> COLORS = new HashMap<>();

    static {
        COLORS.put("gray", 0xFF8A918C);
        COLORS.put("red", 0xFFD1453B);
        COLORS.put("orange", 0xFFE07B1A);
        COLORS.put("yellow", 0xFFC9A227);
        COLORS.put("green", 0xFF2E7D5B);
        COLORS.put("teal", 0xFF1F8A8A);
        COLORS.put("blue", 0xFF3B6FD8);
        COLORS.put("violet", 0xFF7A5BD1);
        COLORS.put("pink", 0xFFC94F8A);
        COLORS.put("brown", 0xFF8A6343);
    }

    static String day(int offset) {
        Calendar c = Calendar.getInstance();
        c.add(Calendar.DAY_OF_MONTH, offset);
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(c.getTime());
    }

    private static Calendar parse(String date) {
        Calendar c = Calendar.getInstance();
        try {
            c.setTime(new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(date));
        } catch (Exception ignored) {
            // дата из снимка всегда в этом формате
        }
        return c;
    }

    static String dayMonth(Context c, String date) {
        Calendar cal = parse(date);
        String month = c.getResources().getStringArray(R.array.months_short)[cal.get(Calendar.MONTH)];
        return c.getString(R.string.day_month, cal.get(Calendar.DAY_OF_MONTH), month);
    }

    static String dateLabel(Context c, String date) {
        if (date.equals(day(0))) return c.getString(R.string.day_today);
        if (date.equals(day(1))) return c.getString(R.string.day_tomorrow);
        if (date.equals(day(-1))) return c.getString(R.string.day_yesterday);
        if (date.compareTo(day(0)) > 0 && date.compareTo(day(6)) <= 0) {
            return c.getResources().getStringArray(R.array.weekdays_short)[parse(date).get(Calendar.DAY_OF_WEEK) - 1];
        }
        return dayMonth(c, date);
    }

    static String dayHeading(Context c, String date) {
        String weekday = c.getResources().getStringArray(R.array.weekdays_long)[parse(date).get(Calendar.DAY_OF_WEEK) - 1];
        String base = dayMonth(c, date) + " · " + weekday;
        if (date.equals(day(0))) return c.getString(R.string.day_today) + " · " + base;
        if (date.equals(day(1))) return c.getString(R.string.day_tomorrow) + " · " + base;
        return base;
    }

    private static final class Factory implements RemoteViewsFactory {
        private final Context context;
        private final int widgetId;
        private final List<Item> items = new ArrayList<>();
        private final Map<String, JSONObject> projects = new HashMap<>();
        private WidgetStore.Config cfg;
        private boolean dark;

        Factory(Context context, int widgetId) {
            this.context = context;
            this.widgetId = widgetId;
        }

        @Override
        public void onCreate() {}

        @Override
        public void onDestroy() {}

        @Override
        public void onDataSetChanged() {
            items.clear();
            projects.clear();
            cfg = WidgetStore.config(context, widgetId);
            dark = WidgetStore.dark(context, cfg);
            JSONObject snap = WidgetStore.snapshot(context);
            if (snap == null || (snap.optBoolean("lock") && cfg.hideWhenLocked)) return;
            JSONArray ps = snap.optJSONArray("projects");
            for (int i = 0; ps != null && i < ps.length(); i++) {
                JSONObject p = ps.optJSONObject(i);
                if (p != null) projects.put(p.optString("id"), p);
            }
            Set<String> done = WidgetStore.completed(context);
            List<JSONObject> tasks = new ArrayList<>();
            JSONArray ts = snap.optJSONArray("tasks");
            for (int i = 0; ts != null && i < ts.length(); i++) {
                JSONObject t = ts.optJSONObject(i);
                if (t != null && !done.contains(t.optString("id"))) tasks.add(t);
            }
            String today = day(0);
            if ("today".equals(cfg.list) || "week".equals(cfg.list)) {
                int days = "today".equals(cfg.list) ? 1 : 7;
                String last = day(days - 1);
                List<JSONObject> overdue = new ArrayList<>();
                List<JSONObject> dated = new ArrayList<>();
                for (JSONObject t : tasks) {
                    String d = t.optString("d", "");
                    if (t.isNull("d") || d.isEmpty()) continue;
                    if (d.compareTo(today) < 0) overdue.add(t);
                    else if (d.compareTo(last) <= 0) dated.add(t);
                }
                Collections.sort(overdue, (a, b) -> key(a).compareTo(key(b)));
                Collections.sort(dated, (a, b) -> key(a).compareTo(key(b)));
                if (!overdue.isEmpty()) {
                    items.add(new Item(context.getString(R.string.overdue), null, false));
                    for (JSONObject t : overdue) items.add(new Item(null, t, true));
                }
                String current = null;
                for (JSONObject t : dated) {
                    String d = t.optString("d");
                    if (!d.equals(current) && (days > 1 || !overdue.isEmpty())) items.add(new Item(dayHeading(context, d), null, false));
                    current = d;
                    items.add(new Item(null, t, false));
                }
            } else if (cfg.list.startsWith("project:")) {
                String id = cfg.list.substring(8);
                for (JSONObject t : tasks) if (id.equals(t.optString("p"))) items.add(new Item(null, t, false));
            }
        }

        /** Порядок: дата, задачи со временем раньше задач на весь день, затем приоритет. */
        private static String key(JSONObject t) {
            String time = t.isNull("tm") ? "99:99" : t.optString("tm", "99:99");
            return t.optString("d") + " " + time + " " + t.optInt("pr", 4);
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position >= items.size()) return null;
            Item item = items.get(position);
            int text = dark ? 0xFFEFEAE0 : 0xFF25221C;
            int muted = dark ? 0xFFA49D8F : 0xFF766F63;
            if (item.header != null) {
                RemoteViews h = new RemoteViews(context.getPackageName(), R.layout.widget_section);
                h.setTextViewText(R.id.section_title, item.header);
                h.setTextColor(R.id.section_title, text);
                h.setTextViewTextSize(R.id.section_title, TypedValue.COMPLEX_UNIT_SP, cfg.large ? 15 : 13.5f);
                return h;
            }
            JSONObject t = item.task;
            RemoteViews r = new RemoteViews(context.getPackageName(), cfg.compact ? R.layout.widget_row_compact : R.layout.widget_row);
            r.setTextViewText(R.id.row_title, t.optString("t").isEmpty() ? context.getString(R.string.untitled) : t.optString("t"));
            r.setTextColor(R.id.row_title, text);
            r.setTextViewTextSize(R.id.row_title, TypedValue.COMPLEX_UNIT_SP, cfg.large ? 17.5f : 15.5f);
            int pr = t.optInt("pr", 4);
            r.setImageViewResource(
                R.id.row_check,
                pr == 1 ? R.drawable.widget_check_p1 : pr == 2 ? R.drawable.widget_check_p2 : pr == 3 ? R.drawable.widget_check_p3 : R.drawable.widget_check_p4
            );

            // Срок: в «Сегодня» только время, иначе дата и время; просроченное красным.
            String d = t.isNull("d") ? "" : t.optString("d", "");
            String time = t.isNull("tm") ? "" : t.optString("tm", "");
            String due;
            if (d.isEmpty()) due = "";
            else if ("today".equals(cfg.list) && d.equals(day(0))) due = time;
            else due = (dateLabel(context, d) + " " + time).trim();
            if (t.optBoolean("r") && !due.isEmpty()) due = due + " ↻";
            r.setTextViewText(R.id.row_due, due);
            r.setTextColor(R.id.row_due, item.overdue ? (dark ? 0xFFF07A68 : 0xFFC8402F) : (dark ? 0xFF6FCF9B : 0xFF2E7D5B));
            r.setViewVisibility(R.id.row_due, due.isEmpty() ? View.GONE : View.VISIBLE);

            JSONObject p = projects.get(t.optString("p"));
            if (p != null && !cfg.list.startsWith("project:")) {
                SpannableString s = new SpannableString("● " + p.optString("name"));
                Integer color = COLORS.get(p.optString("color"));
                s.setSpan(new ForegroundColorSpan(color == null ? 0xFF8A918C : color), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                r.setTextViewText(R.id.row_project, s);
                r.setTextColor(R.id.row_project, muted);
                r.setViewVisibility(R.id.row_project, View.VISIBLE);
            } else r.setViewVisibility(R.id.row_project, View.GONE);
            r.setInt(R.id.row_divider, "setBackgroundColor", dark ? 0xFF36332D : 0xFFE6DFD1);

            Intent open = new Intent();
            open.putExtra(TasksWidgetProvider.EXTRA_OP, "open");
            open.putExtra(TasksWidgetProvider.EXTRA_TASK, t.optString("id"));
            r.setOnClickFillInIntent(R.id.row_root, open);
            Intent complete = new Intent();
            complete.putExtra(TasksWidgetProvider.EXTRA_OP, "complete");
            complete.putExtra(TasksWidgetProvider.EXTRA_TASK, t.optString("id"));
            r.setOnClickFillInIntent(R.id.row_check, complete);
            return r;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 3;
        }

        @Override
        public long getItemId(int position) {
            Item item = items.get(position);
            return item.task != null ? item.task.optString("id").hashCode() : ("h" + item.header).hashCode();
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }
    }
}
