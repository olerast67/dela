package io.github.olerast67.dela.wear

/** Значение параметра формы olerast.com: латиница, цифры, точка и дефис, до 40 знаков. Лишнее сайт отбрасывает. */
private val REPORT_VALUE = Regex("^[A-Za-z0-9.-]{1,40}$")

/**
 * Форма «Сообщить о баге» на olerast.com, как в веб-версии (apps/web/src/links.ts): сайт сам выбирает
 * проект Dela и подставляет версию, сборку, платформу и язык, пользователь их не вводит.
 */
fun bugReportUrl(version: String, build: String, lang: String): String {
    val params = listOf("project" to "dela", "v" to version, "build" to build, "platform" to "wearos", "lang" to if (lang == "ru") "ru" else "en")
    return "https://olerast.com/security?" + params.filter { REPORT_VALUE.matches(it.second) }.joinToString("&") { "${it.first}=${it.second}" } + "#report"
}
