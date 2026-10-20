package io.github.olerast67.dela.wear

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.define
import com.goterl.lazysodium.Sodium
import com.sun.jna.NativeLong
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Файл сессии: на часах зашифрован ключом Android Keystore, в тестах лежит в памяти. */
interface SessionStore {
    fun exists(): Boolean
    fun read(): String?
    fun write(json: String)
    fun remove()
}

/**
 * Функции приложения для ядра в QuickJS (globalThis.__host, контракт в apps/wear/js/host.ts).
 * Криптография — libsodium через lazysodium, те же примитивы, что у libsodium.js в ядре.
 * Без классов Android: тесты гоняют этот же код на компьютере.
 */
class Host(
    private val na: Sodium,
    private val store: SessionStore,
    private val deviceName: String,
    private val log: (String) -> Unit,
) {
    init {
        check(na.sodium_init() >= 0) { "sodium_init failed" }
    }

    fun install(qjs: QuickJs) {
        qjs.define("__host") {
            function("http") { a -> http(a.str(0), a.str(1), a.str(2), a.getOrNull(3) as String?) }
            function("randomHex") { a -> hex(random(a.int(0))) }
            function("zone") { a -> zone(a.long(0), a.str(1)) }
            function("defaultZone") { _ -> ZoneId.systemDefault().id }
            function<Any?>("log") { a -> log(a.str(0)); null }

            function("pwhash") { a -> hex(pwhash(a.int(0), unhex(a.str(1)), unhex(a.str(2)), a.long(3), a.long(4), a.int(5))) }
            function("kdf") { a -> hex(kdf(a.int(0), a.long(1), a.str(2), unhex(a.str(3)))) }
            function("aeadEncrypt") { a -> hex(aeadEncrypt(unhex(a.str(0)), unhex(a.str(1)), unhex(a.str(2)), unhex(a.str(3)))) }
            function("aeadDecrypt") { a -> aeadDecrypt(unhex(a.str(0)), unhex(a.str(1)), unhex(a.str(2)), unhex(a.str(3)))?.let(::hex) }
            function("generichash") { a -> hex(generichash(a.int(0), unhex(a.str(1)), unhex(a.str(2)))) }
            function("scalarmultBase") { a -> hex(scalarmultBase(unhex(a.str(0)))) }
            function("boxKeypair") { _ -> boxKeypair() }
            function("boxSeal") { a -> hex(boxSeal(unhex(a.str(0)), unhex(a.str(1)))) }
            function("boxSealOpen") { a -> boxSealOpen(unhex(a.str(0)), unhex(a.str(1)), unhex(a.str(2)))?.let(::hex) }
            function("boxEasy") { a -> hex(boxEasy(unhex(a.str(0)), unhex(a.str(1)), unhex(a.str(2)), unhex(a.str(3)))) }
            function("boxOpenEasy") { a -> boxOpenEasy(unhex(a.str(0)), unhex(a.str(1)), unhex(a.str(2)), unhex(a.str(3)))?.let(::hex) }
            function("signSeedKeypair") { a -> signSeedKeypair(unhex(a.str(0))) }
            function("signDetached") { a -> hex(signDetached(unhex(a.str(0)), unhex(a.str(1)))) }
            function("signVerifyDetached") { a -> signVerifyDetached(unhex(a.str(0)), unhex(a.str(1)), unhex(a.str(2))) }

            function("vaultExists") { _ -> store.exists() }
            function("vaultRead") { _ -> store.read() }
            function<Any?>("vaultWrite") { a -> store.write(a.str(0)); null }
            function<Any?>("vaultRemove") { _ -> store.remove(); null }
            function("deviceName") { _ -> deviceName }
        }
    }

    // ---------- сеть ----------

    /** Синхронный запрос: движок работает в своём потоке. Ответ — JSON {status, body} или {error}. */
    fun http(method: String, url: String, headers: String, body: String?): String = try {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 15_000
            c.readTimeout = 30_000
            c.instanceFollowRedirects = false
            val h = JSONObject(headers)
            for (k in h.keys()) c.setRequestProperty(k, h.getString(k))
            if (body != null) {
                c.doOutput = true
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = c.responseCode
            val stream = if (status >= 400) c.errorStream else c.inputStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            JSONObject().put("status", status).put("body", text).toString()
        } finally {
            c.disconnect()
        }
    } catch (e: IOException) {
        JSONObject().put("error", e.toString()).toString()
    }

    // ---------- время ----------

    fun zone(ms: Long, tz: String): String? = try {
        ZonedDateTime.ofInstant(Instant.ofEpochMilli(ms), ZoneId.of(tz)).format(WALL)
    } catch (e: DateTimeException) {
        null
    }

    // ---------- libsodium ----------

    fun random(n: Int): ByteArray = ByteArray(n).also { if (n > 0) na.randombytes_buf(it, n) }

    fun pwhash(len: Int, password: ByteArray, salt: ByteArray, ops: Long, mem: Long, alg: Int): ByteArray {
        val out = ByteArray(len)
        ok(na.crypto_pwhash(out, len.toLong(), password, password.size.toLong(), salt, ops, NativeLong(mem), alg), "crypto_pwhash")
        return out
    }

    /** Контекст crypto_kdf — ровно 8 байт, как у libsodium.js. */
    fun kdf(len: Int, subkeyId: Long, ctx: String, key: ByteArray): ByteArray {
        val out = ByteArray(len)
        ok(na.crypto_kdf_derive_from_key(out, len, subkeyId, ctx.toByteArray(Charsets.US_ASCII).copyOf(8), key), "crypto_kdf_derive_from_key")
        return out
    }

    fun aeadEncrypt(m: ByteArray, ad: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray {
        val c = ByteArray(m.size + MAC)
        ok(na.crypto_aead_xchacha20poly1305_ietf_encrypt(c, null, m, m.size.toLong(), ad.orNull(), ad.size.toLong(), null, nonce, key), "aead encrypt")
        return c
    }

    fun aeadDecrypt(c: ByteArray, ad: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? {
        if (c.size < MAC || nonce.size != 24 || key.size != 32) return null
        val m = ByteArray(c.size - MAC)
        return if (na.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, null, c, c.size.toLong(), ad.orNull(), ad.size.toLong(), nonce, key) == 0) m else null
    }

    fun generichash(len: Int, m: ByteArray, key: ByteArray): ByteArray {
        val out = ByteArray(len)
        ok(na.crypto_generichash(out, len, m, m.size.toLong(), key.orNull(), key.size), "crypto_generichash")
        return out
    }

    fun scalarmultBase(sk: ByteArray): ByteArray {
        val q = ByteArray(32)
        ok(na.crypto_scalarmult_base(q, sk), "crypto_scalarmult_base")
        return q
    }

    fun boxKeypair(): String {
        val pk = ByteArray(32)
        val sk = ByteArray(32)
        ok(na.crypto_box_keypair(pk, sk), "crypto_box_keypair")
        return "${hex(pk)}:${hex(sk)}"
    }

    fun boxSeal(m: ByteArray, pk: ByteArray): ByteArray {
        val c = ByteArray(m.size + SEAL)
        ok(na.crypto_box_seal(c, m, m.size.toLong(), pk), "crypto_box_seal")
        return c
    }

    fun boxSealOpen(c: ByteArray, pk: ByteArray, sk: ByteArray): ByteArray? {
        if (c.size < SEAL || pk.size != 32 || sk.size != 32) return null
        val m = ByteArray(c.size - SEAL)
        return if (na.crypto_box_seal_open(m, c, c.size.toLong(), pk, sk) == 0) m else null
    }

    fun boxEasy(m: ByteArray, nonce: ByteArray, pk: ByteArray, sk: ByteArray): ByteArray {
        val c = ByteArray(m.size + MAC)
        ok(na.crypto_box_easy(c, m, m.size.toLong(), nonce, pk, sk), "crypto_box_easy")
        return c
    }

    fun boxOpenEasy(c: ByteArray, nonce: ByteArray, pk: ByteArray, sk: ByteArray): ByteArray? {
        if (c.size < MAC || nonce.size != 24 || pk.size != 32 || sk.size != 32) return null
        val m = ByteArray(c.size - MAC)
        return if (na.crypto_box_open_easy(m, c, c.size.toLong(), nonce, pk, sk) == 0) m else null
    }

    fun signSeedKeypair(seed: ByteArray): String {
        val pk = ByteArray(32)
        val sk = ByteArray(64)
        ok(na.crypto_sign_seed_keypair(pk, sk, seed), "crypto_sign_seed_keypair")
        return "${hex(pk)}:${hex(sk)}"
    }

    fun signDetached(m: ByteArray, sk: ByteArray): ByteArray {
        val sig = ByteArray(64)
        ok(na.crypto_sign_detached(sig, null, m, m.size.toLong(), sk), "crypto_sign_detached")
        return sig
    }

    fun signVerifyDetached(sig: ByteArray, m: ByteArray, pk: ByteArray): Boolean =
        sig.size == 64 && pk.size == 32 && na.crypto_sign_verify_detached(sig, m, m.size.toLong(), pk) == 0

    private fun ok(rc: Int, what: String) {
        if (rc != 0) throw IllegalStateException("$what failed")
    }

    companion object {
        private const val MAC = 16
        private const val SEAL = 48
        private val WALL: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss", Locale.ROOT)

        private val HEX = "0123456789abcdef".toCharArray()

        fun hex(b: ByteArray): String {
            val out = CharArray(b.size * 2)
            for (i in b.indices) {
                val v = b[i].toInt() and 0xff
                out[i * 2] = HEX[v ushr 4]
                out[i * 2 + 1] = HEX[v and 15]
            }
            return String(out)
        }

        fun unhex(s: String): ByteArray {
            require(s.length % 2 == 0) { "odd hex length" }
            return ByteArray(s.length / 2) { i -> ((Character.digit(s[i * 2], 16) shl 4) or Character.digit(s[i * 2 + 1], 16)).toByte() }
        }

        private fun ByteArray.orNull(): ByteArray? = if (isEmpty()) null else this

        private fun Array<Any?>.str(i: Int): String = this[i] as String
        private fun Array<Any?>.long(i: Int): Long = (this[i] as Number).toLong()
        private fun Array<Any?>.int(i: Int): Int = (this[i] as Number).toInt()
    }
}
