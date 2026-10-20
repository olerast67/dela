package io.github.olerast67.dela;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;
import java.lang.ref.WeakReference;

/**
 * Будильник срочной задачи на весь экран, поверх экрана блокировки: название задачи и три кнопки.
 * Звонок ведёт AlarmService; экран только передаёт ему выбор и закрывается, когда звонок кончился.
 */
public class AlarmActivity extends Activity {
    private static WeakReference<AlarmActivity> current = new WeakReference<>(null);

    private String key;
    private String title;
    private String taskId;

    /** Экран на языке приложения, как виджет. */
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(WidgetStore.localized(base));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_alarm);
        current = new WeakReference<>(this);
        findViewById(R.id.alarm_done).setOnClickListener(v -> send(AlarmService.ACTION_DONE));
        findViewById(R.id.alarm_snooze).setOnClickListener(v -> send(AlarmService.ACTION_SNOOZE));
        findViewById(R.id.alarm_dismiss).setOnClickListener(v -> send(AlarmService.ACTION_DISMISS));
        show(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        show(intent);
    }

    private void show(Intent intent) {
        key = intent.getStringExtra(AlarmStore.EXTRA_KEY);
        title = intent.getStringExtra(AlarmService.EXTRA_TITLE);
        taskId = intent.getStringExtra(AlarmService.EXTRA_TASK);
        ((TextView) findViewById(R.id.alarm_title)).setText(title == null || title.isEmpty() ? getString(R.string.notify_task) : title);
        // Без задачи нечего отмечать.
        ((Button) findViewById(R.id.alarm_done)).setEnabled(taskId != null && !taskId.isEmpty());
    }

    private void send(String action) {
        startService(AlarmService.command(this, action, key, title, taskId));
        finish();
    }

    /** Звонок кончился (кнопка в шторке, другой будильник, 5 минут без ответа): экран закрывается. */
    static void closeAll() {
        AlarmActivity a = current.get();
        if (a != null && !a.isFinishing()) a.finish();
    }

    @Override
    protected void onDestroy() {
        if (current.get() == this) current = new WeakReference<>(null);
        super.onDestroy();
    }
}
