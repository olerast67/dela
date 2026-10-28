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
 * takeLaunch() и событие launch сообщают, что приложение открыто с виджета (задача или быстрое добавление
 * в список виджета) или с push утренней сводки (экран «Сегодня»).
 */
@CapacitorPlugin(name = "DelaWidget")
public class WidgetBridgePlugin extends Plugin {
    static final String EXTRA_TASK_ID = "dela.taskId";
    static final String EXTRA_QUICK_ADD = "dela.quickAdd";
    static final String EXTRA_VOICE = "dela.voice";
    static final String EXTRA_TODAY = "dela.today";
    /** Список виджета для быстрого добавления: «today», «week», «inbox» или «project:<id>». */
    static final String EXTRA_LIST = "dela.list";

    private static WidgetBridgePlugin instance;
    private static String pendingTask;
    private static boolean pendingQuickAdd;
    private static boolean pendingVoice;
    private static boolean pendingToday;
    private static String pendingList;

    @Override
    public void load() {
        instance = this;
    }

    static void store(Intent intent) {
        if (intent == null) return;
        String task = intent.getStringExtra(EXTRA_TASK_ID);
        if (task != null) pendingTask = task;
        boolean quickAdd = intent.getBooleanExtra(EXTRA_QUICK_ADD, false);
        boolean voice = intent.getBooleanExtra(EXTRA_VOICE, false);
        if (quickAdd) pendingQuickAdd = true;
        if (voice) pendingVoice = true;
        // Плитка в шторке списка не передаёт: задача пойдёт туда же, куда «+» на открытом экране.
        if (quickAdd || voice) pendingList = intent.getStringExtra(EXTRA_LIST);
        if (intent.getBooleanExtra(EXTRA_TODAY, false)) pendingToday = true;
    }

    private JSObject drainLaunch() {
        JSObject data = new JSObject();
        if (pendingTask != null) data.put("taskId", pendingTask);
        if (pendingQuickAdd) data.put("quickAdd", true);
        if (pendingVoice) data.put("voice", true);
        if (pendingToday) data.put("today", true);
        if (pendingList != null) data.put("list", pendingList);
        pendingTask = null;
        pendingQuickAdd = false;
        pendingVoice = false;
        pendingToday = false;
        pendingList = null;
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

    /**
     * Показать клавиатуру для поля в фокусе: WebView не открывает её, если фокус поставил код,
     * а приложение только что открыто с виджета. Небольшая задержка — окно должно успеть получить фокус.
     */
    @PluginMethod
    public void showKeyboard(PluginCall call) {
        android.webkit.WebView web = getBridge().getWebView();
        web.post(() -> {
            web.requestFocus();
            web.postDelayed(() -> {
                android.view.inputmethod.InputMethodManager imm =
                    (android.view.inputmethod.InputMethodManager) getContext().getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(web, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
            }, 150);
        });
        call.resolve();
    }

    @PluginMethod
    public void takeLaunch(PluginCall call) {
        call.resolve(drainLaunch());
    }
}
