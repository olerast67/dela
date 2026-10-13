package io.github.olerast67.dela;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * Регистрация в UnifiedPush из веб-клиента: выбрать распространитель (ntfy и другие),
 * получить адрес и ключи Web Push для сервера, задать ключ расшифровки текста напоминаний.
 */
@CapacitorPlugin(name = "UnifiedPush")
public class UnifiedPushPlugin extends Plugin {
    private static UnifiedPushPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    static void onEndpoint(Context c) {
        UnifiedPushPlugin p = instance;
        if (p != null) p.notifyListeners("endpoint", endpoint(c), true);
    }

    private static JSObject endpoint(Context c) {
        SharedPreferences prefs = DelaPushService.prefs(c);
        JSObject r = new JSObject();
        String url = prefs.getString("url", null);
        if (url != null) {
            r.put("url", url);
            r.put("p256dh", prefs.getString("p256dh", ""));
            r.put("auth", prefs.getString("auth", ""));
        }
        return r;
    }

    @PluginMethod
    public void register(PluginCall call) {
        String vapid = call.getString("vapid");
        UnifiedPush.tryUseCurrentOrDefaultDistributor(getActivity(), (success) -> {
            if (!success) {
                JSObject r = new JSObject();
                r.put("ok", false);
                call.resolve(r);
                return null;
            }
            UnifiedPush.register(getContext(), "default", getContext().getString(R.string.push_instance), vapid);
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
            return null;
        });
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        UnifiedPush.unregister(getContext(), "default");
        DelaPushService.prefs(getContext()).edit().remove("url").remove("p256dh").remove("auth").apply();
        call.resolve();
    }

    @PluginMethod
    public void getEndpoint(PluginCall call) {
        call.resolve(endpoint(getContext()));
    }

    @PluginMethod
    public void setKey(PluginCall call) {
        DelaPushService.prefs(getContext()).edit().putString("key", call.getString("key")).apply();
        call.resolve();
    }
}
