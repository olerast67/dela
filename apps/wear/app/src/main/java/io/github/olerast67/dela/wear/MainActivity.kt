package io.github.olerast67.dela.wear

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.wear.remote.interactions.RemoteActivityHelper
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Locale

private sealed interface Screen {
    data object Loading : Screen
    data class SignIn(val needTotp: Boolean = false) : Screen
    data class Today(val snap: Snapshot) : Screen
}

/** Экран часов: вход или список «Сегодня» с отметкой «выполнено». Вид — в Ui.kt. */
class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf<Screen>(Screen.Loading)
    private var busy by mutableStateOf(false)
    private var message by mutableStateOf<String?>(null)
    private var completing by mutableStateOf(setOf<String>())
    private var confirmSignOut by mutableStateOf(false)
    private var form by mutableStateOf(Credentials())

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Cache.load(this)?.let { screen = Screen.Today(it) }
        // Только в отладочной сборке: форма из интента для проверки в эмуляторе.
        DebugLogin.credentials(intent)?.let { form = it }
        setContent {
            val s = screen
            DelaScreen(page = s::class) { list ->
                when (s) {
                    Screen.Loading -> LoadingScreen()
                    is Screen.SignIn -> SignInScreen(list, form, s.needTotp, busy, message, { form = it }, ::signIn)
                    is Screen.Today -> TodayScreen(list, s.snap, completing, busy, message, confirmSignOut, ::complete, ::refresh, ::signOut, ::reportBug)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    /** При открытии: снимок из кэша сразу, затем синхронизация с сервером. */
    private fun refresh() {
        if (screen is Screen.SignIn || busy) return
        lifecycleScope.launch {
            busy = true
            try {
                if (screen is Screen.Loading) {
                    if (!Dela.call(this@MainActivity, "status").optBoolean("signedIn")) {
                        screen = Screen.SignIn()
                        return@launch
                    }
                    show(Dela.call(this@MainActivity, "today"))
                }
                show(Dela.call(this@MainActivity, "sync"))
            } finally {
                busy = false
            }
        }
    }

    private fun show(r: JSONObject) {
        when {
            r.has("today") -> {
                screen = Screen.Today(Snapshot.parse(r))
                message = null
            }
            r.optString("error") == "signed_out" -> {
                screen = Screen.SignIn()
                message = getString(R.string.error_signed_out)
            }
            else -> message = errorText(r.optString("error"))
        }
    }

    private fun errorText(code: String): String = getString(
        when (code) {
            "invalid_credentials" -> R.string.error_invalid_credentials
            "totp_required" -> R.string.error_totp_required
            "invalid_totp" -> R.string.error_invalid_totp
            "rate_limited" -> R.string.error_rate_limited
            "network" -> R.string.error_network
            "bad_server" -> R.string.error_bad_server
            "read_only" -> R.string.error_read_only
            else -> R.string.error_generic
        },
    )

    private fun signIn() {
        if (busy) return
        lifecycleScope.launch {
            busy = true
            message = null
            val f = form
            val args = JSONObject().put("server", f.server).put("email", f.email).put("password", f.password)
            if (f.totp.isNotBlank()) args.put("totp", f.totp)
            val r = Dela.call(this@MainActivity, "login", args)
            busy = false
            when {
                r.has("today") -> {
                    form = f.copy(password = "", totp = "")
                    show(r)
                    requestNotifications()
                }
                r.optString("error") == "totp_required" -> {
                    screen = Screen.SignIn(needTotp = true)
                    message = errorText("totp_required")
                }
                else -> message = errorText(r.optString("error"))
            }
        }
    }

    private fun complete(t: TaskItem) {
        if (t.id in completing) return
        completing = completing + t.id
        lifecycleScope.launch {
            show(Dela.call(this@MainActivity, "complete", JSONObject().put("id", t.id)))
            completing = completing - t.id
        }
    }

    private fun signOut() {
        if (!confirmSignOut) {
            confirmSignOut = true
            return
        }
        confirmSignOut = false
        lifecycleScope.launch {
            busy = true
            Dela.call(this@MainActivity, "logout")
            busy = false
            message = null
            screen = Screen.SignIn()
        }
    }

    /** Форма «Сообщить о баге» открывается на телефоне: набирать текст на часах неудобно. */
    private fun reportBug() {
        val url = bugReportUrl(BuildConfig.VERSION_NAME, BuildConfig.GIT_BUILD, Locale.getDefault().language)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        val future = try {
            RemoteActivityHelper(this).startRemoteActivity(intent)
        } catch (e: Exception) {
            message = getString(R.string.report_bug_no_phone)
            return
        }
        future.addListener({
            message = try {
                future.get()
                getString(R.string.report_bug_opened)
            } catch (e: Exception) {
                getString(R.string.report_bug_no_phone)
            }
        }, mainExecutor)
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
