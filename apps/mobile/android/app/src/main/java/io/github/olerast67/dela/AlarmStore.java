package io.github.olerast67.dela;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Будильники срочных задач: список хранится в настройках приложения (после перезагрузки телефона
 * его ставят заново), а сами будильники — в AlarmManager.setAlarmClock: точное время, срабатывает и в Doze.
 * Ключ будильника — ключ напоминания из веб-части; по нему служба push не показывает то же напоминание второй раз.
 */
final class AlarmStore {
    private static final String PREFS = "dela_alarm";
    static final String ACTION_FIRE = "io.github.olerast67.dela.ALARM_FIRE";
    static final String EXTRA_KEY = "dela.alarmKey";
    /** Отложенный звонок хранится под ключом напоминания с этим окончанием. */
    private static final String SNOOZE = "#snooze";
    /** Сколько помнить прозвеневшие будильники: push того же напоминания может прийти с опозданием. */
    private static final long FIRED_TTL = 2 * 24 * 3600_000L;

    private AlarmStore() {}

    static final class Alarm {
        String key;
        long at;
        String title;
        String taskId;
        boolean snooze;

        JSONObject json() throws Exception {
            return new JSONObject().put("key", key).put("at", at).put("title", title).put("taskId", taskId).put("snooze", snooze);
        }

