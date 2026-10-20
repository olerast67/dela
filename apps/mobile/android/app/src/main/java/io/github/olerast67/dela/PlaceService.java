package io.github.olerast67.dela;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.util.List;

/**
 * Слежение за зонами напоминаний по месту без сервисов Google: LocationManager телефона.
 *
 * Почему служба переднего плана, а не addProximityAlert или периодическая проверка: с Android 8 приложение в фоне
 * получает координаты лишь несколько раз в час, а addProximityAlert на разных прошивках то молчит в фоне,
 * то не переживает перезагрузку. Служба типа location с уведомлением «Dela следит за местами» получает точки
 * в обычном темпе, в том числе в Doze, пока телефон двигается (неподвижный телефон зону не пересекает).
 *
 * Батарея: служба работает, только пока есть зоны. Далеко от зон — редкие точки по сети (вышки, Wi-Fi),
 * у границы ближайшей зоны — спутники раз в 20 секунд. Точки, которые получили другие приложения (passive), бесплатны.
 */
public class PlaceService extends Service implements LocationListener {
    static final String ACTION_SYNC = "io.github.olerast67.dela.PLACES_SYNC";
    static final String ACTION_OFF = "io.github.olerast67.dela.PLACES_OFF";
    private static final String CHANNEL = "dela-places";
    private static final int NOTIFICATION_ID = 0x0de1b;
    /** Точка старше этого — из кэша провайдера, по ней о входе не судим. */
    private static final long MAX_AGE_NS = 5 * 60_000_000_000L;

    static volatile boolean running;
    private LocationManager lm;
    private int mode = -1;

    /** Есть ли разрешение на геолокацию (точное или приблизительное). */
    static boolean hasLocation(Context c) {
        return granted(c, Manifest.permission.ACCESS_FINE_LOCATION) || granted(c, Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    static boolean granted(Context c, String permission) {
        return ContextCompat.checkSelfPermission(c, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean shouldRun(Context c) {
        return PlaceStore.enabled(c) && hasLocation(c) && !PlaceStore.all(c).isEmpty();
    }

    /** Запустить, обновить или остановить слежение по сохранённым зонам: после замены зон, смены разрешений и перезагрузки. */
    static void sync(Context c) {
        if (!shouldRun(c)) {
            if (running) c.stopService(new Intent(c, PlaceService.class));
            return;
        }
        try {
            ContextCompat.startForegroundService(c, new Intent(c, PlaceService.class).setAction(ACTION_SYNC));
        } catch (RuntimeException e) {
            // Android 12+ не дал запустить службу из фона: слежение возобновится при следующем открытии приложения.
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_OFF.equals(intent.getAction())) {
            // Кнопка «Выключить» в уведомлении: приходит обычным startService, startForeground не нужен.
            PlaceStore.setEnabled(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        // startForeground сразу: после startForegroundService у службы на это несколько секунд, даже если она тут же остановится.
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type);
        } catch (RuntimeException e) {
            // Нет разрешения на геолокацию или запуск из фона без «Разрешить всегда» (Android 14+).
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!shouldRun(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        if (lm == null) lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        mode = -1;
        request(Double.NaN);
        // Службу, убитую системой, Android перезапустит сам.
        return START_STICKY;
    }

    private Notification notification() {
        Context res = WidgetStore.localized(this);
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Тихий канал: уведомление нужно Android, а не пользователю; его можно скрыть в настройках канала.
            NotificationChannel ch = new NotificationChannel(CHANNEL, res.getString(R.string.place_channel), NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent off = new Intent(this, PlaceService.class).setAction(ACTION_OFF);
        PendingIntent offPi = PendingIntent.getService(this, NOTIFICATION_ID, off, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dela)
            .setContentTitle(res.getString(R.string.place_tracking))
            .setContentText(res.getString(R.string.place_tracking_text))
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openPi)
            .addAction(0, res.getString(R.string.place_tracking_off), offPi)
            .build();
    }

    /** Подписаться на точки с частотой по расстоянию до ближайшей границы зоны; повторно только при смене режима. */
    private void request(double nearestBoundary) {
        int m = PlaceZones.mode(nearestBoundary);
        if (m == mode || lm == null) return;
        mode = m;
        try {
            lm.removeUpdates(this);
            boolean fine = granted(this, Manifest.permission.ACCESS_FINE_LOCATION);
            boolean network = enabled(LocationManager.NETWORK_PROVIDER);
            boolean gps = fine && enabled(LocationManager.GPS_PROVIDER);
            Looper looper = Looper.getMainLooper();
            if (m == PlaceZones.NEAR) {
                if (gps) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 20_000, 10, this, looper);
                if (network) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 20_000, 10, this, looper);
            } else {
                long every = m == PlaceZones.FAR ? 120_000 : 300_000;
                float meters = m == PlaceZones.FAR ? 50 : 500;
                // Без сетевого провайдера (прошивки без сервисов Google и без своего) — спутники, но редко.
                if (network) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, every, meters, this, looper);
                else if (gps) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, every, meters, this, looper);
            }
            if (enabled(LocationManager.PASSIVE_PROVIDER)) lm.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, 10_000, 0, this, looper);
        } catch (SecurityException | IllegalArgumentException e) {
            // разрешение отозвали: служба остановится при следующей синхронизации зон
        }
    }

    private boolean enabled(String provider) {
        try {
            return lm.getAllProviders().contains(provider) && lm.isProviderEnabled(provider);
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    public void onLocationChanged(Location l) {
        if (SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos() > MAX_AGE_NS) return;
        double acc = l.hasAccuracy() ? l.getAccuracy() : 1000;
        List<PlaceStore.Zone> fired = PlaceStore.apply(this, l.getLatitude(), l.getLongitude(), acc);
        for (PlaceStore.Zone z : fired) fire(this, z);
        double nearest = PlaceStore.nearestBoundary(this, l.getLatitude(), l.getLongitude());
        if (Double.isNaN(nearest)) {
            stopSelf();
            return;
        }
        request(nearest);
    }

    /** Напоминание задачи: обычное уведомление, у срочной задачи — будильник через AlarmStore. */
    static void fire(Context c, PlaceStore.Zone z) {
        Context res = WidgetStore.localized(c);
        String title = z.title == null || z.title.isEmpty() ? res.getString(R.string.notify_task) : z.title;
        String key = "place:" + z.taskId + ":" + System.currentTimeMillis();
        if (z.alarm && AlarmStore.canSchedule(c)) {
            AlarmStore.ringSoon(c, key, title, z.taskId);
            return;
        }
        boolean arrive = !"leave".equals(z.on);
        String body = z.name == null || z.name.isEmpty()
            ? res.getString(arrive ? R.string.place_arrived_here : R.string.place_left_here)
            : res.getString(arrive ? R.string.place_arrived : R.string.place_left, z.name);
        DelaPushService.showReminder(c, title, body, z.taskId, key, false);
    }

    // Нужны для Android 9 и старше: там эти методы интерфейса без реализации по умолчанию.
    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {
        // Включили геолокацию или спутники: подписаться заново с тем же режимом.
        int m = mode;
        mode = -1;
        request(m == PlaceZones.NEAR ? 0 : m == PlaceZones.FAR ? 5000 : m == PlaceZones.VERY_FAR ? 100_000 : Double.NaN);
    }

    @Override
    public void onProviderDisabled(String provider) {}

    @Override
    public void onDestroy() {
        running = false;
        if (lm != null) {
            try {
                lm.removeUpdates(this);
            } catch (SecurityException ignored) {
                // разрешение уже отозвано
            }
        }
        super.onDestroy();
    }
}
