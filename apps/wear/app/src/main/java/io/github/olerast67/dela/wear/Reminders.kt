package io.github.olerast67.dela.wear

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Напоминания на часах: свои будильники AlarmManager по снимку ядра (ближайшие двое суток),
 * без push с сервера и без сервисов Google. Снимок обновляется при каждой синхронизации.
 */
object Reminders {
    const val CHANNEL = "reminders"
    private const val PREFS = "reminders"
    private const val ACTION_FIRE = "io.github.olerast67.dela.wear.REMINDER"
    const val ACTION_DONE = "io.github.olerast67.dela.wear.DONE"
    const val EXTRA_KEY = "key"
    const val EXTRA_TASK = "task"
    const val EXTRA_TITLE = "title"
    const val EXTRA_ALARM = "alarm"
    const val EXTRA_NOTIFICATION = "notification"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Одинаковый ключ — тот же будильник: data в Intent делает их различимыми для AlarmManager. */
    private fun intent(ctx: Context, key: String) =
        Intent(ctx, ReminderReceiver::class.java).setAction(ACTION_FIRE).setData(Uri.parse("dela-reminder:${Uri.encode(key)}"))

    private fun pending(ctx: Context, key: String, r: ReminderItem?): PendingIntent {
        val i = intent(ctx, key)
        if (r != null) i.putExtra(EXTRA_KEY, r.key).putExtra(EXTRA_TASK, r.taskId).putExtra(EXTRA_TITLE, r.title).putExtra(EXTRA_ALARM, r.alarm)
        return PendingIntent.getBroadcast(ctx, key.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun schedule(ctx: Context, snap: Snapshot) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val p = prefs(ctx)
        val fired = p.getStringSet("fired", emptySet())!!
        val now = System.currentTimeMillis()
        val want = snap.reminders.filter { it.at > now - 60_000 && it.key !in fired }
        val keep = want.map { it.key }.toSet()
        for (old in p.getStringSet("keys", emptySet())!!) if (old !in keep) am.cancel(pending(ctx, old, null))
        val exact = android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
        for (r in want) {
            val pi = pending(ctx, r.key, r)
            if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.at, pi)
        }
        p.edit().putStringSet("keys", keep).apply()
    }

    fun cancelAll(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val p = prefs(ctx)
        for (k in p.getStringSet("keys", emptySet())!!) am.cancel(pending(ctx, k, null))
        p.edit().clear().apply()
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    /** Показанные не показываются снова при следующей расстановке; храним последние 200. */
    fun markFired(ctx: Context, key: String) {
        val p = prefs(ctx)
        val fired = (p.getStringSet("fired", emptySet())!!.toList() + key).takeLast(200).toSet()
        p.edit().putStringSet("fired", fired).apply()
    }

    fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, ctx.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH)
        ch.enableVibration(true)
        nm.createNotificationChannel(ch)
    }

    fun show(ctx: Context, key: String, taskId: String, title: String, alarm: Boolean) {
        if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        ensureChannel(ctx)
        val id = key.hashCode()
        val open = PendingIntent.getActivity(
            ctx, id, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val done = PendingIntent.getBroadcast(
            ctx, id,
            Intent(ctx, ReminderReceiver::class.java).setAction(ACTION_DONE).setData(Uri.parse("dela-done:${Uri.encode(key)}"))
                .putExtra(EXTRA_TASK, taskId).putExtra(EXTRA_NOTIFICATION, id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dela)
            .setContentTitle(title)
            .setContentText(ctx.getString(R.string.reminder_text))
            .setCategory(if (alarm) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(NotificationCompat.Action.Builder(0, ctx.getString(R.string.done_action), done).build())
            .build()
        NotificationManagerCompat.from(ctx).notify(id, n)
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            Reminders.ACTION_DONE -> {
                val task = intent.getStringExtra(Reminders.EXTRA_TASK) ?: return
                NotificationManagerCompat.from(ctx).cancel(intent.getIntExtra(Reminders.EXTRA_NOTIFICATION, 0))
                Sync.complete(ctx, task)
            }
            else -> {
                val key = intent.getStringExtra(Reminders.EXTRA_KEY) ?: return
                Reminders.markFired(ctx, key)
                Reminders.show(
                    ctx, key,
                    intent.getStringExtra(Reminders.EXTRA_TASK) ?: return,
                    intent.getStringExtra(Reminders.EXTRA_TITLE).orEmpty(),
                    intent.getBooleanExtra(Reminders.EXTRA_ALARM, false),
                )
            }
        }
    }
}

/** После перезагрузки, обновления и смены времени будильники ставятся заново из кэша, а потом приходит свежий снимок. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val snap = Cache.load(ctx) ?: return
        Reminders.schedule(ctx, snap)
        Sync.schedule(ctx)
        Sync.now(ctx)
    }
}
