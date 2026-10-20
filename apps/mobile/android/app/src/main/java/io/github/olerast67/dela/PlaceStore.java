package io.github.olerast67.dela;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Зоны напоминаний по месту: список из веб-части и состояние каждой зоны (внутри, снаружи).
 * Хранится в приватных настройках приложения: координаты не покидают телефон (резервное копирование выключено в манифесте),
 * на сервер они уходят только в зашифрованной записи задачи.
 */
final class PlaceStore {
    private static final String PREFS = "dela_places";

    private PlaceStore() {}

    static final class Zone {
        String taskId;
        String title;
        double lat;
        double lon;
        double radius;
        /** arrive или leave. */
        String on;
        String name;
        boolean alarm;
        int state = PlaceZones.UNKNOWN;

        /** Состояние зоны сбрасывается, если сменились точка, радиус или событие; название задачи на него не влияет. */
        String sig() {
            return taskId + "|" + lat + "|" + lon + "|" + radius + "|" + on;
        }

        JSONObject json() throws Exception {
            return new JSONObject().put("taskId", taskId).put("title", title).put("lat", lat).put("lon", lon)
                .put("radius", radius).put("on", on).put("name", name).put("alarm", alarm).put("state", state);
        }

        static Zone of(JSONObject o) {
            Zone z = new Zone();
            z.taskId = o.optString("taskId");
            z.title = o.optString("title");
            z.lat = o.optDouble("lat", Double.NaN);
            z.lon = o.optDouble("lon", Double.NaN);
            z.radius = o.optDouble("radius", 200);
            z.on = "leave".equals(o.optString("on")) ? "leave" : "arrive";
            z.name = o.optString("name");
            z.alarm = o.optBoolean("alarm", false);
            z.state = o.optInt("state", PlaceZones.UNKNOWN);
            return z;
        }

        boolean valid() {
            return !taskId.isEmpty() && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && radius > 0;
        }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized List<Zone> all(Context c) {
        List<Zone> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString("zones", "[]"));
            for (int i = 0; i < a.length(); i++) out.add(Zone.of(a.getJSONObject(i)));
        } catch (Exception ignored) {
            // испорченный список: приложение отдаст зоны заново при следующем пересчёте
        }
        return out;
    }

    static synchronized void save(Context c, List<Zone> list) {
        JSONArray a = new JSONArray();
        try {
            for (Zone z : list) a.put(z.json());
        } catch (Exception ignored) {
            // JSONObject.put бросает только на NaN, такие зоны отброшены в replace
        }
        prefs(c).edit().putString("zones", a.toString()).apply();
    }

    /** Заменить зоны списком из веб-части; состояние зон с той же точкой сохраняется, чтобы не сработать повторно. */
    static synchronized void replace(Context c, List<Zone> wanted) {
        Map<String, Integer> states = new HashMap<>();
        for (Zone z : all(c)) states.put(z.sig(), z.state);
        List<Zone> next = new ArrayList<>();
        for (Zone z : wanted) {
            if (!z.valid()) continue;
            Integer s = states.get(z.sig());
            z.state = s == null ? PlaceZones.UNKNOWN : s;
            next.add(z);
        }
        save(c, next);
    }

    /**
     * Применить новую точку ко всем зонам: обновить состояния и вернуть сработавшие.
     * Список читается заново под блокировкой: веб-часть могла заменить зоны, пока ждали точку.
     */
    static synchronized List<Zone> apply(Context c, double lat, double lon, double accuracy) {
        List<Zone> list = all(c);
        List<Zone> fired = new ArrayList<>();
        boolean changed = false;
        for (Zone z : list) {
            int n = PlaceZones.next(z.state, PlaceZones.distance(z.lat, z.lon, lat, lon), z.radius, accuracy);
            if (n == z.state) continue;
            if (PlaceZones.fires(z.on, z.state, n)) fired.add(z);
            z.state = n;
            changed = true;
        }
        if (changed) save(c, list);
        return fired;
    }

    /** Расстояние от точки до ближайшей границы зоны; NaN без зон. */
    static synchronized double nearestBoundary(Context c, double lat, double lon) {
        double best = Double.NaN;
        for (Zone z : all(c)) {
            double d = Math.abs(PlaceZones.distance(z.lat, z.lon, lat, lon) - z.radius);
            if (Double.isNaN(best) || d < best) best = d;
        }
        return best;
    }

    /** Пользователь выключил слежение кнопкой в уведомлении; включает снова карточка задачи. */
    static boolean enabled(Context c) {
        return prefs(c).getBoolean("enabled", true);
    }

    static void setEnabled(Context c, boolean on) {
        prefs(c).edit().putBoolean("enabled", on).apply();
    }
}
