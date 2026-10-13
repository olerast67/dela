package io.github.olerast67.dela;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Нажатия в списке виджета: кружок отмечает задачу выполненной, строка открывает её в приложении.
 * Приёмник не экспортирован: команды приходят только из PendingIntent самого виджета.
 */
public class WidgetActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!TasksWidgetProvider.ACTION_ITEM.equals(intent.getAction())) return;
        String task = intent.getStringExtra(TasksWidgetProvider.EXTRA_TASK);
        if (task == null) return;
        if ("complete".equals(intent.getStringExtra(TasksWidgetProvider.EXTRA_OP))) {
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
