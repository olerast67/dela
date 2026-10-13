package io.github.olerast67.dela;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareIntentPlugin.class);
        registerPlugin(WidgetBridgePlugin.class);
        super.onCreate(savedInstanceState);
        ShareIntentPlugin.store(getIntent());
        WidgetBridgePlugin.store(getIntent());
    }
}
