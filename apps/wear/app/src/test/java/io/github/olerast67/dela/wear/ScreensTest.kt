package io.github.olerast67.dela.wear

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Экраны часов на компьютере: Robolectric рисует Compose по-настоящему, снимки — в app/build/screenshots.
 * Эталонов нет: тест ловит падения вёрстки, а картинки смотрят глазами.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "ru-w227dp-h227dp-round-watch-xhdpi")
class ScreensTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun shot(name: String, content: @Composable () -> Unit) {
        compose.setContent(content)
        // ScalingLazyColumn показывает список после первого кадра.
        compose.mainClock.advanceTimeBy(1000)
        compose.waitForIdle()
        // Окно рисуется прямо в Bitmap: так же снимает Roborazzi, без ожидания кадра от системы.
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { view.draw(Canvas(bitmap)) }
        val dir = File(System.getProperty("dela.screenshots") ?: "build/screenshots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun task(id: String, title: String, project: String? = null, time: String? = null, overdue: Boolean = false, recurring: Boolean = false, readOnly: Boolean = false) =
        TaskItem(id, title, project, if (overdue) "2026-10-19" else "2026-10-20", time, 4, recurring, overdue, readOnly)

    private val snap = Snapshot(
        email = "watch@example.com",
        date = "2026-10-20",
        offline = false,
        pending = 0,
        overdue = listOf(task("1", "Оплатить интернет", project = "Дом", overdue = true)),
        today = listOf(
            task("2", "Позвонить маме"),
            task("3", "Полить цветы", project = "Дом", recurring = true),
            task("4", "Созвон с командой", time = "19:34"),
            task("5", "Посмотреть план проекта", project = "Работа", readOnly = true),
        ),
        reminders = emptyList(),
    )

    @Test
    fun today() = shot("today") {
        DelaScreen { list -> TodayScreen(list, snap, setOf("2"), busy = false, message = null, confirmSignOut = false, onComplete = {}, onRefresh = {}, onSignOut = {}) }
    }

    @Test
    fun todayEmptyOffline() = shot("today-empty-offline") {
        DelaScreen { list -> TodayScreen(list, snap.copy(overdue = emptyList(), today = emptyList(), offline = true), emptySet(), false, null, false, {}, {}, {}) }
    }

    @Test
    fun signIn() = shot("sign-in") {
        DelaScreen { list ->
            SignInScreen(list, Credentials("dela.example.com", "watch@example.com", "пароль"), needTotp = false, busy = false, message = "Неверная почта или пароль", onChange = {}, onSignIn = {})
        }
    }
}
