package io.github.olerast67.dela;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * После перезагрузки телефона и обновления приложения будильники срочных задач ставятся заново из сохранённого списка,
 * а слежение за местами возобновляется по сохранённым зонам (если есть разрешение «Разрешить всегда»).
 */
public class AlarmBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            AlarmStore.rescheduleAll(context);
            PlaceService.sync(context);
        }
    }
}
