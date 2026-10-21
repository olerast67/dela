// Dela для компьютера: встроенный веб-клиент, трей, всплывающая строка быстрой задачи по глобальной клавише, ссылки dela://,
// запуск при входе в Windows, проекты или задачи в отдельных окнах и голосовой ввод без облака.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod voice;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
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
        // Перетаскивание задач и файлов делает сама страница; обработчик Tauri перехватил бы его в Windows.
        .disable_drag_drop_handler()
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

/** Метка всплывающей строки быстрого добавления. */
const QUICK: &str = "quick";
/** Ширина строки в логических пикселях; высоту задаёт веб-клиент по содержимому. */
const QUICK_WIDTH: f64 = 640.0;
/** Строка создаётся один раз: второе нажатие, пока окно ещё строится, не создаёт второе. */
static QUICK_BUILDING: AtomicBool = AtomicBool::new(false);

/** Левый верхний угол строки: по центру рабочей области и на пятую часть её высоты от верха, как Spotlight. */
fn quick_position(area_x: i32, area_y: i32, area_w: u32, area_h: u32, width: u32) -> (i32, i32) {
    let x = area_x + (area_w.saturating_sub(width) / 2) as i32;
    let y = area_y + (area_h / 5) as i32;
    (x, y)
}

/** Показать строку на экране, где сейчас мышь, и отдать ей фокус. */
fn show_quick(app: &AppHandle, w: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let area = m.work_area();
        let width = (QUICK_WIDTH * m.scale_factor()).round() as u32;
        let (x, y) = quick_position(area.position.x, area.position.y, area.size.width, area.size.height, width);
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/**
 * Ctrl+Shift+Space и «Новая задача» в трее: маленькое окно поверх всех программ, только строка быстрого
 * добавления. Повторное нажатие прячет его. Окно создаётся при первом вызове и дальше только показывается.
 */
fn quick_add(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
        show_quick(app, &w);
        // Веб-клиент очищает поле и заново проверяет PIN.
        let _ = app.emit_to(QUICK, "quick-open", ());
        return;
    }
    if QUICK_BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // Окно строится в отдельной задаче, а не в обработчике клавиши или меню: так же, как в open_view_window.
    tauri::async_runtime::spawn(async move {
        // Окно скрыто, пока клиент не загрузится: его показывает команда quick_ready.
        let built = WebviewWindowBuilder::new(&app, QUICK, WebviewUrl::App("?quick=1".into()))
            .title("Dela")
            .inner_size(QUICK_WIDTH, 64.0)
            .disable_drag_drop_handler()
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            .visible(false)
            .build();
        QUICK_BUILDING.store(false, Ordering::SeqCst);
        if let Err(err) = built {
            // Без всплывающего окна — быстрое добавление в главном окне, как раньше.
            eprintln!("quick window is not available: {err}");
            show_main(&app);
            let _ = app.emit_to("main", "quick-add", ());
        }
    });
}

/** Всплывающая строка загрузилась: первый показ. */
#[tauri::command]
fn quick_ready(app: AppHandle, window: WebviewWindow) {
    if window.label() == QUICK {
        show_quick(&app, &window);
    }
}

/** Спрятать строку: Enter, Esc, «Отмена». Windows возвращает фокус программе, где был пользователь. */
#[tauri::command]
fn quick_hide(window: WebviewWindow) {
    if window.label() == QUICK {
        let _ = window.hide();
    }
}

/** Высота строки по содержимому, в логических пикселях. */
#[tauri::command]
fn quick_resize(window: WebviewWindow, height: f64) {
    if window.label() == QUICK && height.is_finite() {
        let _ = window.set_size(LogicalSize::new(QUICK_WIDTH, height.clamp(48.0, 640.0)));
    }
}

/**
 * Из всплывающей строки или отдельного окна: главное окно вперёд, строка прячется.
 * route — экран главного окна, например #/settings (скачать модель голосового ввода).
 */
#[tauri::command]
fn show_main_window(app: AppHandle, route: Option<String>) {
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.hide();
    }
    match route.filter(|r| r.starts_with("#/") && !r.contains(char::is_whitespace)) {
        Some(r) => open_link(&app, format!("dela://open{r}")),
        None => show_main(&app),
    }
}

/** Закрыть отдельное окно задачи крестиком карточки. Главное окно и строку так не закрыть. */
#[tauri::command]
fn close_view_window(window: WebviewWindow) {
    if window.label().starts_with("view-") {
        let _ = window.close();
    }
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
        .manage(voice::VoiceState::default())
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
        .invoke_handler(tauri::generate_handler![
            tray_labels,
            take_app_link,
            open_view_window,
            fetch_calendar,
            quick_ready,
            quick_hide,
            quick_resize,
            show_main_window,
            close_view_window,
            voice::voice_status,
            voice::voice_download,
            voice::voice_cancel_download,
            voice::voice_remove,
            voice::voice_record,
            voice::voice_stop,
            voice::voice_cancel
        ])
        // Закрытие главного окна прячет его в трей: напоминания и синхронизация продолжаются.
        // Всплывающая строка тоже только прячется, в том числе при потере фокуса. Отдельные окна закрываются.
        // Запись голоса в спрятанном или закрытом окне отменяется: микрофон не слушает невидимо.
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" || window.label() == QUICK => {
                let _ = window.hide();
                api.prevent_close();
                window.state::<voice::VoiceState>().cancel_for(window.label());
            }
            WindowEvent::Focused(false) if window.label() == QUICK => {
                let _ = window.hide();
                window.state::<voice::VoiceState>().cancel_for(window.label());
            }
            WindowEvent::Destroyed => window.state::<voice::VoiceState>().cancel_for(window.label()),
            _ => {}
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

    #[test]
    fn quick_window_centered_near_top() {
        // Экран 1920×1040 (без панели задач), строка 640: по центру, на 208 от верха.
        assert_eq!(quick_position(0, 0, 1920, 1040, 640), (640, 208));
        // Второй экран слева от основного.
        assert_eq!(quick_position(-2560, 0, 2560, 1400, 1280), (-1920, 280));
        // Строка шире экрана — прижата к левому краю, а не уходит за него.
        assert_eq!(quick_position(100, 50, 500, 800, 640), (100, 210));
    }
}
