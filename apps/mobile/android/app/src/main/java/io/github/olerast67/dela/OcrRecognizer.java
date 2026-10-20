package io.github.olerast67.dela;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import com.googlecode.tesseract.android.TessBaseAPI;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/** Текст с картинки: Tesseract на устройстве, русский и английский (tessdata_fast). */
final class OcrRecognizer {
    /** Длинная сторона картинки после уменьшения: текст фото и скриншота читается, а Tesseract не тонет в мегапикселях. */
    private static final int MAX_SIDE = 3200;

    interface Progress {
        void onProgress(double share);
    }

    private OcrRecognizer() {}

    /** Распознать картинку. dataDir — папка, внутри которой лежит tessdata с rus и eng. */
    static String recognize(File image, File dataDir, AtomicBoolean cancel, Progress progress) throws IOException {
        Bitmap bitmap = load(image);
        if (bitmap == null) throw new IOException("not an image");
        // Отмену Tesseract проверяет между словами: stop() вызывается из его же обратного вызова.
        final TessBaseAPI[] holder = new TessBaseAPI[1];
        TessBaseAPI tess = new TessBaseAPI((values) -> {
            if (cancel.get() && holder[0] != null) holder[0].stop();
            else progress.onProgress(values.getPercent() / 100.0);
        });
        holder[0] = tess;
        try {
            if (!tess.init(dataDir.getAbsolutePath(), "rus+eng")) throw new IOException("tesseract init");
            tess.setPageSegMode(TessBaseAPI.PageSegMode.PSM_AUTO);
            tess.setImage(bitmap);
            // Прогресс Tesseract сообщает только при разборе в hOCR; текст потом берётся из того же разбора.
            tess.getHOCRText(0);
            if (cancel.get()) throw new ModelPacks.CancelledException();
            String text = tess.getUTF8Text();
            return text == null ? "" : text;
        } finally {
            tess.recycle();
            bitmap.recycle();
        }
    }

    /** Картинка с учётом поворота из EXIF, уменьшенная до MAX_SIDE по длинной стороне. */
    private static Bitmap load(File file) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / sample > MAX_SIDE) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bmp = BitmapFactory.decodeFile(file.getPath(), opts);
        if (bmp == null) return null;
        int degrees = 0;
        try (InputStream in = new FileInputStream(file)) {
            int o = new ExifInterface(in).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            degrees = o == ExifInterface.ORIENTATION_ROTATE_90 ? 90 : o == ExifInterface.ORIENTATION_ROTATE_180 ? 180 : o == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
        } catch (Exception ignored) {
            // у PNG и скриншотов EXIF нет
        }
        if (degrees == 0) return bmp;
        Matrix m = new Matrix();
        m.postRotate(degrees);
        Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
        if (rotated != bmp) bmp.recycle();
        return rotated;
    }
}
