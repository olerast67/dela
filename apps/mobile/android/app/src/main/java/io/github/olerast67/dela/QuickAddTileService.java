package io.github.olerast67.dela;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.TileService;

/** Плитка «Задача в Dela» в шторке: открывает приложение сразу с быстрым добавлением. */
public class QuickAddTileService extends TileService {
    @Override
    public void onClick() {
        super.onClick();
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra(WidgetBridgePlugin.EXTRA_QUICK_ADD, true);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        } else {
            startActivityAndCollapseCompat(i);
        }
    }

    @SuppressWarnings("deprecation")
    private void startActivityAndCollapseCompat(Intent i) {
        startActivityAndCollapse(i);
    }
}
