package io.github.olerast67.dela;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Данные виджета на телефоне: снимок задач от веб-клиента, настройки каждого виджета
 * и очередь задач, отмеченных выполненными прямо на виджете (их применяет приложение).
 */
final class WidgetStore {
    private static final String PREFS = "dela_widget";

    private WidgetStore() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void setSnapshot(Context c, String json) {
        prefs(c).edit().putString("snapshot", json).apply();
    }

    static JSONObject snapshot(Context c) {
        String raw = prefs(c).getString("snapshot", null);
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    static Set<String> completed(Context c) {
        return new HashSet<>(prefs(c).getStringSet("completed", new HashSet<>()));
    }

    static void addCompleted(Context c, String id) {
        Set<String> s = completed(c);
        s.add(id);
        prefs(c).edit().putStringSet("completed", s).apply();
    }

    static List<String> takeCompleted(Context c) {
        List<String> out = new ArrayList<>(completed(c));
        prefs(c).edit().remove("completed").apply();
        return out;
    }

    /** Настройки одного виджета. */
    static final class Config {
        String list = "today";
        String theme = "system";
        int opacity = 100;
        boolean large = false;
        boolean compact = false;
        boolean hideWhenLocked = true;
    }

    static Config config(Context c, int widgetId) {
        SharedPreferences p = prefs(c);
        Config cfg = new Config();
        String k = "w" + widgetId + ".";
        cfg.list = p.getString(k + "list", cfg.list);
        cfg.theme = p.getString(k + "theme", cfg.theme);
        cfg.opacity = p.getInt(k + "opacity", cfg.opacity);
        cfg.large = p.getBoolean(k + "large", cfg.large);
        cfg.compact = p.getBoolean(k + "compact", cfg.compact);
        cfg.hideWhenLocked = p.getBoolean(k + "hideWhenLocked", cfg.hideWhenLocked);
        return cfg;
    }

    static void saveConfig(Context c, int widgetId, Config cfg) {
        String k = "w" + widgetId + ".";
        prefs(c).edit()
            .putString(k + "list", cfg.list)
            .putString(k + "theme", cfg.theme)
            .putInt(k + "opacity", cfg.opacity)
            .putBoolean(k + "large", cfg.large)
            .putBoolean(k + "compact", cfg.compact)
            .putBoolean(k + "hideWhenLocked", cfg.hideWhenLocked)
            .apply();
    }

    static void deleteConfig(Context c, int widgetId) {
        String k = "w" + widgetId + ".";
        SharedPreferences.Editor e = prefs(c).edit();
        for (String key : prefs(c).getAll().keySet()) if (key.startsWith(k)) e.remove(key);
        e.apply();
    }

    static boolean dark(Context c, Config cfg) {
        if ("dark".equals(cfg.theme)) return true;
        if ("light".equals(cfg.theme)) return false;
        return (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** Название списка для заголовка: «Сегодня», «Неделя», имя проекта. */
    static String listTitle(Context c, String list) {
        if ("today".equals(list)) return c.getString(R.string.list_today);
        if ("week".equals(list)) return c.getString(R.string.list_week);
        JSONObject snap = snapshot(c);
        if (snap != null && list.startsWith("project:")) {
            JSONArray projects = snap.optJSONArray("projects");
            String id = list.substring(8);
            for (int i = 0; projects != null && i < projects.length(); i++) {
                JSONObject p = projects.optJSONObject(i);
                if (p != null && id.equals(p.optString("id"))) return p.optString("name");
            }
        }
        return "Dela";
    }

    /** Перерисовать все виджеты после нового снимка или отметки «выполнено». */
    static void refreshAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, TasksWidgetProvider.class));
        for (int id : ids) TasksWidgetProvider.update(c, m, id);
        m.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }
}