        static Alarm of(JSONObject o) {
            Alarm a = new Alarm();
            a.key = o.optString("key");
            a.at = o.optLong("at");
            a.title = o.optString("title");
            a.taskId = o.optString("taskId");
            a.snooze = o.optBoolean("snooze", false);
            return a;
        }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized List<Alarm> all(Context c) {
        List<Alarm> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString("alarms", "[]"));
            for (int i = 0; i < a.length(); i++) out.add(Alarm.of(a.getJSONObject(i)));
        } catch (Exception ignored) {
            // испорченный список: приложение поставит будильники заново при следующем пересчёте
        }
        return out;
    }

    private static void save(Context c, List<Alarm> list) {
        JSONArray a = new JSONArray();
        try {
            for (Alarm x : list) a.put(x.json());
        } catch (Exception ignored) {
            // JSONObject.put бросает только на NaN
        }
        prefs(c).edit().putString("alarms", a.toString()).apply();
    }

    /** Можно ли ставить точные будильники: на Android 12 это разрешение пользователь может отозвать. */
    static boolean canSchedule(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    private static PendingIntent firePending(Context c, String key, int flags) {
        Intent i = new Intent(c, AlarmReceiver.class).setAction(ACTION_FIRE).putExtra(EXTRA_KEY, key);
        // Свой адрес у каждого будильника: иначе Android счёл бы их одним PendingIntent.
        i.setData(Uri.parse("dela-alarm://fire/" + Uri.encode(key)));
        return PendingIntent.getBroadcast(c, DelaPushService.notificationId(key), i, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void schedule(Context c, Alarm a) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null || !canSchedule(c)) return;
        // Нажатие на значок будильника в шторке открывает задачу.
        Intent show = new Intent(c, MainActivity.class).putExtra(WidgetBridgePlugin.EXTRA_TASK_ID, a.taskId);
        show.setData(Uri.parse("dela-alarm://show/" + Uri.encode(a.key)));
        PendingIntent showPi = PendingIntent.getActivity(c, DelaPushService.notificationId(a.key), show, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(a.at, showPi), firePending(c, a.key, PendingIntent.FLAG_UPDATE_CURRENT));
        } catch (SecurityException ignored) {
            // разрешение на точные будильники отозвано
        }
    }

    private static void cancel(Context c, String key) {
        PendingIntent pi = firePending(c, key, PendingIntent.FLAG_NO_CREATE);
        if (pi == null) return;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pi);
        pi.cancel();
    }

    /**
     * Заменить будильники списком из веб-части. Отложенные звонки остаются, пока задача открыта и с флагом;
     * наступившие, но ещё не доставленные Android будильники не снимаются: иначе пересчёт в ту же секунду съел бы звонок.
     */
    static synchronized void replace(Context c, List<Alarm> wanted, Set<String> active) {
        Map<String, Alarm> next = new LinkedHashMap<>();
        for (Alarm a : wanted) next.put(a.key, a);
        long now = System.currentTimeMillis();
        List<Alarm> result = new ArrayList<>();
        for (Alarm old : all(c)) {
            if (next.containsKey(old.key)) continue;
            boolean keep = active.contains(old.taskId) && old.at > now - 10 * 60_000L && (old.snooze || old.at <= now);
            if (keep) result.add(old);
            else cancel(c, old.key);
        }
        for (Alarm a : next.values()) {
            schedule(c, a);
            result.add(a);
        }
        save(c, result);
    }

    /** После перезагрузки или обновления приложения: будильники AlarmManager при этом пропадают. */
    static synchronized void rescheduleAll(Context c) {
        long now = System.currentTimeMillis();
        List<Alarm> keep = new ArrayList<>();
        for (Alarm a : all(c)) {
            // Пропущенный, пока телефон был выключен, звонит сразу, если опоздание не больше 10 минут.
            if (a.at <= now - 10 * 60_000L) continue;
            if (a.at <= now) a.at = now + 2000;
            schedule(c, a);
            keep.add(a);
        }
        save(c, keep);
    }

    /** Будильник сработал: убрать из списка и запомнить ключ. null — его уже сняли. */
    static synchronized Alarm take(Context c, String key) {
        List<Alarm> list = all(c);
        Alarm found = null;
        for (Iterator<Alarm> it = list.iterator(); it.hasNext(); ) {
            Alarm a = it.next();
            if (a.key.equals(key)) {
                found = a;
                it.remove();
            }
        }
        if (found == null) return null;
        save(c, list);
        markFired(c, found.snooze ? key.substring(0, key.length() - SNOOZE.length()) : key);
        return found;
    }

    /** Отложить звонок на 10 минут. */
    static synchronized void snooze(Context c, String key, String title, String taskId) {
        Alarm a = new Alarm();
        a.key = key.endsWith(SNOOZE) ? key : key + SNOOZE;
        a.at = System.currentTimeMillis() + 10 * 60_000L;
        a.title = title;
        a.taskId = taskId;
        a.snooze = true;
        List<Alarm> list = all(c);
        for (Iterator<Alarm> it = list.iterator(); it.hasNext(); ) if (it.next().key.equals(a.key)) it.remove();
        list.add(a);
        schedule(c, a);
        save(c, list);
    }

    /**
     * Срочное напоминание пришло через push, а будильника в телефоне нет (задачу добавили на другом устройстве,
     * пока приложение было закрыто): звонок через секунду.
     */
    static synchronized void ringSoon(Context c, String key, String title, String taskId) {
        Alarm a = new Alarm();
        a.key = key;
        a.at = System.currentTimeMillis() + 1000;
        a.title = title;
        a.taskId = taskId;
        List<Alarm> list = all(c);
        list.add(a);
        schedule(c, a);
        save(c, list);
    }

    private static void markFired(Context c, String key) {
        long now = System.currentTimeMillis();
        JSONObject fired;
        try {
            fired = new JSONObject(prefs(c).getString("fired", "{}"));
        } catch (Exception e) {
            fired = new JSONObject();
        }
        JSONObject out = new JSONObject();
        try {
            for (Iterator<String> it = fired.keys(); it.hasNext(); ) {
                String k = it.next();
                if (fired.optLong(k) > now - FIRED_TTL) out.put(k, fired.optLong(k));
            }
            out.put(key, now);
        } catch (Exception ignored) {
            // ключи — строки, put не бросает
        }
        prefs(c).edit().putString("fired", out.toString()).apply();
    }

    /** Будильник этого напоминания стоит, отложен или уже прозвенел: обычное уведомление о нём не нужно. */
    static synchronized boolean known(Context c, String key) {
        for (Alarm a : all(c)) if (a.key.equals(key) || a.key.equals(key + SNOOZE)) return true;
        try {
            long at = new JSONObject(prefs(c).getString("fired", "{}")).optLong(key, 0);
            return at > System.currentTimeMillis() - FIRED_TTL;
        } catch (Exception e) {
            return false;
        }
    }
}
