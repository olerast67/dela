package io.github.olerast67.dela;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Звонок будильника срочной задачи: служба переднего плана с уведомлением во весь экран
 * (AlarmActivity поверх экрана блокировки), звук через поток будильника и вибрация.
 * Поток будильника (USAGE_ALARM) звучит и в беззвучном режиме, а «Не беспокоить» по умолчанию пропускает будильники.
 * Через 5 минут звонок стихает сам, а в шторке остаётся уведомление о пропущенном будильнике.
 */
public class AlarmService extends Service {
    static final String CHANNEL = "dela-alarm";
    static final String ACTION_RING = "io.github.olerast67.dela.ALARM_RING";
    static final String ACTION_DONE = "io.github.olerast67.dela.ALARM_DONE";
    static final String ACTION_SNOOZE = "io.github.olerast67.dela.ALARM_SNOOZE";
    static final String ACTION_DISMISS = "io.github.olerast67.dela.ALARM_DISMISS";
    static final String EXTRA_TITLE = "dela.alarmTitle";
    static final String EXTRA_TASK = "dela.alarmTask";
    private static final int NOTIFICATION_ID = 0x0de1a;
    private static final long RING_MS = 5 * 60_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = this::timeout;
    private MediaPlayer player;
    private Vibrator vibrator;
    private AudioFocusRequest focus;
    private String key;
    private String title;
    private String taskId;

