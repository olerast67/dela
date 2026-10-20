package io.github.olerast67.dela;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Картинка или голосовое сообщение из «Поделиться»: файл копируется в кэш приложения, пока доступ к нему
 * действует, и ждёт распознавания. Последний присланный файл заменяет предыдущий; после распознавания
 * или отказа файл удаляется.
 */
final class SharedMedia {
    static final String IMAGE = "image";
    static final String AUDIO = "audio";
    /** Больше распознавать не берёмся: это уже не задача, а фильм. */
    private static final long MAX_BYTES = 100L * 1024 * 1024;

    /** Одна очередь на копирование и распознавание: распознавание начинается, когда файл уже скопирован. */
    static final ExecutorService QUEUE = Executors.newSingleThreadExecutor();

    private static volatile String kind;
    /** Номер присланного файла: конец распознавания старого файла не стирает новый. */
    private static volatile int generation;

    private SharedMedia() {}

    /** Вид файла по MIME-типу: image, audio или null, если это не картинка и не звук. */
    static String kindOf(String mime) {
        if (mime == null) return null;
        if (mime.startsWith("image/")) return IMAGE;
        if (mime.startsWith("audio/") || mime.equals("application/ogg")) return AUDIO;
        return null;
    }

    /** Принять файл из ACTION_SEND. Возвращает вид файла или null, если в Intent нет картинки или звука. */
    static String accept(Context c, Intent intent) {
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
            ClipData.Item item = intent.getClipData().getItemAt(0);
            uri = item.getUri();
        }
        if (uri == null) return null;
        String k = kindOf(intent.getType());
        if (k == null) k = kindOf(c.getContentResolver().getType(uri));
        if (k == null) return null;
        final Uri from = uri;
        final Context app = c.getApplicationContext();
        final int gen;
        synchronized (SharedMedia.class) {
            gen = ++generation;
            kind = k;
        }
        QUEUE.execute(() -> copy(app, from, gen));
        return k;
    }

    private static void copy(Context c, Uri uri, int gen) {
        File target = file(c);
        target.getParentFile().mkdirs();
        try (InputStream in = c.getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new IOException("no stream");
            byte[] buf = new byte[1 << 16];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) throw new IOException("too large");
                out.write(buf, 0, n);
            }
        } catch (Exception e) {
            target.delete();
            synchronized (SharedMedia.class) {
                if (gen == generation) kind = null;
            }
        }
    }

    static File file(Context c) {
        return new File(new File(c.getCacheDir(), "shared"), "media");
    }

    /** Вид файла, который ждёт распознавания, или null. */
    static String pending() {
        return kind;
    }

    static int generation() {
        return generation;
    }

    /**
     * Забыть присланный файл с номером gen и удалить его копию (в очереди: после идущего копирования).
     * Если за это время прислали новый файл, ничего не делает.
     */
    static void clear(Context c, int gen) {
        synchronized (SharedMedia.class) {
            if (gen != generation) return;
            kind = null;
        }
        final Context app = c.getApplicationContext();
        QUEUE.execute(() -> {
            synchronized (SharedMedia.class) {
                if (gen == generation) file(app).delete();
            }
        });
    }
}
