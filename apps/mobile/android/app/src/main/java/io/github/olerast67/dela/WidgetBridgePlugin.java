package io.github.olerast67.dela;

import android.content.Intent;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Связь веб-клиента с виджетом и плиткой в шторке:
 * update() кладёт снимок задач, takeCompleted() отдаёт задачи, отмеченные на виджете,
 * takeLaunch() и событие launch сообщают, что приложение открыто с виджета (задача или быстрое добавление)
 * или с push утренней сводки (экран «Сегодня»).
 */
@CapacitorPlugin(name = "DelaWidget")
public class WidgetBridgePlugin extends Plugin {
    static final String EXTRA_TASK_ID = "dela.taskId";
    static final String EXTRA_QUICK_ADD = "dela.quickAdd";
    static final String EXTRA_VOICE = "dela.voice";
    static final String EXTRA_TODAY = "dela.today";

    private static WidgetBridgePlugin instance;
    private static String pendingTask;
    private static boolean pendingQuickAdd;
    private static boolean pendingVoice;
    private static boolean pendingToday;

    @Override
    public void load() {
        instance = this;
    }

    static void store(Intent intent) {
        if (intent == null) return;
        String task = intent.getStringExtra(EXTRA_TASK_ID);
        if (task != null) pendingTask = task;
        if (intent.getBooleanExtra(EXTRA_QUICK_ADD, false)) pendingQuickAdd = true;
        if (intent.getBooleanExtra(EXTRA_VOICE, false)) pendingVoice = true;
        if (intent.getBooleanExtra(EXTRA_TODAY, false)) pendingToday = true;
    }

    private JSObject drainLaunch() {
        JSObject data = new JSObject();
        if (pendingTask != null) data.put("taskId", pendingTask);
        if (pendingQuickAdd) data.put("quickAdd", true);
        if (pendingVoice) data.put("voice", true);
        if (pendingToday) data.put("today", true);
        pendingTask = null;
        pendingQuickAdd = false;
        pendingVoice = false;
        pendingToday = false;
        return data;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        store(intent);
        if (pendingTask == null && !pendingQuickAdd && !pendingVoice && !pendingToday) return;
        notifyListeners("launch", drainLaunch(), true);
    }

    /** Задачу отметили на виджете, пока приложение запущено: веб-клиент сразу заберёт очередь. */
    static void onWidgetCompleted() {
        WidgetBridgePlugin p = instance;
        if (p != null) p.notifyListeners("completed", new JSObject(), true);
    }

    @PluginMethod
    public void update(PluginCall call) {
        String snapshot = call.getString("snapshot");
        if (snapshot == null) {
            call.reject("snapshot is required");
            return;
        }
        WidgetStore.setSnapshot(getContext(), snapshot);
        WidgetStore.refreshAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void takeCompleted(PluginCall call) {
        JSObject result = new JSObject();
        JSArray ids = new JSArray();
        for (String id : WidgetStore.takeCompleted(getContext())) ids.put(id);
        result.put("ids", ids);
        call.resolve(result);
    }

    @PluginMethod
    public void takeLaunch(PluginCall call) {
        call.resolve(drainLaunch());
    }
}
