package io.github.olerast67.dela;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Обновление приложения, поставленного APK из выпусков GitHub. Ходит в сеть только по адресам выпусков Dela
 * (и хранилищам GitHub, куда они переадресуют), APK кладёт в cache/updates, сверяет SHA-256 и открывает
 * системную установку. Подпись APK проверяет сам Android: поверх ставится только файл с тем же ключом.
 * В сборке для F-Droid (BuildConfig.SELF_UPDATE = false) выключено: там обновляет F-Droid.
 * Коды ошибок: forbidden, checksum, permission, no_file, network.
 */
@CapacitorPlugin(name = "DelaUpdate")
public class UpdatePlugin extends Plugin {
    private static final ExecutorService NET = Executors.newSingleThreadExecutor();
    private static final String RELEASES = "/olerast67/dela/releases/";
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$");
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final long MAX_TEXT = 1L << 20;
    private static final long MAX_APK = 512L << 20;

    private volatile boolean downloading;

    static String versionName(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return pi.versionName != null ? pi.versionName : "";
        } catch (Exception e) {
            return "";
        }
    }

    /** Начало скачивания: выпуски репозитория Dela на github.com по https. */
    static boolean isReleaseUrl(String s) {
        try {
            URI u = new URI(s).normalize();
            return "https".equals(u.getScheme()) && "github.com".equals(u.getHost()) && u.getPort() == -1
                && u.getUserInfo() == null && u.getPath() != null && u.getPath().startsWith(RELEASES) && !u.getPath().contains("..");
        } catch (Exception e) {
            return false;
        }
    }

    /** Переадресация: выпуски Dela или хранилища файлов выпусков GitHub. */
    static boolean isAllowedRedirect(String s) {
        if (isReleaseUrl(s)) return true;
        try {
            URI u = new URI(s);
            String h = u.getHost();
            return "https".equals(u.getScheme()) && u.getPort() == -1 && u.getUserInfo() == null
                && ("objects.githubusercontent.com".equals(h) || "release-assets.githubusercontent.com".equals(h));
        } catch (Exception e) {
            return false;
        }
    }

    private static File dir(Context c) {
        return new File(c.getCacheDir(), "updates");
    }

    private static File apk(Context c, String version) {
        return new File(dir(c), "Dela-" + version + ".apk");
    }

    @PluginMethod
    public void info(PluginCall call) {
        Context c = getContext();
        String v = versionName(c);
        // Установленную версию больше не нужно держать в cache.
        File[] old = dir(c).listFiles();
        if (old != null && !downloading) for (File f : old) if (f.getName().equals("Dela-" + v + ".apk") || f.getName().endsWith(".part")) f.delete();
        JSObject r = new JSObject();
        r.put("version", v);
        r.put("enabled", BuildConfig.SELF_UPDATE && !v.endsWith("-debug"));
        call.resolve(r);
    }

    /** Открыть адрес выпуска, сами проходя переадресации и проверяя каждую. */
    private static HttpURLConnection open(String url) throws IOException {
        if (!isReleaseUrl(url)) throw new ForbiddenException();
        String next = url;
        for (int i = 0; i < 6; i++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(next).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(30_000);
            conn.setReadTimeout(60_000);
            conn.setRequestProperty("User-Agent", "Dela-Android");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null) throw new IOException("redirect without location");
                next = new URL(new URL(next), loc).toString();
                if (!isAllowedRedirect(next)) throw new ForbiddenException();
                continue;
            }
            if (code != HttpURLConnection.HTTP_OK) {
                conn.disconnect();
                throw new IOException("HTTP " + code);
            }
            return conn;
        }
        throw new IOException("too many redirects");
    }

    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url", "");
        if (!isReleaseUrl(url)) {
            call.reject("forbidden", "forbidden");
            return;
        }
        NET.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = open(url);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        if (out.size() > MAX_TEXT) throw new IOException("too big");
                    }
                }
                JSObject r = new JSObject();
                r.put("text", new String(out.toByteArray(), StandardCharsets.UTF_8));
                call.resolve(r);
            } catch (ForbiddenException e) {
                call.reject("forbidden", "forbidden");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "network");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String sha = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        String version = call.getString("version", "");
        if (!isReleaseUrl(url) || !HEX64.matcher(sha).matches() || !VERSION.matcher(version).matches()) {
            call.reject("forbidden", "forbidden");
            return;
        }
        synchronized (this) {
            if (downloading) {
                call.reject("busy", "busy");
                return;
            }
            downloading = true;
        }
        Context c = getContext();
        NET.execute(() -> {
            try {
                File d = dir(c);
                if (!d.isDirectory() && !d.mkdirs()) throw new IOException("mkdirs");
                File target = apk(c, version);
                // Уже скачан и сверен (например, ждали разрешения на установку): второй раз не качаем.
                if (target.isFile() && sha.equals(sha256(target))) {
                    call.resolve();
                    return;
                }
                File[] old = d.listFiles();
                if (old != null) for (File f : old) f.delete();
                File part = new File(d, target.getName() + ".part");
                try {
                    fetch(url, part, sha);
                } catch (IOException e) {
                    part.delete();
                    throw e;
                }
                if (!part.renameTo(target)) {
                    part.delete();
                    throw new IOException("rename");
                }
                call.resolve();
            } catch (ForbiddenException e) {
                call.reject("forbidden", "forbidden");
            } catch (ChecksumException e) {
                call.reject("checksum", "checksum");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "network");
            } finally {
                downloading = false;
            }
        });
    }

    private void fetch(String url, File to, String sha) throws IOException {
        MessageDigest md = digest();
        HttpURLConnection conn = open(url);
        try {
            long total = conn.getContentLengthLong();
            if (total > MAX_APK) throw new IOException("too big");
            long got = 0;
            long last = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) {
                    got += n;
                    if (got > MAX_APK) throw new IOException("too big");
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                    // Не чаще пяти раз в секунду: событие идёт через мост в WebView.
                    long now = SystemClock.elapsedRealtime();
                    if (now - last >= 200) {
                        last = now;
                        progress(got, total);
                    }
                }
            }
            progress(got, total > 0 ? total : got);
            if (!hex(md.digest()).equals(sha)) throw new ChecksumException();
        } finally {
            conn.disconnect();
        }
    }

    private void progress(long done, long total) {
        JSObject e = new JSObject();
        e.put("done", done);
        e.put("total", total);
        notifyListeners("progress", e);
    }

    @PluginMethod
    public void install(PluginCall call) {
        Context c = getContext();
        String version = call.getString("version", "");
        File f = VERSION.matcher(version).matches() ? apk(c, version) : null;
        if (f == null || !f.isFile()) {
            call.reject("no file", "no_file");
            return;
        }
        // Android 8+: установка из Dela разрешается отдельно. Открываем этот переключатель для Dela.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !c.getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                c.startActivity(s);
            } catch (ActivityNotFoundException ignored) {
                // на прошивках без этого экрана пользователь найдёт переключатель сам
            }
            call.reject("permission", "permission");
            return;
        }
        Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", f);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        // APK открывают и посторонние приложения (файловые менеджеры, Termux): сразу системный установщик, без выбора.
        String installer = systemInstaller(c, i);
        if (installer != null) i.setPackage(installer);
        try {
            c.startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no installer", "failed");
        }
    }

    private static String systemInstaller(Context c, Intent i) {
        try {
            for (ResolveInfo r : c.getPackageManager().queryIntentActivities(i, PackageManager.MATCH_SYSTEM_ONLY)) {
                if (r.activityInfo != null) return r.activityInfo.packageName;
            }
        } catch (Exception ignored) {
            // не нашли — Android покажет обычный выбор приложения
        }
        return null;
    }

    private static MessageDigest digest() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    private static String sha256(File f) throws IOException {
        MessageDigest md = digest();
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return hex(md.digest());
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static final class ForbiddenException extends IOException {
        ForbiddenException() {
            super("forbidden");
        }
    }

    private static final class ChecksumException extends IOException {
        ChecksumException() {
            super("checksum");
        }
    }
}
