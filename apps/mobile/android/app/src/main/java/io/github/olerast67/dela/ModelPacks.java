package io.github.olerast67.dela;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Модели распознавания, которые пользователь скачивает кнопкой в настройках: в APK их нет.
 * Каждый файл закреплён за адресом конкретного выпуска и сверяется по SHA-256; кроме этих адресов
 * распознавание в сеть не ходит. Файлы лежат в files приложения и удаляются кнопкой «Удалить».
 */
final class ModelPacks {
    static final class Item {
        final String name;
        final String url;
        final long size;
        final String sha256;

        Item(String name, String url, long size, String sha256) {
            this.name = name;
            this.url = url;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    static final class Pack {
        final String id;
        final String dir;
        final Item[] items;

        Pack(String id, String dir, Item... items) {
            this.id = id;
            this.dir = dir;
            this.items = items;
        }

        long total() {
            long t = 0;
            for (Item i : items) t += i.size;
            return t;
        }
    }

    /** Отмена скачивания кнопкой. */
    static final class CancelledException extends IOException {
        CancelledException() {
            super("cancelled");
        }
    }

    /** Скачанный файл не совпал с ожидаемым. */
    static final class ChecksumException extends IOException {
        ChecksumException(String name) {
            super("checksum mismatch: " + name);
        }
    }

    interface Progress {
        void onProgress(long done, long total);
    }

    // Языковые данные Tesseract tessdata_fast, выпуск 4.1.0 (Apache-2.0), github.com/tesseract-ocr/tessdata_fast.
    private static final String TESS = "https://github.com/tesseract-ocr/tessdata_fast/raw/4.1.0/";
    // Модели sherpa-onnx от его автора на Hugging Face, закреплённые за коммитом, те же, что в Суфлёре.
    // Русская: малый потоковый Zipformer alphacep (vosk), int8, Apache-2.0.
    private static final String RU = "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16/resolve/31fa603e4f31279c6e1f7600fed13dc4312663ab/";
    // Английская: потоковый Zipformer icefall на LibriSpeech (2023-06-26), int8, Apache-2.0.
    private static final String EN = "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24/";

    static final Pack OCR = new Pack(
        "ocr",
        "ocr/tessdata",
        new Item("rus.traineddata", TESS + "rus.traineddata", 3861738, "e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225"),
        new Item("eng.traineddata", TESS + "eng.traineddata", 4113088, "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2")
    );

    static final Pack SPEECH_RU = new Pack(
        "ru",
        "asr/ru",
        new Item("encoder.int8.onnx", RU + "encoder.int8.onnx", 26214060, "e0db705e94ec35d803b1df4f40cda23d064e1142977c80ab288430b109777a9d"),
        new Item("decoder.onnx", RU + "decoder.onnx", 2093080, "89b3088a9e20e1ef7f2e85ce1a3478afe6a9c4ac57369cabcc4beb8e95328ea0"),
        new Item("joiner.int8.onnx", RU + "joiner.int8.onnx", 259417, "b55784b071ab7512eab4c7c44e4f5478284ef33c83562cc6a249b972515a31e5"),
        new Item("tokens.txt", RU + "tokens.txt", 6388, "93bbbc0bae6b78c0bbb743d4aa9fded3bb5ff3aac5f0200e3a769a5a05e0fdf6")
    );

    static final Pack SPEECH_EN = new Pack(
        "en",
        "asr/en",
        new Item("encoder.int8.onnx", EN + "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx", 71083163, "563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1"),
        new Item("decoder.onnx", EN + "decoder-epoch-99-avg-1-chunk-16-left-128.onnx", 2092621, "7bf787f90b194b307e5a4ad6a34fadb4e748304c35f78a8d66358a05b13ee6ef"),
        new Item("joiner.int8.onnx", EN + "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx", 259335, "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297"),
        new Item("tokens.txt", EN + "tokens.txt", 5048, "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb")
    );

    static final Pack[] ALL = {OCR, SPEECH_RU, SPEECH_EN};

    private ModelPacks() {}

    static Pack byId(String id) {
        for (Pack p : ALL) if (p.id.equals(id)) return p;
        return null;
    }

    static File dir(Context c, Pack p) {
        return new File(c.getFilesDir(), p.dir);
    }

    /** Модель скачана целиком: все файлы на месте и нужного размера (хэш проверен при скачивании). */
    static boolean ready(Context c, Pack p) {
        File d = dir(c, p);
        for (Item i : p.items) {
            File f = new File(d, i.name);
            if (!f.isFile() || f.length() != i.size) return false;
        }
        return true;
    }

    /** Сколько места модель уже занимает. */
    static long bytesOnDisk(Context c, Pack p) {
        long n = 0;
        File d = dir(c, p);
        for (Item i : p.items) n += new File(d, i.name).length();
        return n;
    }

    /** Скачать недостающие файлы модели. Каждый пишется во временный файл и переименовывается после проверки хэша. */
    static void download(Context c, Pack p, AtomicBoolean cancel, Progress progress) throws IOException {
        File d = dir(c, p);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("mkdirs");
        long need = 0;
        for (Item i : p.items) {
            File f = new File(d, i.name);
            if (!f.isFile() || f.length() != i.size) need += i.size;
        }
        if (d.getUsableSpace() < need + 20L * 1024 * 1024) throw new NoSpaceException();
        long total = p.total();
        long done = 0;
        for (Item i : p.items) {
            File f = new File(d, i.name);
            if (f.isFile() && f.length() == i.size) {
                done += i.size;
                continue;
            }
            File part = new File(d, i.name + ".part");
            try {
                fetch(i, part, cancel, done, total, progress);
            } catch (IOException e) {
                part.delete();
                throw e;
            }
            if (!part.renameTo(f)) {
                part.delete();
                throw new IOException("rename");
            }
            done += i.size;
            progress.onProgress(done, total);
        }
    }

    /** Места на телефоне не хватает. */
    static final class NoSpaceException extends IOException {
        NoSpaceException() {
            super("no space");
        }
    }

    private static void fetch(Item item, File to, AtomicBoolean cancel, long before, long total, Progress progress) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException(e);
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(item.url).openConnection();
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(60_000);
        conn.setInstanceFollowRedirects(true);
        try {
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + code);
            long got = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel.get()) throw new CancelledException();
                    got += n;
                    if (got > item.size) throw new ChecksumException(item.name);
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                    progress.onProgress(before + got, total);
                }
            }
            if (got != item.size || !hex(md.digest()).equals(item.sha256)) throw new ChecksumException(item.name);
        } finally {
            conn.disconnect();
        }
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    /** Удалить модель целиком. */
    static void remove(Context c, Pack p) {
        File d = dir(c, p);
        File[] files = d.listFiles();
        if (files != null) for (File f : files) f.delete();
        d.delete();
    }
}
