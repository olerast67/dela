package io.github.olerast67.dela;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Напоминания через UnifiedPush (ntfy и другие распространители), без сервисов Google.
 * Сервер шлёт обычный Web Push; распространитель передаёт его сюда, библиотека снимает шифрование
 * Web Push, а текст напоминания расшифровывается ключом, который знает только этот телефон.
 */
public class DelaPushService extends PushService {
    static final String PREFS = "dela_push";
    private static final String CHANNEL = "dela-reminders";

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String instance) {
        SharedPreferences.Editor e = prefs(this).edit().putString("url", endpoint.getUrl());
        if (endpoint.getPubKeySet() != null) {
            e.putString("p256dh", endpoint.getPubKeySet().getPubKey()).putString("auth", endpoint.getPubKeySet().getAuth());
        }
        e.apply();
        UnifiedPushPlugin.onEndpoint(this);
    }

    @Override
    public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String instance) {
        prefs(this).edit().remove("url").apply();
    }

    @Override
    public void onUnregistered(@NonNull String instance) {
        prefs(this).edit().remove("url").remove("p256dh").remove("auth").apply();
    }

    @Override
    public void onMessage(@NonNull PushMessage message, @NonNull String instance) {
        try {
            JSONObject outer = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            JSONObject r = new JSONObject(decrypt(outer.getString("p")));
            show(r.optString("t", getString(R.string.notify_task)), r.optString("b", ""), r.optString("id", null), r.optString("k", "dela"));
        } catch (Exception err) {
            // Без ключа или с чужим ключом показываем общее напоминание: текст на сервере не виден.
            show(getString(R.string.notify_generic_title), getString(R.string.notify_generic_text), null, "dela");
        }
    }

    /** base64(iv 12 байт ‖ шифротекст AES-GCM) ключом из настроек приложения. */
    private String decrypt(String b64) throws Exception {
        String key = prefs(this).getString("key", null);
        if (key == null) throw new IllegalStateException("no key");
        byte[] all = Base64.decode(b64, Base64.DEFAULT);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(Base64.decode(key, Base64.DEFAULT), "AES"), new GCMParameterSpec(128, Arrays.copyOfRange(all, 0, 12)));
        return new String(c.doFinal(Arrays.copyOfRange(all, 12, all.length)), StandardCharsets.UTF_8);
    }

    private void show(String title, String body, String taskId, String key) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.notify_channel), NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (taskId != null) open.putExtra(WidgetBridgePlugin.EXTRA_TASK_ID, taskId);
        open.setData(Uri.parse("dela://push/" + key.hashCode()));
        PendingIntent pi = PendingIntent.getActivity(this, key.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile_add)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // На экране блокировки без названия задачи: оно видно после разблокировки телефона.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_tile_add).setContentTitle(getString(R.string.notify_generic_title)).build()
            );
        try {
            nm.notify(key.hashCode(), n.build());
        } catch (SecurityException ignored) {
            // нет разрешения на уведомления
        }
    }
}
