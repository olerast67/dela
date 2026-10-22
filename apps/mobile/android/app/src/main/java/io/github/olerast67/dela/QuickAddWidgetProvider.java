package io.github.olerast67.dela;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * Виджет «Быстрое добавление во Входящие»: плашка в виде поля ввода и кнопка «+».
 * Ввести текст прямо в виджете Android не даёт, поэтому любое нажатие открывает быстрое добавление в приложении.
 * Светлая и тёмная тема берутся из ресурсов -night, настроек у виджета нет.
 */
public class QuickAddWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) update(context, manager, id);
    }

    static void update(Context c, AppWidgetManager manager, int widgetId) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_quick_add);
        // Подсказка на языке приложения, как у виджета «Задачи».
        v.setTextViewText(R.id.widget_quick_hint, WidgetStore.localized(c).getString(R.string.quick_hint));
        // Номера запросов 400000+ не пересекаются с кнопками виджета «Задачи».
        PendingIntent open = TasksWidgetProvider.openApp(c, 400000 + widgetId, WidgetBridgePlugin.EXTRA_QUICK_ADD, "inbox");
        v.setOnClickPendingIntent(R.id.widget_quick_root, open);
        v.setOnClickPendingIntent(R.id.widget_quick_hint, open);
        v.setOnClickPendingIntent(R.id.widget_quick_add, open);
        manager.updateAppWidget(widgetId, v);
    }
}
