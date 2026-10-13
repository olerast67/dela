package io.github.olerast67.dela;

import android.app.Activity;
import android.content.Intent;
import android.speech.RecognizerIntent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;

/**
 * Голосовой ввод задачи через системное окно распознавания Android. Микрофон слушает система,
 * приложению разрешение на запись звука не нужно; просим распознавать на устройстве, если телефон умеет.
 * Распознанная фраза возвращается в поле быстрого добавления, где её разбирает тот же разборщик дат.
 */
@CapacitorPlugin(name = "VoiceInput")
public class VoiceInputPlugin extends Plugin {
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

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", recognizer("ru-RU").resolveActivity(getContext().getPackageManager()) != null);
        call.resolve(r);
    }

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
}
