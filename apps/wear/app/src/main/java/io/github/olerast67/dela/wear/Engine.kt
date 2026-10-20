package io.github.olerast67.dela.wear

import com.dokar.quickjs.QuickJs
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Ядро Dela (packages/core и клиент dela-mcp), собранное в один файл и исполняемое QuickJS.
 * Один поток на всё: QuickJS не потокобезопасен, а функции приложения (сеть, Argon2id) синхронные.
 * Вызовы идут по одному, ответ — JSON-объект; ошибка — {"error": код}.
 */
class Engine(private val bundle: () -> String, private val host: Host) {
    // Свой стек побольше: разбор JSON и сортировки в QuickJS рекурсивны.
    private val dispatcher = Executors.newSingleThreadExecutor { r -> Thread(null, r, "dela-js", 16L shl 20) }.asCoroutineDispatcher()
    private val mutex = Mutex()
    private var qjs: QuickJs? = null

    suspend fun call(name: String, args: JSONObject = JSONObject()): JSONObject = mutex.withLock {
        withContext(dispatcher) {
            val js = qjs ?: start().also { qjs = it }
            val out = js.evaluate<String>("await DelaWear.call(${JSONObject.quote(name)}, ${JSONObject.quote(args.toString())})", "call.js", false)
            JSONObject(out)
        }
    }

    private suspend fun start(): QuickJs {
        val js = QuickJs.create(dispatcher)
        js.maxStackSize = 8L shl 20
        host.install(js)
        js.evaluate<Any?>(bundle(), "dela-wear.js", false)
        return js
    }

    /** Закрыть движок: следующий вызов заново прочитает сессию. */
    suspend fun reset() = mutex.withLock {
        withContext(dispatcher) {
            qjs?.close()
            qjs = null
        }
    }
}
