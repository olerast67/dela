package io.github.olerast67.dela.wear

import com.goterl.lazysodium.Sodium
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Мост приложения и ядро в QuickJS на компьютере: тот же Host.kt и та же сборка dela-wear.js, что на часах,
 * только libsodium и QuickJS в сборках для JVM. Примитивы сверяются с libsodium.js (значения посчитаны им),
 * вход и выполнение — на сервере Dela, если задан DELA_WEAR_TEST_SERVER (см. apps/wear/scripts/dev-seed.ts).
 */
class EngineTest {
    private class MemoryStore : SessionStore {
        var data: String? = null
        override fun exists() = data != null
        override fun read() = data
        override fun write(json: String) { data = json }
        override fun remove() { data = null }
    }

    private val logs = mutableListOf<String>()
    private val store = MemoryStore()
    // SodiumJava есть только в тестовом classpath (там он вместо SodiumAndroid).
    private val sodium = Class.forName("com.goterl.lazysodium.SodiumJava").getDeclaredConstructor().newInstance() as Sodium
    private val host = Host(sodium, store, "Dela · Wear OS · JVM test") { logs += it; println("js: $it") }
    private val engine = Engine({ File(System.getProperty("dela.bundle")).readText() }, host)

    private fun h(s: String) = Host.unhex(s)

    @Test
    fun primitivesMatchLibsodiumJs() {
        val key = h("01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da")
        val salt = h("020910171e252c333a41484f565d646b")
        val nonce = h("030a11181f262d343b424950575e656c737a81888f969da4")
        val seed = h("040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dd")
        val pk = h("3da5d9b0c62aefed14a18c34332f18af1af55684ad54fb24617f4558d25d0259")
        val sk = h("e2df015186bf6cf9a189dee64ad3d2c062acb4cfee8b3ca8e22ab4053bb8315b")
        assertEquals("2f9e8636066a84a7c071b3e1da158a65671c5de3b5eb2e80640d5280cfe21e80", Host.hex(host.pwhash(32, "пароль".toByteArray(), salt, 2, 65536, 2)))
        assertEquals("9b18c15f18a61135111aab488f2ceb3c5a3942dc071e951b8d5cceb81737463f", Host.hex(host.kdf(32, 2, "dela_pwd", key)))
        assertEquals("12888b1d3848711def53aaab5d5f177c", Host.hex(host.generichash(16, "[\"task\",\"r\",\"title\"]".toByteArray(), key)))
        assertEquals("ec5c1a890abc613338756566e8fe82a4665ca1a264f99df26ce66a814a98", Host.hex(host.generichash(30, key, ByteArray(0))))
        val aead = "2a2d0484a7f2c22c52402aa4786cec56f6e41757cd4b721a0e989095b9083246437a7ddbb3"
        assertEquals(aead, Host.hex(host.aeadEncrypt("Купить хлеб".toByteArray(), "dela/op/v1".toByteArray(), nonce, key)))
        assertEquals("Купить хлеб", host.aeadDecrypt(h(aead), "dela/op/v1".toByteArray(), nonce, key)!!.toString(Charsets.UTF_8))
        assertNull(host.aeadDecrypt(h(aead), "другое".toByteArray(), nonce, key))
        val seal = "50e11ec6a54e00c9f71e59a99fc3490c07664402f62e953f573f18b3bcff9f443510c1eb856a87123fd4602d8deeedf0efae0a3ce6f4d311aa037290c11cf3d811f0e4a1ee04af24bdeecd70de1e7a66"
        assertArrayEquals(key, host.boxSealOpen(h(seal), pk, sk))
        assertNull(host.boxSealOpen(h(seal), pk, key))
        assertArrayEquals(pk, host.scalarmultBase(sk))
        assertEquals("fc1a1a5a21a34c58b446db5f6a90ea48d5d8cdcc2506012f4a513a6c67ff5d8f", host.signSeedKeypair(seed).substringBefore(':'))
        val signSk = h(host.signSeedKeypair(seed).substringAfter(':'))
        val sig = "827808b54a17dec1a81aae25ab820e6de066088e3392707d5198cd4c0439f44d9a4dd481d215bb56c03fed2a482e251bddf28d35ee08bdc069dbef32304bd905"
        assertEquals(sig, Host.hex(host.signDetached("dela".toByteArray(), signSk)))
        assertTrue(host.signVerifyDetached(h(sig), "dela".toByteArray(), h("fc1a1a5a21a34c58b446db5f6a90ea48d5d8cdcc2506012f4a513a6c67ff5d8f")))
        assertEquals("2026-03-29 03:30:00", host.zone(1774744200000, "Europe/Moscow"))
        assertNull(host.zone(0, "Mars/Olympus"))
    }

