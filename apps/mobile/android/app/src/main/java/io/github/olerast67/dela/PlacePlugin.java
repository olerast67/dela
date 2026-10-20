package io.github.olerast67.dela;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;

/**
 * Напоминания по месту для веб-клиента: set() заменяет зоны, status() и request*() — разрешения на геолокацию,
 * current() — где телефон сейчас (для «Где я сейчас» в карточке задачи). Без сервисов Google: только LocationManager.
 */
@CapacitorPlugin(
    name = "DelaPlaces",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "background", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }),
    }
)
public class PlacePlugin extends Plugin {
    /** Сколько ждать точку для «Где я сейчас»: спутникам в помещении может не хватить, тогда берём лучшую из полученных. */
    private static final long CURRENT_TIMEOUT_MS = 20_000;

    @PluginMethod
    public void set(PluginCall call) {
        JSArray zones = call.getArray("zones", new JSArray());
        List<PlaceStore.Zone> list = new ArrayList<>();
        try {
            for (int i = 0; i < zones.length(); i++) list.add(PlaceStore.Zone.of(zones.getJSONObject(i)));
        } catch (Exception e) {
            call.reject("bad zones");
            return;
        }
        Context c = getContext();
        PlaceStore.replace(c, list);
        PlaceService.sync(c);
        JSObject r = new JSObject();
        r.put("tracking", !list.isEmpty() && PlaceStore.enabled(c) && PlaceService.hasLocation(c));
        call.resolve(r);
    }

    private JSObject status() {
        Context c = getContext();
        boolean location = PlaceService.hasLocation(c);
        JSObject r = new JSObject();
        r.put("location", location);
        r.put("precise", PlaceService.granted(c, Manifest.permission.ACCESS_FINE_LOCATION));
        // До Android 10 отдельного разрешения на фон нет: оно входит в обычное.
        r.put("background", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ? location : PlaceService.granted(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        r.put("enabled", PlaceStore.enabled(c));
        r.put("tracking", PlaceService.running);
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void requestLocation(PluginCall call) {
        // Приблизительное уже есть — всё равно спрашиваем: Android 12+ предложит перейти на точное.
        if (PlaceService.granted(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias("location", call, "permissionResult");
    }

    /** Android 10: системный диалог с «Разрешить всегда»; Android 11+: система открывает экран разрешения в настройках. */
    @PluginMethod
    public void requestBackground(PluginCall call) {
        Context c = getContext();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !PlaceService.hasLocation(c) || PlaceService.granted(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias("background", call, "permissionResult");
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        // Разрешение могло включить слежение за уже сохранёнными зонами.
        PlaceService.sync(getContext());
        call.resolve(status());
    }

    /** Экран приложения в настройках: если запрос больше не показывается (пользователь отказал раньше). */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Context c = getContext();
        PlaceStore.setEnabled(c, Boolean.TRUE.equals(call.getBoolean("enabled", true)));
        PlaceService.sync(c);
        call.resolve(status());
    }

    /** Где телефон сейчас: свежая точка из кэша или первая достаточно точная от спутников и сети. */
    @PluginMethod
    public void current(PluginCall call) {
        Context c = getContext();
        if (!PlaceService.hasLocation(c)) {
            call.reject("no permission");
            return;
        }
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            call.reject("no location");
            return;
        }
        Location cached = null;
        try {
            for (String p : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos() < 60_000_000_000L && l.hasAccuracy() && l.getAccuracy() <= 50) {
                    if (cached == null || l.getAccuracy() < cached.getAccuracy()) cached = l;
                }
            }
        } catch (SecurityException ignored) {
            // разрешение отозвали между проверкой и запросом
        }
        if (cached != null) {
            resolve(call, cached);
            return;
        }
        Handler handler = new Handler(Looper.getMainLooper());
        final Location[] best = { null };
        final boolean[] done = { false };
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location l) {
                if (done[0]) return;
                if (best[0] == null || (l.hasAccuracy() && l.getAccuracy() < best[0].getAccuracy())) best[0] = l;
                if (l.hasAccuracy() && l.getAccuracy() <= 50) finish();
            }

            void finish() {
                if (done[0]) return;
                done[0] = true;
                try {
                    lm.removeUpdates(this);
                } catch (SecurityException ignored) {
                    // разрешение уже отозвано
                }
                if (best[0] != null) resolve(call, best[0]);
                else call.reject("no fix");
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {}

            @Override
            public void onProviderEnabled(String provider) {}

            @Override
            public void onProviderDisabled(String provider) {}
        };
        try {
            int n = 0;
            for (String p : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                if (!lm.getAllProviders().contains(p) || !lm.isProviderEnabled(p)) continue;
                if (LocationManager.GPS_PROVIDER.equals(p) && !PlaceService.granted(c, Manifest.permission.ACCESS_FINE_LOCATION)) continue;
                lm.requestLocationUpdates(p, 1000, 0, listener, Looper.getMainLooper());
                n++;
            }
            if (n == 0) {
                call.reject("location off");
                return;
            }
        } catch (SecurityException | IllegalArgumentException e) {
            call.reject("no location");
            return;
        }
        handler.postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            try {
                lm.removeUpdates(listener);
            } catch (SecurityException ignored) {
                // разрешение уже отозвано
            }
            if (best[0] != null) resolve(call, best[0]);
            else call.reject("timeout");
        }, CURRENT_TIMEOUT_MS);
    }

    private static void resolve(PluginCall call, Location l) {
        JSObject r = new JSObject();
        r.put("lat", l.getLatitude());
        r.put("lon", l.getLongitude());
        r.put("accuracy", l.hasAccuracy() ? l.getAccuracy() : 0);
        call.resolve(r);
    }
}
