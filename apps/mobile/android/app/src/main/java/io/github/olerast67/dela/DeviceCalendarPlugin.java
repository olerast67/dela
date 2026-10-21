package io.github.olerast67.dela;

import android.Manifest;
import android.content.ContentUris;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;

/**
 * Календари телефона только для чтения: список календарей и события в окне дат через CalendarContract.
 * Повторы разворачивает сам Android (таблица Instances). Разрешение READ_CALENDAR спрашивается,
 * когда пользователь включает календари телефона в настройках. События остаются на телефоне:
 * веб-клиент показывает их поверх задач и никуда не отправляет.
 */
@CapacitorPlugin(name = "DeviceCalendar", permissions = { @Permission(alias = "calendar", strings = { Manifest.permission.READ_CALENDAR }) })
public class DeviceCalendarPlugin extends Plugin {
    /** Больше событий за один запрос не отдаём: окно и так ограничено датами. */
    private static final int MAX_EVENTS = 5000;

    private boolean granted() {
        return getPermissionState("calendar") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void calendars(PluginCall call) {
        if (!granted()) {
            call.reject("calendar permission", "denied");
            return;
        }
        String[] cols = {
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.CALENDAR_COLOR,
            CalendarContract.Calendars.VISIBLE,
        };
        JSArray list = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, cols, null, null, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME)) {
            while (c != null && c.moveToNext()) {
                JSObject o = new JSObject();
                o.put("id", String.valueOf(c.getLong(0)));
                o.put("name", c.isNull(1) ? "" : c.getString(1));
                o.put("account", c.isNull(2) ? "" : c.getString(2));
                o.put("color", c.getInt(3));
                o.put("visible", c.getInt(4) != 0);
                list.put(o);
            }
        } catch (SecurityException e) {
            call.reject("calendar permission", "denied");
            return;
        }
        JSObject r = new JSObject();
        r.put("calendars", list);
        call.resolve(r);
    }

    @PluginMethod
    public void events(PluginCall call) {
        if (!granted()) {
            call.reject("calendar permission", "denied");
            return;
        }
        // Время в миллисекундах не помещается в int, и мост отдаёт его как Long, а call.getDouble() понимает
        // только Double, Float и Integer: вернул бы null. optDouble читает любое число.
        double from = call.getData().optDouble("from", Double.NaN);
        double to = call.getData().optDouble("to", Double.NaN);
        if (Double.isNaN(from) || Double.isNaN(to) || to <= from) {
            call.reject("bad range");
            return;
        }
        // null — все календари, иначе только выбранные пользователем.
        Set<String> only = null;
        JSArray ids = call.getArray("ids", null);
        if (ids != null) {
            only = new HashSet<>();
            JSONArray a = ids;
            for (int i = 0; i < a.length(); i++) only.add(a.optString(i));
        }
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, (long) from);
        ContentUris.appendId(b, (long) to);
        String[] cols = {
            CalendarContract.Instances._ID,
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.CALENDAR_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.DISPLAY_COLOR,
            CalendarContract.Instances.STATUS,
        };
        JSArray list = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(b.build(), cols, null, null, CalendarContract.Instances.BEGIN)) {
            while (c != null && c.moveToNext() && list.length() < MAX_EVENTS) {
                String calendar = String.valueOf(c.getLong(2));
                if (only != null && !only.contains(calendar)) continue;
                if (!c.isNull(10) && c.getInt(10) == CalendarContract.Instances.STATUS_CANCELED) continue;
                JSObject o = new JSObject();
                o.put("id", c.getLong(1) + ":" + c.getLong(0));
                o.put("calendar", calendar);
                o.put("title", c.isNull(3) ? "" : c.getString(3));
                o.put("location", c.isNull(4) ? "" : c.getString(4));
                o.put("description", c.isNull(5) ? "" : c.getString(5));
                o.put("begin", c.getLong(6));
                o.put("end", c.getLong(7));
                o.put("allDay", c.getInt(8) != 0);
                o.put("color", c.getInt(9));
                list.put(o);
            }
        } catch (SecurityException e) {
            call.reject("calendar permission", "denied");
            return;
        }
        JSObject r = new JSObject();
        r.put("events", list);
        call.resolve(r);
    }
}
