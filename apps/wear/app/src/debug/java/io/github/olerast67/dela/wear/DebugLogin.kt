package io.github.olerast67.dela.wear

import android.content.Intent

/**
 * Только отладочная сборка: проверка в эмуляторе (.github/workflows/wear-emulator.yml) заполняет форму входа
 * из extras интента — ввод с клавиатуры часов через adb ненадёжен. Кнопку входа скрипт нажимает сам.
 */
object DebugLogin {
    fun credentials(intent: Intent?): Credentials? {
        val server = intent?.getStringExtra("dela.server") ?: return null
        return Credentials(server = server, email = intent.getStringExtra("dela.email").orEmpty(), password = intent.getStringExtra("dela.password").orEmpty())
    }
}
