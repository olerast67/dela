package io.github.olerast67.dela.wear

import android.content.Intent

/** В выпуске форма входа из интента не заполняется (отладочный вариант — src/debug). */
object DebugLogin {
    @Suppress("UNUSED_PARAMETER")
    fun credentials(intent: Intent?): Credentials? = null
}
