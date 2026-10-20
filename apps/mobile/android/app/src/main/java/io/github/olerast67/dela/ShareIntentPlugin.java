package io.github.olerast67.dela;

import android.content.Context;
import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * «Поделиться» из других приложений: текст или ссылка становятся строкой быстрого ввода,
 * картинка или голосовое сообщение ждут распознавания на телефоне (RecognizePlugin).
 * При холодном запуске присланное ждёт, пока веб-клиент заберёт его методом take();
 * если приложение уже открыто, приходит событие shared.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private static String pending;
    /** Вид присланного файла (image или audio), о котором веб-клиент ещё не знает. */
    private static String pendingMedia;

    static void store(Context c, Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String media = SharedMedia.accept(c, intent);
        if (media != null) {
            pendingMedia = media;
            pending = null;
            return;
        }
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
        store(getContext(), intent);
        if (pending == null && pendingMedia == null) return;
        notifyListeners("shared", take(), true);
    }

    private static JSObject take() {
        JSObject data = new JSObject();
        if (pending != null) data.put("text", pending);
        if (pendingMedia != null) data.put("media", pendingMedia);
        pending = null;
        pendingMedia = null;
        return data;
    }

    @PluginMethod
    public void take(PluginCall call) {
        call.resolve(take());
    }
}
