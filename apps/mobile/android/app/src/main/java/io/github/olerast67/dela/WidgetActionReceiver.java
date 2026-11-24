package io.github.olerast67.dela;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Нажатия в списке виджета: кружок отмечает задачу выполненной, строка открывает её в приложении,
 * дыра плана открывает быстрое добавление на её время. Здесь же «+15» и перерисовка плана по будильнику.
 * Приёмник не экспортирован: команды приходят только из PendingIntent самого виджета.
 */
public class WidgetActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (WidgetPlan.ACTION_TICK.equals(intent.getAction())) {
            WidgetStore.refreshAll(context);
            return;
        }
        if (TasksWidgetProvider.ACTION_SHIFT.equals(intent.getAction())) {
            // «+15» в режиме «План»: виджет сразу рисует сдвиг, приложение применит его к задачам.
            WidgetStore.addShift(context, System.currentTimeMillis(), 15);
            WidgetStore.refreshAll(context);
            WidgetBridgePlugin.onWidgetCompleted();
            return;
        }
        if (!TasksWidgetProvider.ACTION_ITEM.equals(intent.getAction())) return;
        String op = intent.getStringExtra(TasksWidgetProvider.EXTRA_OP);
        if ("add".equals(op)) {
            // Дыра в плане: быстрое добавление со временем её начала.
            Intent open = new Intent(context, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            open.putExtra(WidgetBridgePlugin.EXTRA_QUICK_ADD, true);
            open.putExtra(WidgetBridgePlugin.EXTRA_LIST, WidgetPlan.LIST + "@" + intent.getStringExtra(TasksWidgetProvider.EXTRA_TIME));
            context.startActivity(open);
            return;
        }
        String task = intent.getStringExtra(TasksWidgetProvider.EXTRA_TASK);
        if (task == null) return;
        if ("complete".equals(op)) {
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
}
