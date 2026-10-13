package io.github.olerast67.dela;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONObject;

/**
 * Виджет «Задачи» на главном экране: заголовок со списком (нажатие открывает настройки),
 * кнопка «+», список задач. Нажатие на кружок отмечает задачу выполненной, на строку открывает её в приложении.
 */
public class TasksWidgetProvider extends AppWidgetProvider {
    static final String ACTION_ITEM = "io.github.olerast67.dela.WIDGET_ITEM";
    static final String EXTRA_OP = "op";
    static final String EXTRA_TASK = "task";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) update(context, manager, id);
        // Раз в полчаса: после полуночи «Сегодня» пересчитывается без открытия приложения.
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    @Override
    public void onDeleted(Context context, int[] ids) {
        for (int id : ids) WidgetStore.deleteConfig(context, id);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (!ACTION_ITEM.equals(intent.getAction())) return;
        String task = intent.getStringExtra(EXTRA_TASK);
        if (task == null) return;
        if ("complete".equals(intent.getStringExtra(EXTRA_OP))) {
            WidgetStore.addCompleted(context, task);
            WidgetStore.refreshAll(context);
            WidgetBridgePlugin.onWidgetCompleted();
        } else {
            Intent open = new Intent(context, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            open.putExtra(WidgetBridgePlugin.EXTRA_TASK_ID, task);
            context.startActivity(open);
        }
    }

    private static int mutable() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
    }

    private static PendingIntent openApp(Context c, int requestCode, String extra) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (extra != null) i.putExtra(extra, true);
        i.setData(Uri.parse("dela://widget/" + requestCode));
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void update(Context c, AppWidgetManager manager, int widgetId) {
        WidgetStore.Config cfg = WidgetStore.config(c, widgetId);
        boolean dark = WidgetStore.dark(c, cfg);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_tasks);

        v.setImageViewResource(R.id.widget_bg, dark ? R.drawable.widget_bg_dark : R.drawable.widget_bg_light);
        v.setInt(R.id.widget_bg, "setImageAlpha", Math.round(255f * Math.max(0, Math.min(100, cfg.opacity)) / 100f));
        int text = dark ? 0xFFEFEAE0 : 0xFF25221C;
        int accent = dark ? 0xFF6FCF9B : 0xFF2E7D5B;
        v.setTextColor(R.id.widget_title, accent);
        v.setTextViewText(R.id.widget_title, WidgetStore.listTitle(c, cfg.list) + "  ▾");
        v.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, cfg.large ? 19 : 17);
        v.setTextColor(R.id.widget_empty, dark ? 0xFFA49D8F : 0xFF766F63);
        v.setInt(R.id.widget_add, "setColorFilter", accent);

        JSONObject snap = WidgetStore.snapshot(c);
        String empty;
        if (snap == null) empty = "Откройте Dela, чтобы виджет получил задачи";
        else if (snap.optBoolean("lock") && cfg.hideWhenLocked) empty = "Dela заблокирована. Задачи видны в приложении.";
        else if ("today".equals(cfg.list)) empty = "На сегодня всё";
        else if ("week".equals(cfg.list)) empty = "На неделю задач нет";
        else empty = "В списке нет задач";
        v.setTextViewText(R.id.widget_empty, empty);
        v.setTextColor(R.id.widget_empty, text);

        Intent service = new Intent(c, TasksWidgetService.class);
        service.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
        v.setRemoteAdapter(R.id.widget_list, service);
        v.setEmptyView(R.id.widget_list, R.id.widget_empty);

        Intent item = new Intent(c, TasksWidgetProvider.class);
        item.setAction(ACTION_ITEM);
        item.setData(Uri.parse("dela://widget-item/" + widgetId));
        v.setPendingIntentTemplate(
            R.id.widget_list,
            PendingIntent.getBroadcast(c, widgetId, item, PendingIntent.FLAG_UPDATE_CURRENT | mutable())
        );

        Intent configure = new Intent(c, WidgetConfigActivity.class);
        configure.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        configure.setData(Uri.parse("dela://widget-config/" + widgetId));
        configure.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        v.setOnClickPendingIntent(
            R.id.widget_title,
            PendingIntent.getActivity(c, widgetId, configure, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
        );
        v.setOnClickPendingIntent(R.id.widget_add, openApp(c, 100000 + widgetId, WidgetBridgePlugin.EXTRA_QUICK_ADD));
        v.setOnClickPendingIntent(R.id.widget_icon, openApp(c, 200000 + widgetId, null));
        v.setViewVisibility(R.id.widget_icon, View.VISIBLE);

        manager.updateAppWidget(widgetId, v);
    }
}
