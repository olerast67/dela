package io.github.olerast67.dela.wear

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Файл сессии часов: токен, главный ключ аккаунта, ключи пространств и кэш задач.
 * Зашифрован AES-256-GCM ключом из Android Keystore, который не покидает устройство.
 * Формат: iv (12 байт) ‖ шифротекст с тегом.
 */
class KeystoreSession(context: Context) : SessionStore {
    private val file = AtomicFile(File(context.filesDir, "session.bin"))

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun exists(): Boolean = file.baseFile.exists()

    override fun read(): String? {
        if (!exists()) return null
        return try {
            val raw = file.readFully()
            val c = Cipher.getInstance(AES)
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, IV))
            c.updateAAD(AAD)
            c.doFinal(raw, IV, raw.size - IV).toString(Charsets.UTF_8)
        } catch (e: Exception) {
            // Ключ Keystore пропал (сброс блокировки экрана, восстановление): сессия не читается, нужен новый вход.
            remove()
            null
        }
    }

    override fun write(json: String) {
        val c = Cipher.getInstance(AES)
        c.init(Cipher.ENCRYPT_MODE, key())
        c.updateAAD(AAD)
        val body = c.doFinal(json.toByteArray(Charsets.UTF_8))
        val out = file.startWrite()
        try {
            out.write(c.iv)
            out.write(body)
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    override fun remove() {
        file.delete()
        // Новый вход создаст новый ключ.
        runCatching { KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(ALIAS) }
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "dela-session"
        private const val AES = "AES/GCM/NoPadding"
        private const val IV = 12
        private val AAD = "dela-wear session v1".toByteArray()
    }
}
