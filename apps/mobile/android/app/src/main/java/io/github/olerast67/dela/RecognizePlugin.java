package io.github.olerast67.dela;

import android.content.Context;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Распознавание присланной картинки (Tesseract) и голосового сообщения (sherpa-onnx) на телефоне
 * и скачивание моделей для него. Всё тяжёлое идёт в фоновых потоках: интерфейс не ждёт, прогресс приходит
 * событиями progress и modelProgress, распознавание и скачивание отменяются.
 * Коды ошибок для веб-клиента: no_media, no_model, unsupported, cancelled, busy, checksum, no_space, network, failed.
 */
@CapacitorPlugin(name = "Recognize")
public class RecognizePlugin extends Plugin {
    private static final ExecutorService DOWNLOADS = Executors.newSingleThreadExecutor();

    private volatile AtomicBoolean recognizeCancel = new AtomicBoolean();
    private volatile AtomicBoolean downloadCancel = new AtomicBoolean();
    private volatile String downloading;

    private static boolean ocrSupported(Context c) {
        return new File(c.getApplicationInfo().nativeLibraryDir, "libtesseract.so").isFile();
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context c = getContext();
        JSObject r = new JSObject();
        for (ModelPacks.Pack p : ModelPacks.ALL) {
            JSObject s = new JSObject();
            s.put("ready", ModelPacks.ready(c, p));
            s.put("size", p.total());
            s.put("bytes", ModelPacks.bytesOnDisk(c, p));
            r.put(p.id, s);
        }
        r.put("ocrSupported", ocrSupported(c));
        r.put("speechSupported", AudioTranscriber.supported(c));
        r.put("downloading", downloading);
        r.put("pending", SharedMedia.pending());
        call.resolve(r);
    }

    @PluginMethod
    public void download(PluginCall call) {
        ModelPacks.Pack pack = ModelPacks.byId(call.getString("pack", ""));
        if (pack == null) {
            call.reject("unknown pack", "failed");
            return;
        }
        synchronized (this) {
            if (downloading != null) {
                call.reject("busy", "busy");
                return;
            }
            downloading = pack.id;
        }
        AtomicBoolean cancel = new AtomicBoolean();
        downloadCancel = cancel;
        Context c = getContext();
        DOWNLOADS.execute(() -> {
            long[] last = {0, -1};
            try {
                ModelPacks.download(c, pack, cancel, (done, total) -> {
                    // Не чаще пяти раз в секунду: событие идёт через мост в WebView.
                    long now = SystemClock.elapsedRealtime();
                    if (done < total && now - last[0] < 200) return;
                    last[0] = now;
                    JSObject e = new JSObject();
                    e.put("pack", pack.id);
                    e.put("done", done);
                    e.put("total", total);
                    notifyListeners("modelProgress", e);
                });
                downloading = null;
                call.resolve();
            } catch (ModelPacks.CancelledException e) {
                downloading = null;
                call.reject("cancelled", "cancelled");
            } catch (ModelPacks.ChecksumException e) {
                downloading = null;
                call.reject(e.getMessage(), "checksum");
            } catch (ModelPacks.NoSpaceException e) {
                downloading = null;
                call.reject("no space", "no_space");
            } catch (Exception e) {
                downloading = null;
                call.reject(String.valueOf(e.getMessage()), "network");
            }
        });
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        downloadCancel.set(true);
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        ModelPacks.Pack pack = ModelPacks.byId(call.getString("pack", ""));
        if (pack == null || pack.id.equals(downloading)) {
            call.reject("busy", "busy");
            return;
        }
        ModelPacks.remove(getContext(), pack);
        call.resolve();
    }

    /**
     * Распознать присланный файл. lang — язык приложения: голос распознаётся его моделью, а если она
     * не скачана, моделью другого языка. Без нужной модели файл остаётся ждать (no_model).
     */
    @PluginMethod
    public void recognize(PluginCall call) {
        Context c = getContext();
        String kind = SharedMedia.pending();
        int gen = SharedMedia.generation();
        if (kind == null) {
            call.reject("nothing shared", "no_media");
            return;
        }
        ModelPacks.Pack pack;
        if (SharedMedia.IMAGE.equals(kind)) {
            if (!ocrSupported(c)) {
                SharedMedia.clear(c, gen);
                call.reject("unsupported", "unsupported");
                return;
            }
            pack = ModelPacks.OCR;
        } else {
            if (!AudioTranscriber.supported(c)) {
                SharedMedia.clear(c, gen);
                call.reject("unsupported", "unsupported");
                return;
            }
            boolean en = call.getString("lang", "ru").startsWith("en");
            ModelPacks.Pack first = en ? ModelPacks.SPEECH_EN : ModelPacks.SPEECH_RU;
            ModelPacks.Pack second = en ? ModelPacks.SPEECH_RU : ModelPacks.SPEECH_EN;
            pack = ModelPacks.ready(c, first) ? first : second;
        }
        if (!ModelPacks.ready(c, pack)) {
            call.reject("model not downloaded", "no_model");
            return;
        }
        AtomicBoolean cancel = new AtomicBoolean();
        recognizeCancel = cancel;
        final ModelPacks.Pack model = pack;
        SharedMedia.QUEUE.execute(() -> {
            double[] last = {-1};
            try {
                File file = SharedMedia.file(c);
                if (gen != SharedMedia.generation() || !file.isFile()) throw new NoMediaException();
                String text;
                if (SharedMedia.IMAGE.equals(kind)) {
                    // Tesseract ищет папку tessdata внутри переданной.
                    text = OcrRecognizer.recognize(file, ModelPacks.dir(c, model).getParentFile(), cancel, (share) -> progress(last, share));
                } else {
                    text = AudioTranscriber.transcribe(file, ModelPacks.dir(c, model), cancel, (share) -> progress(last, share));
                }
                if (cancel.get()) throw new ModelPacks.CancelledException();
                SharedMedia.clear(c, gen);
                JSObject r = new JSObject();
                r.put("kind", kind);
                r.put("text", text);
                call.resolve(r);
            } catch (ModelPacks.CancelledException e) {
                SharedMedia.clear(c, gen);
                call.reject("cancelled", "cancelled");
            } catch (NoMediaException e) {
                call.reject("nothing shared", "no_media");
            } catch (Throwable e) {
                // UnsatisfiedLinkError и ошибки декодера тоже сюда: файл не распознать, держать его незачем.
                SharedMedia.clear(c, gen);
                call.reject(String.valueOf(e.getMessage()), "failed");
            }
        });
    }

    private void progress(double[] last, double share) {
        if (share - last[0] < 0.02 && share < 1) return;
        last[0] = share;
        JSObject e = new JSObject();
        e.put("share", share);
        notifyListeners("progress", e);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        recognizeCancel.set(true);
        call.resolve();
    }

    /** Отказаться от присланного файла: пользователь закрыл предложение скачать модель. */
    @PluginMethod
    public void discard(PluginCall call) {
        SharedMedia.clear(getContext(), SharedMedia.generation());
        call.resolve();
    }

    private static final class NoMediaException extends IOException {}
}
