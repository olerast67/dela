// Dela для компьютера: встроенный веб-клиент, трей, глобальная клавиша быстрой задачи, ссылки dela://,
// запуск при входе в Windows и проекты или задачи в отдельных окнах.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/** Пункты меню в трее: подписи задаёт веб-клиент на языке интерфейса. */
struct TrayItems {
    open: MenuItem<tauri::Wry>,
    add: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

#[tauri::command]
fn tray_labels(items: tauri::State<'_, TrayItems>, open: String, add: String, quit: String) {
    let _ = items.open.set_text(open);
    let _ = items.add.set_text(add);
    let _ = items.quit.set_text(quit);
}

/** Ссылка dela://, с которой запущена программа: веб-клиент забирает её после загрузки. */
struct PendingLink(Mutex<Option<String>>);

#[tauri::command]
fn take_app_link(pending: tauri::State<'_, PendingLink>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut link| link.take())
}

/** Ссылка dela://open#/… при работающей программе: окно на передний план, маршрут в веб-клиент. */
fn open_link(app: &AppHandle, url: String) {
    show_main(app);
    let _ = app.emit("app-link", url);
}

/** Аргумент, с которым Windows запускает программу при входе: окно не показывается, программа живёт в трее. */
const MINIMIZED_ARG: &str = "--minimized";

/**
 * Проект или задача в отдельном компактном окне. Метка окна строится из маршрута в веб-клиенте:
 * повторное открытие того же проекта показывает уже открытое окно.
 * async: на Windows окно, созданное из синхронной команды, подвешивает программу.
 */
#[tauri::command]
async fn open_view_window(app: AppHandle, label: String, url: String, title: String) -> Result<(), String> {
    let label_ok = label.starts_with("view-") && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !label_ok || !url.starts_with("?window=1#/") {
        return Err("bad window".into());
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(420.0, 640.0)
        .min_inner_size(320.0, 400.0)
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

/** Больше этого файл календаря не скачивается. */
const MAX_CALENDAR_BYTES: usize = 20 * 1024 * 1024;

/**
 * Скачать календарь iCal по ссылке подписки. Веб-клиент в браузере упирается в CORS, программе это не мешает.
 * Ссылка — секрет (в ней ключ доступа к календарю): она не пишется в журнал и не попадает в текст ошибки.
 * Разрешены только https и только GET, тело ограничено по размеру.
 */
#[tauri::command]
async fn fetch_calendar(url: String) -> Result<String, String> {
    let url = reqwest::Url::parse(&url).map_err(|_| "url".to_string())?;
    if url.scheme() != "https" {
        return Err("url".into());
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("Dela")
        .build()
        .map_err(|_| "network".to_string())?;
    let mut resp = client.get(url).send().await.map_err(|_| "network".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status().as_u16()));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| "network".to_string())? {
        if body.len() + chunk.len() > MAX_CALENDAR_BYTES {
            return Err("large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn quick_add(app: &AppHandle) {
    show_main(app);
    let _ = app.emit("quick-add", ());
}

fn main() {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        // Второй запуск открывает уже работающее окно; ссылку dela:// из него получает deep-link.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Обновления: latest.json в последнем выпуске на GitHub, установщик подписан ключом обновлений.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Включается переключателем в настройках; при входе в систему окно не показывается.
        .plugin(tauri_plugin_autostart::Builder::new().arg(MINIMIZED_ARG).build())
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
            // Главное окно создаётся скрытым: при запуске со входом в систему оно остаётся в трее.
            if !std::env::args().any(|arg| arg == MINIMIZED_ARG) {
                show_main(app.handle());
            }
            // Схему dela:// регистрирует установщик; при запуске из исходников — сама программа.
            #[cfg(debug_assertions)]
            if let Err(err) = app.deep_link().register_all() {
                eprintln!("dela:// is not registered: {err}");
            }
            let first = app.deep_link().get_current().ok().flatten().and_then(|urls| urls.into_iter().next()).map(|url| url.to_string());
            app.manage(PendingLink(Mutex::new(first)));
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().into_iter().next() {
                    open_link(&handle, url.to_string());
                }
            });
            // Сочетание может быть занято другой программой: тогда приложение работает без него.
            if let Err(err) = app.global_shortcut().register(shortcut) {
                eprintln!("global shortcut is not available: {err}");
            }
            let open = MenuItem::with_id(app, "open", "Открыть Dela", true, None::<&str>)?;
            let add = MenuItem::with_id(app, "add", "Новая задача (Ctrl+Shift+Space)", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти из Dela", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &add, &quit])?;
            app.manage(TrayItems { open: open.clone(), add: add.clone(), quit: quit.clone() });
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
        .invoke_handler(tauri::generate_handler![tray_labels, take_app_link, open_view_window, fetch_calendar])
        // Закрытие главного окна прячет его в трей: напоминания продолжают приходить. Отдельные окна закрываются.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Dela");
}
