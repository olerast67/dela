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
/** Больше стольких переадресаций подряд запрос не проходит. */
const MAX_CALENDAR_REDIRECTS: usize = 5;

/**
 * Адрес только во внешней сети: ссылка подписки не должна стучаться в сам компьютер,
 * домашнюю или рабочую сеть (роутер, NAS, служебные адреса облака 169.254.x.x).
 */
fn public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || o[0] == 0
                // 100.64.0.0/10: адреса внутри сети провайдера (CGNAT)
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                // 192.0.0.0/24 служебные, 198.18.0.0/15 для тестов сетей, 240.0.0.0/4 зарезервированы
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            // IPv4 внутри IPv6: ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d (NAT64) и 2002:ab:cd:: (6to4)
            // проверяются по правилам IPv4, иначе так прятали бы внутренний адрес.
            let embedded = if let Some(v4) = v6.to_ipv4() {
                Some(v4)
            } else if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                Some(std::net::Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8))
            } else if s[0] == 0x2002 {
                Some(std::net::Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8))
            } else {
                None
            };
            if let Some(v4) = embedded {
                return !v6.is_loopback() && !v6.is_unspecified() && public_ip(IpAddr::V4(v4));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 — частные, fe80::/10 — локальные в сегменте, fec0::/10 — старые локальные
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xffc0) == 0xfec0)
        }
    }
}

/**
 * Ссылка, по которой можно идти: только https и не IP-литерал из частных диапазонов.
 * Имена хостов проверяет resolver после разрешения (PublicResolver): IP-литерал он не видит.
 */
fn allowed_calendar_url(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    // IPv6 в ссылке стоит в квадратных скобках
    if let Ok(ip) = host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>() {
        return public_ip(ip);
    }
    // «localhost» и его поддомены разрешаются в loopback и без DNS
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    name != "localhost" && !name.ends_with(".localhost")
}

/** Разрешение имён, которое отбрасывает внутренние адреса: так их не достать и через DNS, и после переадресации. */
struct PublicResolver;

impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = tauri::async_runtime::spawn_blocking(move || {
                use std::net::ToSocketAddrs;
                (host.as_str(), 0).to_socket_addrs().map(|a| a.collect::<Vec<_>>())
            })
            .await
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })??;
            let public: Vec<std::net::SocketAddr> = addrs.into_iter().filter(|a| public_ip(a.ip())).collect();
            if public.is_empty() {
                return Err("private address".into());
            }
            Ok(Box::new(public.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/**
 * Скачать календарь iCal по ссылке подписки. Веб-клиент в браузере упирается в CORS, программе это не мешает.
 * Ссылка — секрет (в ней ключ доступа к календарю): она не пишется в журнал и не попадает в текст ошибки.
 * Разрешены только https и только GET, тело ограничено по размеру. Переадресации — не больше пяти,
 * тоже только на https; адреса в локальной сети отклоняются и после разрешения имени.
 * Системный прокси не используется: за прокси имя разрешал бы он, и проверка адреса не сработала бы.
 */
#[tauri::command]
async fn fetch_calendar(url: String) -> Result<String, String> {
    let url = reqwest::Url::parse(&url).map_err(|_| "url".to_string())?;
    if !allowed_calendar_url(&url) {
        return Err("url".into());
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_CALENDAR_REDIRECTS {
            attempt.error("redirects")
        } else if !allowed_calendar_url(attempt.url()) {
            attempt.error("url")
        } else {
            attempt.follow()
        }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("Dela")
        .redirect(redirects)
        .dns_resolver(std::sync::Arc::new(PublicResolver))
        .no_proxy()
        .build()
        .map_err(|_| "network".to_string())?;
    let mut resp = client.get(url).send().await.map_err(|_| "network".to_string())?;
    // Вторая линия: адрес, с которым на деле соединились.
    if resp.remote_addr().is_some_and(|a| !public_ip(a.ip())) {
        return Err("url".into());
    }
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status().as_u16()));
    }
    // Заявленная длина больше предела — не читаем вовсе.
    if resp.content_length().is_some_and(|n| n > MAX_CALENDAR_BYTES as u64) {
        return Err("large".into());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        allowed_calendar_url(&reqwest::Url::parse(s).unwrap())
    }

    #[test]
    fn calendar_url_only_public_https() {
        assert!(ok("https://calendar.google.com/calendar/ical/x/basic.ics"));
        assert!(ok("https://8.8.8.8/a.ics"));
        assert!(ok("https://[2001:4860:4860::8888]/a.ics"));
        assert!(!ok("http://calendar.google.com/a.ics"));
        assert!(!ok("file:///C:/a.ics"));
        assert!(!ok("https://localhost/a.ics"));
        assert!(!ok("https://api.LOCALHOST./a.ics"));
        for ip in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
            "[::1]", "[::]", "[fe80::1]", "[fd00::1]", "[::ffff:127.0.0.1]", "[::ffff:192.168.0.1]",
            "[::127.0.0.1]", "[64:ff9b::a00:1]", "[2002:c0a8:101::]", "[fec0::1]", "198.18.0.1", "192.0.0.8", "240.0.0.1",
        ] {
            assert!(!ok(&format!("https://{ip}/a.ics")), "{ip}");
        }
        // Десятичная запись IP разбирается как адрес и тоже отклоняется.
        assert!(!ok("https://2130706433/a.ics"));
    }
}
