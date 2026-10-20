package io.github.olerast67.dela.wear

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class TaskItem(
    val id: String,
    val title: String,
    val project: String?,
    val date: String,
    val time: String?,
    val priority: Int,
    val recurring: Boolean,
    val overdue: Boolean,
    val readOnly: Boolean,
)

data class ReminderItem(val key: String, val taskId: String, val at: Long, val title: String, val alarm: Boolean)

/** «Сегодня» от ядра (apps/wear/js/wear.ts, Snapshot). */
data class Snapshot(
    val email: String,
    val date: String,
    val offline: Boolean,
    val pending: Int,
    val overdue: List<TaskItem>,
    val today: List<TaskItem>,
    val reminders: List<ReminderItem>,
) {
    val all: List<TaskItem> get() = overdue + today

    companion object {
        fun parse(o: JSONObject) = Snapshot(
            email = o.optString("email"),
            date = o.optString("date"),
            offline = o.optBoolean("offline"),
            pending = o.optInt("pending"),
            overdue = tasks(o.optJSONArray("overdue")),
            today = tasks(o.optJSONArray("today")),
            reminders = o.optJSONArray("reminders").objects().map {
                ReminderItem(it.getString("key"), it.getString("taskId"), it.getLong("at"), it.getString("title"), it.optBoolean("alarm"))
            },
        )

        private fun tasks(a: JSONArray?) = a.objects().map {
            TaskItem(
                id = it.getString("id"),
                title = it.getString("title"),
                project = if (it.isNull("project")) null else it.getString("project"),
                date = it.getString("date"),
                time = if (it.isNull("time")) null else it.getString("time"),
                priority = it.optInt("priority", 4),
                recurring = it.optBoolean("recurring"),
                overdue = it.optBoolean("overdue"),
                readOnly = it.optBoolean("readOnly"),
            )
        }

        private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
    }
}

/**
 * Последний снимок «Сегодня» для мгновенного показа, плитки и будильников после перезагрузки.
 * Только названия и сроки, без ключей; лежит в закрытой папке приложения и не попадает в резервные копии.
 */
object Cache {
    private fun file(ctx: Context) = AtomicFile(File(ctx.noBackupFilesDir, "today.json"))

    fun save(ctx: Context, snapshot: JSONObject) {
        val f = file(ctx)
        val out = f.startWrite()
        try {
            out.write(snapshot.toString().toByteArray())
            f.finishWrite(out)
        } catch (e: Exception) {
            f.failWrite(out)
        }
    }

    fun load(ctx: Context): Snapshot? = try {
        val f = file(ctx)
        if (f.baseFile.exists()) Snapshot.parse(JSONObject(f.readFully().toString(Charsets.UTF_8))) else null
    } catch (e: Exception) {
        null
    }

    fun clear(ctx: Context) {
        file(ctx).delete()
    }
}
