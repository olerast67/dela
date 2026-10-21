package io.github.olerast67.dela;

import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineStream;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Голосовой ввод задачи без облака: AudioRecord пишет 16 кГц моно, sherpa-onnx распознаёт звук на телефоне
 * той же моделью, что и голосовые сообщения. Запись кончается паузой после слов (конец фразы определяет
 * сама модель), кнопкой «Стоп» или через 30 секунд. Звук никуда не сохраняется и не отправляется.
 */
final class LiveTranscriber {
    static final int RATE = 16000;
    /** Дольше одна диктовка не длится. */
    private static final long MAX_MS = 30_000;

    interface Events {
        /** Микрофон открыт, можно говорить. */
        void listening();

        void partial(String text);

        /** Громкость последней десятой секунды, от 0 до 1. */
        void level(float level);
    }

    /** Микрофон не открылся: занят другим приложением или нет разрешения. */
    static final class NoMicException extends IOException {
        NoMicException() {
            super("no mic");
        }
    }

    private LiveTranscriber() {}

    /** Разрешение RECORD_AUDIO проверяет плагин до вызова. */
    @SuppressLint("MissingPermission")
    static String listen(File modelDir, AtomicBoolean stop, AtomicBoolean cancel, Events events) throws IOException {
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) throw new NoMicException();
        // Буфер на 4 секунды: пока загружается модель, звук копится в нём и не теряется.
        AudioRecord mic;
        try {
            mic = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE * 2 * 4));
        } catch (RuntimeException e) {
            throw new NoMicException();
        }
        OnlineRecognizer recognizer = null;
        OnlineStream stream = null;
        try {
            if (mic.getState() != AudioRecord.STATE_INITIALIZED) throw new NoMicException();
            mic.startRecording();
            if (mic.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new NoMicException();
            events.listening();
            // Тишина 5 с без слов — пользователь ничего не сказал; пауза 1,5 с после слов — фраза закончена.
            recognizer = new OnlineRecognizer(null, AudioTranscriber.config(modelDir, 5f, 1.5f, 25f));
            stream = recognizer.createStream("");
            short[] buf = new short[RATE / 10];
            float[] samples = new float[buf.length];
            String last = "";
            long started = System.currentTimeMillis();
            while (!stop.get() && System.currentTimeMillis() - started < MAX_MS) {
                if (cancel.get()) throw new ModelPacks.CancelledException();
                int n = mic.read(buf, 0, buf.length);
                if (n < 0) throw new NoMicException();
                if (n == 0) continue;
                double sum = 0;
                for (int i = 0; i < n; i++) {
                    samples[i] = buf[i] / 32768f;
                    sum += samples[i] * samples[i];
                }
                events.level(level(sum / n));
                stream.acceptWaveform(n == samples.length ? samples : java.util.Arrays.copyOf(samples, n), RATE);
                while (recognizer.isReady(stream)) recognizer.decode(stream);
                String text = recognizer.getResult(stream).getText().trim();
                if (!text.equals(last)) {
                    last = text;
                    events.partial(text);
                }
                if (recognizer.isEndpoint(stream)) break;
            }
            if (cancel.get()) throw new ModelPacks.CancelledException();
            // Микрофон выключается сразу, досчёт идёт без него.
            mic.stop();
            // Треть секунды тишины в конце, чтобы модель досчитала последнее слово.
            stream.acceptWaveform(new float[RATE / 3], RATE);
            stream.inputFinished();
            while (recognizer.isReady(stream)) recognizer.decode(stream);
            return recognizer.getResult(stream).getText().trim();
        } finally {
            try {
                mic.stop();
            } catch (IllegalStateException ignored) {
                // запись могла не начаться
            }
            mic.release();
            if (stream != null) stream.release();
            if (recognizer != null) recognizer.release();
        }
    }

    /** Громкость для индикатора: средний квадрат в шкалу 0..1 по децибелам (-60 дБ — тишина). */
    static float level(double meanSquare) {
        double db = 10 * Math.log10(Math.max(meanSquare, 1e-10));
        return (float) Math.max(0, Math.min(1, (db + 60) / 60));
    }
}
