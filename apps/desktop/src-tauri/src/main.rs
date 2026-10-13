// Dela для компьютера: встроенный веб-клиент, трей, глобальная клавиша быстрой задачи.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn quick_add(app: &AppHandle) {
    show_main(app);
    let _ = app.emit("quick-add", ());
}

fn main() {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        // Второй запуск открывает уже работающее окно.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Обновления: latest.json в последнем выпуске на GitHub, установщик подписан ключом обновлений.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, pressed, event| {
                    if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                        quick_add(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Сочетание может быть занято другой программой: тогда приложение работает без него.
            if let Err(err) = app.global_shortcut().register(shortcut) {
                eprintln!("global shortcut is not available: {err}");
            }
            let open = MenuItem::with_id(app, "open", "Открыть Dela", true, None::<&str>)?;
            let add = MenuItem::with_id(app, "add", "Новая задача (Ctrl+Shift+Space)", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &add, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("window icon"))
                .tooltip("Dela")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "add" => quick_add(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Закрытие окна прячет его в трей: напоминания продолжают приходить.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Dela");
}
