package io.github.olerast67.dela;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.ShortBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Голосовое сообщение в текст: MediaExtractor и MediaCodec декодируют файл (ogg/opus, m4a, mp3, wav) в PCM,
 * каналы сводятся в моно, sherpa-onnx приводит звук к 16 кГц своим ресэмплером и распознаёт потоковой
 * моделью Zipformer, как в Суфлёре. Звук идёт в модель кусками по мере декодирования, весь файл в памяти не лежит.
 */
final class AudioTranscriber {
    /** Дольше 10 минут не слушаем: для задачи это слишком длинное сообщение. */
    private static final long MAX_US = 10L * 60 * 1_000_000;

    interface Progress {
        void onProgress(double share);
    }

    private AudioTranscriber() {}

    /** Есть ли в APK библиотеки sherpa-onnx для этого телефона (только arm64-v8a). */
    static boolean supported(android.content.Context c) {
        return new File(c.getApplicationInfo().nativeLibraryDir, "libsherpa-onnx-jni.so").isFile();
    }

    static String transcribe(File audio, File modelDir, AtomicBoolean cancel, Progress progress) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        OnlineRecognizer recognizer = null;
        OnlineStream stream = null;
        try {
            extractor.setDataSource(audio.getPath());
            int track = -1;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    format = f;
                    break;
                }
            }
            if (format == null) throw new IOException("no audio track");
            extractor.selectTrack(track);
            long duration = format.containsKey(MediaFormat.KEY_DURATION) ? format.getLong(MediaFormat.KEY_DURATION) : 0;
            int rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            int encoding = AudioFormat.ENCODING_PCM_16BIT;

            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
            codec.configure(format, null, null, 0);
            codec.start();

            recognizer = new OnlineRecognizer(null, config(modelDir, 2.4f, 1.2f, 20f));
            stream = recognizer.createStream("");

            StringBuilder text = new StringBuilder();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            while (true) {
                if (cancel.get()) throw new ModelPacks.CancelledException();
                if (!inputDone) {
                    int in = codec.dequeueInputBuffer(10_000);
                    if (in >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(in);
                        int n = buf == null ? -1 : extractor.readSampleData(buf, 0);
                        long time = extractor.getSampleTime();
                        if (n < 0 || time > MAX_US) {
                            codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(in, 0, n, time, 0);
                            extractor.advance();
                        }
                    }
                }
                int out = codec.dequeueOutputBuffer(info, 10_000);
                if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat f = codec.getOutputFormat();
                    rate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (f.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = f.getInteger(MediaFormat.KEY_PCM_ENCODING);
                } else if (out >= 0) {
                    ByteBuffer buf = codec.getOutputBuffer(out);
                    float[] mono = buf == null || info.size == 0 ? new float[0] : toMono(buf, info, channels, encoding);
                    codec.releaseOutputBuffer(out, false);
                    if (mono.length > 0) {
                        stream.acceptWaveform(mono, rate);
                        while (recognizer.isReady(stream)) recognizer.decode(stream);
                        // Конец фразы по паузе: текст фразы забираем, поток начинает следующую.
                        if (recognizer.isEndpoint(stream)) {
                            append(text, recognizer.getResult(stream).getText());
                            recognizer.reset(stream);
                        }
                    }
                    long limit = duration > 0 ? Math.min(duration, MAX_US) : 0;
                    if (limit > 0) progress.onProgress(Math.min(1.0, info.presentationTimeUs / (double) limit));
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                }
            }
            // Полсекунды тишины в конце, чтобы модель досчитала последнее слово.
            stream.acceptWaveform(new float[Math.max(1, rate / 2)], rate);
            stream.inputFinished();
            while (recognizer.isReady(stream)) recognizer.decode(stream);
            append(text, recognizer.getResult(stream).getText());
            return text.toString();
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (Exception ignored) {
                    // кодек мог не запуститься
                }
                codec.release();
            }
            extractor.release();
            if (stream != null) stream.release();
            if (recognizer != null) recognizer.release();
        }
    }

    /**
     * Модель как в Суфлёре, но без подсказок слов: жадный поиск. Конец фразы: silence — столько секунд тишины
     * без слов, pause — пауза после слов, longest — самая длинная фраза.
     */
    static OnlineRecognizerConfig config(File dir, float silence, float pause, float longest) {
        OnlineTransducerModelConfig transducer = new OnlineTransducerModelConfig();
        transducer.setEncoder(new File(dir, "encoder.int8.onnx").getPath());
        transducer.setDecoder(new File(dir, "decoder.onnx").getPath());
        transducer.setJoiner(new File(dir, "joiner.int8.onnx").getPath());
        OnlineModelConfig model = new OnlineModelConfig();
        model.setTransducer(transducer);
        model.setTokens(new File(dir, "tokens.txt").getPath());
        model.setNumThreads(2);
        model.setProvider("cpu");
        model.setModelType("zipformer2");
        FeatureConfig feat = new FeatureConfig();
        feat.setSampleRate(16000);
        feat.setFeatureDim(80);
        OnlineRecognizerConfig config = new OnlineRecognizerConfig();
        config.setFeatConfig(feat);
        config.setModelConfig(model);
        config.setEnableEndpoint(true);
        config.setEndpointConfig(new com.k2fsa.sherpa.onnx.EndpointConfig(
            new com.k2fsa.sherpa.onnx.EndpointRule(false, silence, 0f),
            new com.k2fsa.sherpa.onnx.EndpointRule(true, pause, 0f),
            new com.k2fsa.sherpa.onnx.EndpointRule(false, 0f, longest)
        ));
        config.setDecodingMethod("greedy_search");
        return config;
    }

    private static void append(StringBuilder text, String piece) {
        String p = piece == null ? "" : piece.trim();
        if (p.isEmpty()) return;
        if (text.length() > 0) text.append(' ');
        text.append(p);
    }

    /** Кусок PCM (16 бит или float, каналы чередуются) в моно float от -1 до 1. */
    private static float[] toMono(ByteBuffer buf, MediaCodec.BufferInfo info, int channels, int encoding) {
        ByteBuffer b = buf.duplicate();
        b.position(info.offset);
        b.limit(info.offset + info.size);
        b = b.slice().order(ByteOrder.nativeOrder());
        int ch = Math.max(1, channels);
        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
            FloatBuffer fb = b.asFloatBuffer();
            int frames = fb.remaining() / ch;
            float[] out = new float[frames];
            for (int i = 0; i < frames; i++) {
                float sum = 0;
                for (int c = 0; c < ch; c++) sum += fb.get(i * ch + c);
                out[i] = sum / ch;
            }
            return out;
        }
        ShortBuffer sb = b.asShortBuffer();
        int frames = sb.remaining() / ch;
        float[] out = new float[frames];
        for (int i = 0; i < frames; i++) {
            int sum = 0;
            for (int c = 0; c < ch; c++) sum += sb.get(i * ch + c);
            out[i] = sum / (32768f * ch);
        }
        return out;
    }
}
