package io.github.olerast67.dela;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * «Поделиться» из других приложений: текст или ссылка становятся строкой быстрого ввода.
 * При холодном запуске текст ждёт, пока веб-клиент заберёт его методом take();
 * если приложение уже открыто, приходит событие shared.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private static String pending;

    static void store(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null && subject == null) return;
        if (text == null) pending = subject;
        else if (subject == null || text.contains(subject)) pending = text;
        else pending = subject + " " + text;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        store(intent);
        if (pending == null) return;
        JSObject data = new JSObject();
        data.put("text", pending);
        pending = null;
        notifyListeners("shared", data, true);
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject result = new JSObject();
        if (pending != null) result.put("text", pending);
        pending = null;
        call.resolve(result);
    }
}
