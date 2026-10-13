package io.github.olerast67.dela;

import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.RadioGroup;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Настройки виджета: какой список показывать, тема, прозрачность фона, размер шрифта, компактный режим. */
public class WidgetConfigActivity extends AppCompatActivity {
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Если закрыть экран кнопкой «Назад» при добавлении, виджет не ставится.
        setResult(RESULT_CANCELED);
        Bundle extras = getIntent().getExtras();
        if (extras != null) widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }
        setContentView(R.layout.widget_config);
        setTitle(R.string.widget_config_title);
        WidgetStore.Config cfg = WidgetStore.config(this, widgetId);

        // Списки: Сегодня, Неделя и проекты из последнего снимка.
        List<String> labels = new ArrayList<>();
        List<String> values = new ArrayList<>();
        labels.add(getString(R.string.list_today));
        values.add("today");
        labels.add(getString(R.string.list_week));
        values.add("week");
        JSONObject snap = WidgetStore.snapshot(this);
        JSONArray projects = snap == null ? null : snap.optJSONArray("projects");
        for (int i = 0; projects != null && i < projects.length(); i++) {
            JSONObject p = projects.optJSONObject(i);
            if (p == null) continue;
            labels.add(p.optString("name"));
            values.add("project:" + p.optString("id"));
        }
        Spinner list = findViewById(R.id.cfg_list);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        list.setAdapter(adapter);
        list.setSelection(Math.max(0, values.indexOf(cfg.list)));

        RadioGroup theme = findViewById(R.id.cfg_theme);
        theme.check("light".equals(cfg.theme) ? R.id.cfg_theme_light : "dark".equals(cfg.theme) ? R.id.cfg_theme_dark : R.id.cfg_theme_system);

        SeekBar opacity = findViewById(R.id.cfg_opacity);
        TextView opacityValue = findViewById(R.id.cfg_opacity_value);
        opacity.setMax(100);
        opacity.setProgress(cfg.opacity);
        opacityValue.setText(cfg.opacity + "%");
        opacity.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar s, int value, boolean fromUser) {
                opacityValue.setText(value + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar s) {}

            @Override
            public void onStopTrackingTouch(SeekBar s) {}
        });

        RadioGroup font = findViewById(R.id.cfg_font);
        font.check(cfg.large ? R.id.cfg_font_large : R.id.cfg_font_normal);
        CheckBox compact = findViewById(R.id.cfg_compact);
        compact.setChecked(cfg.compact);
        CheckBox hide = findViewById(R.id.cfg_hide_locked);
        hide.setChecked(cfg.hideWhenLocked);

        Button done = findViewById(R.id.cfg_done);
        done.setOnClickListener((v) -> {
            WidgetStore.Config next = new WidgetStore.Config();
            next.list = values.get(Math.max(0, list.getSelectedItemPosition()));
            int t = theme.getCheckedRadioButtonId();
            next.theme = t == R.id.cfg_theme_light ? "light" : t == R.id.cfg_theme_dark ? "dark" : "system";
            next.opacity = Math.max(0, Math.min(100, opacity.getProgress()));
            next.large = font.getCheckedRadioButtonId() == R.id.cfg_font_large;
            next.compact = compact.isChecked();
            next.hideWhenLocked = hide.isChecked();
            WidgetStore.saveConfig(this, widgetId, next);
            AppWidgetManager m = AppWidgetManager.getInstance(this);
            TasksWidgetProvider.update(this, m, widgetId);
            m.notifyAppWidgetViewDataChanged(new int[] { widgetId }, R.id.widget_list);
            Intent result = new Intent();
            result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
            setResult(RESULT_OK, result);
            finish();
        });
    }
}
