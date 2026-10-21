package io.github.olerast67.dela;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.speech.RecognizerIntent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Голосовой ввод задачи. По умолчанию — запись с микрофона и распознавание на телефоне (LiveTranscriber,
 * модель речи из настроек): звук не покидает телефон. Разрешение на микрофон спрашивается при первом нажатии.
 * Системное окно распознавания Android (listen) — только если пользователь выбрал его сам: на многих
 * телефонах (Samsung и другие) оно отправляет звук в облако Google или производителя.
 * Распознанная фраза возвращается в поле быстрого добавления, где её разбирает тот же разборщик дат.
 * Коды ошибок записи: unsupported, no_model, permission, no_mic, busy, cancelled, failed.
 */
@CapacitorPlugin(name = "VoiceInput", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
public class VoiceInputPlugin extends Plugin {
    private static final ExecutorService RECORDER = Executors.newSingleThreadExecutor();

    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile AtomicBoolean stop = new AtomicBoolean();
    private volatile AtomicBoolean cancel = new AtomicBoolean();

    private Intent recognizer(String lang) {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        // Подсказка на языке приложения, а не системы: язык распознавания передаёт веб-клиент.
        i.putExtra(
            RecognizerIntent.EXTRA_PROMPT,
            lang.startsWith("ru") ? "Скажите задачу, например: позвонить маме завтра в семь" : "Say a task, for example: call mom tomorrow at seven"
        );
        i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        return i;
    }

    private boolean systemAvailable() {
        return recognizer("ru-RU").resolveActivity(getContext().getPackageManager()) != null;
    }

    /** Модель для языка интерфейса, а если скачана только другая — она; null, если моделей нет. */
    private static ModelPacks.Pack model(Context c, String lang) {
        boolean en = lang.startsWith("en");
        ModelPacks.Pack first = en ? ModelPacks.SPEECH_EN : ModelPacks.SPEECH_RU;
        ModelPacks.Pack second = en ? ModelPacks.SPEECH_RU : ModelPacks.SPEECH_EN;
        if (ModelPacks.ready(c, first)) return first;
        if (ModelPacks.ready(c, second)) return second;
        return null;
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", systemAvailable() || AudioTranscriber.supported(getContext()));
        call.resolve(r);
    }

    /** Что умеет телефон: распознавание на устройстве, скачана ли модель, есть ли системное окно. */
    @PluginMethod
    public void support(PluginCall call) {
        Context c = getContext();
        String lang = call.getString("lang", "ru");
        JSObject r = new JSObject();
        r.put("offlineSupported", AudioTranscriber.supported(c));
        r.put("offlineReady", model(c, lang) != null);
        r.put("modelSize", (lang.startsWith("en") ? ModelPacks.SPEECH_EN : ModelPacks.SPEECH_RU).total());
        r.put("system", systemAvailable());
        call.resolve(r);
    }

    /** Системное окно распознавания (по выбору пользователя). */
    @PluginMethod
    public void listen(PluginCall call) {
        Intent i = recognizer(call.getString("lang", "ru-RU"));
        if (i.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject(getContext().getString(R.string.voice_unavailable), "unavailable");
            return;
        }
        startActivityForResult(call, i, "onResult");
    }

    @ActivityCallback
    private void onResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            ArrayList<String> matches = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (matches != null && !matches.isEmpty()) r.put("text", matches.get(0));
        }
        call.resolve(r);
    }

    /** Записать фразу и распознать её на телефоне. Ход записи — событием voice, результат — { text }. */
    @PluginMethod
    public void record(PluginCall call) {
        Context c = getContext();
        if (!AudioTranscriber.supported(c)) {
            call.reject("unsupported", "unsupported");
            return;
        }
        if (model(c, call.getString("lang", "ru")) == null) {
            call.reject("model not downloaded", "no_model");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "onMicPermission");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void onMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) start(call);
        else call.reject("permission denied", "permission");
    }

    private void start(PluginCall call) {
        if (!busy.compareAndSet(false, true)) {
            call.reject("busy", "busy");
            return;
        }
        Context c = getContext();
        ModelPacks.Pack pack = model(c, call.getString("lang", "ru"));
        if (pack == null) {
            busy.set(false);
            call.reject("model not downloaded", "no_model");
            return;
        }
        AtomicBoolean stopNow = new AtomicBoolean();
        AtomicBoolean cancelNow = new AtomicBoolean();
        stop = stopNow;
        cancel = cancelNow;
        RECORDER.execute(() -> {
            try {
                String text = LiveTranscriber.listen(ModelPacks.dir(c, pack), stopNow, cancelNow, new LiveTranscriber.Events() {
                    @Override
                    public void listening() {
                        JSObject e = new JSObject();
                        e.put("kind", "listening");
                        notifyListeners("voice", e);
                    }

                    @Override
                    public void partial(String text) {
                        JSObject e = new JSObject();
                        e.put("kind", "partial");
                        e.put("text", text);
                        notifyListeners("voice", e);
                    }

                    @Override
                    public void level(float level) {
                        JSObject e = new JSObject();
                        e.put("kind", "level");
                        e.put("level", level);
                        notifyListeners("voice", e);
                    }
                });
                JSObject r = new JSObject();
                r.put("text", text);
                call.resolve(r);
            } catch (ModelPacks.CancelledException e) {
                call.reject("cancelled", "cancelled");
            } catch (LiveTranscriber.NoMicException e) {
                call.reject("no mic", "no_mic");
            } catch (Throwable e) {
                // UnsatisfiedLinkError и ошибки модели тоже сюда.
                call.reject(String.valueOf(e.getMessage()), "failed");
            } finally {
                busy.set(false);
            }
        });
    }

    /** Второе нажатие на микрофон: закончить фразу и распознать сказанное. */
    @PluginMethod
    public void stop(PluginCall call) {
        stop.set(true);
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancel.set(true);
        call.resolve();
    }

    /** Приложение ушло в фон: микрофон не слушает невидимо. */
    @Override
    protected void handleOnPause() {
        cancel.set(true);
        super.handleOnPause();
    }
}