    @Test
    fun bundleRunsInQuickJs() = runBlocking {
        assertEquals(false, engine.call("status").getBoolean("signedIn"))
        assertEquals("signed_out", engine.call("today").getString("error"))
        assertEquals("bad_server", engine.call("login", JSONObject().put("server", "http://dela.example.com")).getString("error"))
        // Сервера нет: ошибка сети, а не падение движка.
        assertEquals("network", engine.call("login", JSONObject().put("server", "http://127.0.0.1:9").put("email", "a@b.c").put("password", "x")).getString("error"))
        assertEquals("unknown_method", engine.call("nope").getString("error"))
    }

    private fun titles(a: JSONArray) = (0 until a.length()).map { a.getJSONObject(it).getString("title") }

    private fun find(s: JSONObject, title: String): JSONObject? =
        listOf(s.getJSONArray("overdue"), s.getJSONArray("today")).flatMap { a -> (0 until a.length()).map { a.getJSONObject(it) } }.firstOrNull { it.getString("title") == title }

    @Test
    fun loginTodayCompleteOnServer() = runBlocking {
        val server = System.getProperty("dela.server").orEmpty()
        assumeTrue("DELA_WEAR_TEST_SERVER is not set", server.isNotEmpty())
        val email = System.getenv("DELA_WEAR_TEST_EMAIL") ?: "watch@example.com"
        val password = System.getenv("DELA_WEAR_TEST_PASSWORD") ?: "пароль часов"

        assertEquals("invalid_credentials", engine.call("login", JSONObject().put("server", server).put("email", email).put("password", "не тот")).getString("error"))
        val t0 = System.nanoTime()
        val snap = engine.call("login", JSONObject().put("server", server).put("email", email).put("password", password))
        println("login took ${(System.nanoTime() - t0) / 1_000_000} ms: $snap")
        assertFalse(snap.toString(), snap.has("error"))
        assertTrue(snap.getBoolean("signedIn"))
        assertNotNull(store.data)
        assertEquals(listOf("Оплатить интернет"), titles(snap.getJSONArray("overdue")))
        assertTrue(titles(snap.getJSONArray("today")).containsAll(listOf("Позвонить маме", "Полить цветы")))
        assertEquals("Дом", find(snap, "Полить цветы")!!.getString("project"))
        assertTrue(find(snap, "Полить цветы")!!.getBoolean("recurring"))
        assertTrue(snap.getJSONArray("reminders").length() >= 1)

        // Отметка на часах уходит на сервер сразу: в очереди ничего не остаётся.
        val call = find(snap, "Позвонить маме")!!.getString("id")
        val after = engine.call("complete", JSONObject().put("id", call))
        assertEquals(0, after.getInt("pending"))
        assertNull(find(after, "Позвонить маме"))
        val daily = find(after, "Полить цветы")!!.getString("id")
        val after2 = engine.call("complete", JSONObject().put("id", daily))
        assertNull(find(after2, "Полить цветы"))
        assertEquals(0, after2.getInt("pending"))

        // Новый движок с тем же файлом сессии: всё из кэша, затем с сервера.
        val again = Engine({ File(System.getProperty("dela.bundle")).readText() }, host)
        val cached = again.call("today")
        assertNull(find(cached, "Позвонить маме"))
        assertFalse(again.call("sync").has("error"))
        if (System.getenv("DELA_WEAR_TEST_KEEP") == null) {
            assertEquals(false, again.call("logout").getBoolean("signedIn"))
            assertNull(store.data)
        }
    }
}
