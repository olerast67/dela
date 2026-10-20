package io.github.olerast67.dela.wear

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.wear.tiles.TileService
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.goterl.lazysodium.SodiumAndroid
import org.json.JSONObject
import java.time.ZoneId
import java.util.concurrent.TimeUnit

/**
 * Вход в ядро для всего приложения: экран, фоновая синхронизация, уведомления и плитка зовут одно ядро.
 * После каждого ответа со снимком «Сегодня» обновляются кэш, будильники напоминаний и плитка.
 */
object Dela {
    private const val TAG = "Dela"
    private var engine: Engine? = null
    /** Пояс, с которым запущено ядро: «сегодня» и сроки считаются в нём. */
    private var engineZone: String? = null

    @Synchronized
    private fun engine(ctx: Context): Engine = engine ?: Engine(
        { ctx.assets.open("dela-wear.js").use { it.readBytes().toString(Charsets.UTF_8) } },
        Host(SodiumAndroid(), KeystoreSession(ctx), deviceName()) { Log.i(TAG, it) },
    ).also { engine = it }

    /** Часы сменили пояс (перелёт): ядро перезапускается и берёт новый. */
    private suspend fun engineFor(ctx: Context): Engine {
        val e = engine(ctx)
        val zone = ZoneId.systemDefault().id
        if (engineZone != null && engineZone != zone) e.reset()
        engineZone = zone
        return e
    }

    /** Так часы видны в списке устройств Dela на телефоне и компьютере; оттуда их можно отозвать. */
    fun deviceName(): String = "Dela · Wear OS · ${Build.MODEL}".take(60)

    suspend fun call(context: Context, name: String, args: JSONObject = JSONObject()): JSONObject {
        val ctx = context.applicationContext
        val r = try {
            engineFor(ctx).call(name, args)
        } catch (e: Exception) {
            Log.e(TAG, "$name failed", e)
            JSONObject().put("error", "internal")
        }
        when {
            r.has("today") -> {
                Cache.save(ctx, r)
                Reminders.schedule(ctx, Snapshot.parse(r))
                Sync.schedule(ctx)
                refreshTile(ctx)
            }
            r.optString("error") == "signed_out" || (name == "logout" && !r.has("error")) -> signedOut(ctx)
        }
        return r
    }

    private fun signedOut(ctx: Context) {
        Cache.clear(ctx)
        Reminders.cancelAll(ctx)
        Sync.cancel(ctx)
        refreshTile(ctx)
    }

    fun refreshTile(ctx: Context) {
        runCatching { TileService.getUpdater(ctx).requestUpdate(TodayTileService::class.java) }
    }
}

/** Синхронизация раз в полчаса, когда есть сеть: новые задачи и напоминания приходят без открытия приложения. */
object Sync {
    private const val PERIODIC = "dela-sync"

    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun now(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniqueWork("dela-sync-now", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<SyncWorker>().build())
    }

    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC)
    }

    /** Отметка из уведомления: выполняется в фоне, без открытого приложения. */
    fun complete(ctx: Context, taskId: String) {
        val req = OneTimeWorkRequestBuilder<CompleteWorker>().setInputData(workDataOf(CompleteWorker.TASK to taskId)).build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("dela-complete-$taskId", ExistingWorkPolicy.KEEP, req)
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        Dela.call(applicationContext, "sync")
        return Result.success()
    }
}

class CompleteWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val id = inputData.getString(TASK) ?: return Result.failure()
        Dela.call(applicationContext, "complete", JSONObject().put("id", id))
        return Result.success()
    }

    companion object {
        const val TASK = "task"
    }
}
