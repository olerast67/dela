package io.github.olerast67.dela;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Будильник срочной задачи сработал: звонок ведёт служба AlarmService.
 * Приёмник не экспортирован: команду шлёт только AlarmManager по PendingIntent самого приложения.
 */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!AlarmStore.ACTION_FIRE.equals(intent.getAction())) return;
        String key = intent.getStringExtra(AlarmStore.EXTRA_KEY);
        if (key == null) return;
        AlarmStore.Alarm a = AlarmStore.take(context, key);
        if (a == null) return;
        AlarmService.ring(context, a);
    }
}
