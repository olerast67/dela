package io.github.olerast67.dela;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareIntentPlugin.class);
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(VoiceInputPlugin.class);
        registerPlugin(UnifiedPushPlugin.class);
        registerPlugin(AlarmPlugin.class);
        registerPlugin(PlacePlugin.class);
        registerPlugin(DeviceCalendarPlugin.class);
        registerPlugin(RecognizePlugin.class);
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);
        ShareIntentPlugin.store(this, getIntent());
        WidgetBridgePlugin.store(getIntent());
        // Отладочная сборка: страница https://localhost обращается к серверу разработчика http://localhost.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            getBridge().getWebView().getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
    }
}