    /** Начать звонок. Без права на службу переднего плана остаётся уведомление во весь экран без звука службы. */
    static void ring(Context c, AlarmStore.Alarm a) {
        Intent i = new Intent(c, AlarmService.class).setAction(ACTION_RING)
            .putExtra(AlarmStore.EXTRA_KEY, a.key).putExtra(EXTRA_TITLE, a.title).putExtra(EXTRA_TASK, a.taskId);
        try {
            ContextCompat.startForegroundService(c, i);
        } catch (RuntimeException e) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            try {
                nm.notify(NOTIFICATION_ID, notification(c, a.key, a.title, a.taskId));
            } catch (SecurityException ignored) {
                // нет разрешения на уведомления
            }
        }
    }

    static Intent command(Context c, String action, String key, String title, String taskId) {
        return new Intent(c, AlarmService.class).setAction(action)
            .putExtra(AlarmStore.EXTRA_KEY, key).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TASK, taskId);
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL, WidgetStore.localized(c).getString(R.string.alarm_channel), NotificationManager.IMPORTANCE_HIGH);
        // Звук и вибрацию ведёт служба, у канала их нет: иначе уведомление звенело бы вторым звуком.
        ch.setSound(null, null);
        ch.enableVibration(false);
        // Действует, если пользователь дал Dela доступ к «Не беспокоить»; без него будильник пропускает категория ALARM.
        ch.setBypassDnd(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    static Notification notification(Context c, String key, String title, String taskId) {
        ensureChannel(c);
        Context res = WidgetStore.localized(c);
        int id = DelaPushService.notificationId(key);
        Intent full = new Intent(c, AlarmActivity.class)
            .putExtra(AlarmStore.EXTRA_KEY, key).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TASK, taskId)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(c, id, full, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dela)
            .setContentTitle(title)
            .setContentText(res.getString(R.string.alarm_text))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullPi, true)
            .setContentIntent(fullPi)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, res.getString(R.string.alarm_done), service(c, ACTION_DONE, key, title, taskId))
            .addAction(0, res.getString(R.string.alarm_snooze), service(c, ACTION_SNOOZE, key, title, taskId))
            .addAction(0, res.getString(R.string.alarm_dismiss), service(c, ACTION_DISMISS, key, title, taskId))
            .build();
    }

    private static PendingIntent service(Context c, String action, String key, String title, String taskId) {
        Intent i = command(c, action, key, title, taskId);
        i.setData(Uri.parse("dela-alarm://" + action + "/" + Uri.encode(key)));
        return PendingIntent.getService(c, DelaPushService.notificationId(key), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        String k = intent == null ? null : intent.getStringExtra(AlarmStore.EXTRA_KEY);
        String t = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
        String task = intent == null ? null : intent.getStringExtra(EXTRA_TASK);
        if (ACTION_RING.equals(action) && k != null) {
            start(k, t == null ? "" : t, task);
        } else if (ACTION_DONE.equals(action)) {
            // Выполнение применяет приложение: та же очередь, что у виджета (заберёт при запуске или сразу, если запущено).
            if (task != null && !task.isEmpty()) {
                WidgetStore.addCompleted(this, task);
                WidgetStore.refreshAll(this);
                WidgetBridgePlugin.onWidgetCompleted();
            }
            stop();
        } else if (ACTION_SNOOZE.equals(action) && k != null) {
            AlarmStore.snooze(this, k, t == null ? "" : t, task);
            stop();
        } else {
            stop();
        }
        return START_NOT_STICKY;
    }

    private void start(String k, String t, String task) {
        silence();
        key = k;
        title = t;
        taskId = task;
        Notification n = notification(this, k, t, task);
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
        } catch (RuntimeException e) {
            // Служба не стала службой переднего плана: показываем уведомление во весь экран, звонок без службы не держится.
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            try {
                nm.notify(NOTIFICATION_ID, n);
            } catch (SecurityException ignored) {
                // нет разрешения на уведомления
            }
            stopSelf();
            return;
        }
        playSound();
        vibrate();
        handler.postDelayed(timeout, RING_MS);
    }

    private void playSound() {
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Музыка и видео на время звонка замолкают.
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs).build();
            am.requestAudioFocus(focus);
        }
        for (int type : new int[] { RingtoneManager.TYPE_ALARM, RingtoneManager.TYPE_RINGTONE, RingtoneManager.TYPE_NOTIFICATION }) {
            Uri uri = RingtoneManager.getDefaultUri(type);
            if (uri == null) continue;
            MediaPlayer p = new MediaPlayer();
            try {
                p.setAudioAttributes(attrs);
                p.setDataSource(this, uri);
                p.setLooping(true);
                p.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
                p.prepare();
                p.start();
                player = p;
                return;
            } catch (Exception e) {
                p.release();
            }
        }
    }

    private void vibrate() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            vibrator = vm == null ? null : vm.getDefaultVibrator();
        } else {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }
        if (vibrator == null || !vibrator.hasVibrator()) return;
        long[] pattern = { 0, 800, 700 };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM));
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        } else {
            vibrator.vibrate(pattern, 0);
        }
    }

    private void silence() {
        handler.removeCallbacks(timeout);
        if (player != null) {
            try {
                player.stop();
            } catch (IllegalStateException ignored) {
                // плеер уже остановлен
            }
            player.release();
            player = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am != null && focus != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) am.abandonAudioFocusRequest(focus);
        focus = null;
    }

    /** Никто не ответил за 5 минут: звонок стихает, в шторке остаётся пропущенный будильник. */
    private void timeout() {
        String k = key;
        String t = title;
        String task = taskId;
        stop();
        if (k == null) return;
        Context res = WidgetStore.localized(this);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (task != null && !task.isEmpty()) open.putExtra(WidgetBridgePlugin.EXTRA_TASK_ID, task);
        open.setData(Uri.parse("dela-alarm://missed/" + Uri.encode(k)));
        PendingIntent pi = PendingIntent.getActivity(this, DelaPushService.notificationId(k), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dela)
            .setContentTitle(t)
            .setContentText(res.getString(R.string.alarm_missed))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build();
        try {
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(DelaPushService.notificationId(k), n);
        } catch (SecurityException ignored) {
            // нет разрешения на уведомления
        }
    }

    private void stop() {
        silence();
        key = null;
        AlarmActivity.closeAll();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).cancel(NOTIFICATION_ID);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        silence();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
