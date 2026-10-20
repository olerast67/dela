package io.github.olerast67.dela;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Будильники срочных задач для веб-клиента: set() заменяет список будильников,
 * status() сообщает, можно ли ставить точные будильники и показывать их на весь экран.
 */
@CapacitorPlugin(name = "DelaAlarm")
public class AlarmPlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        JSArray alarms = call.getArray("alarms", new JSArray());
        JSArray active = call.getArray("active", new JSArray());
        Context c = getContext();
        List<AlarmStore.Alarm> list = new ArrayList<>();
        Set<String> tasks = new HashSet<>();
        try {
            for (int i = 0; i < alarms.length(); i++) {
                JSONObject o = alarms.getJSONObject(i);
                AlarmStore.Alarm a = AlarmStore.Alarm.of(o);
                if (!a.key.isEmpty() && a.at > 0) list.add(a);
            }
            for (int i = 0; i < active.length(); i++) tasks.add(active.getString(i));
        } catch (Exception e) {
            call.reject("bad alarms");
            return;
        }
        boolean ok = AlarmStore.canSchedule(c);
        // Без права на точные будильники старые снимаются, а напоминания веб-клиент ставит уведомлениями.
        AlarmStore.replace(c, ok ? list : new ArrayList<>(), tasks);
        JSObject r = new JSObject();
        r.put("ok", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("exact", AlarmStore.canSchedule(getContext()));
        r.put("fullScreen", fullScreenAllowed());
        call.resolve(r);
    }

    /** Android 14+: показ на весь экран пользователь может запретить, тогда будильник приходит уведомлением со звуком. */
    private boolean fullScreenAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        return nm != null && nm.canUseFullScreenIntent();
    }

    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(i);
            } catch (Exception e) {
                // у части прошивок нет этого экрана: открываем настройки уведомлений приложения
                Intent n = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                n.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(n);
            }
        }
        call.resolve();
    }
}
