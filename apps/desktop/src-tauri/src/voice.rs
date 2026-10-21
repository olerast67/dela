// Голосовой ввод задачи без облака: запись с микрофона (WASAPI через cpal) и распознавание sherpa-onnx
// на компьютере. Модели те же, что на телефоне (ModelPacks.java): скачиваются кнопкой в настройках,
// сверяются по SHA-256 и лежат в локальной папке данных программы. Звук никуда не отправляется.

use sha2::{Digest, Sha256};
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub struct Item {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub struct Pack {
    pub id: &'static str,
    pub items: &'static [Item],
}

impl Pack {
    pub fn total(&self) -> u64 {
        self.items.iter().map(|i| i.size).sum()
    }
}

// Модели sherpa-onnx от его автора на Hugging Face, закреплённые за коммитом. Список совпадает с телефонным:
// это проверяет тест models_match_android.
// Русская: малый потоковый Zipformer alphacep (vosk), int8, Apache-2.0.
macro_rules! ru {
    ($f:literal) => {
        concat!("https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16/resolve/31fa603e4f31279c6e1f7600fed13dc4312663ab/", $f)
    };
}
// Английская: потоковый Zipformer icefall на LibriSpeech (2023-06-26), int8, Apache-2.0.
macro_rules! en {
    ($f:literal) => {
        concat!("https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24/", $f)
    };
}

pub static RU: Pack = Pack {
    id: "ru",
    items: &[
        Item { name: "encoder.int8.onnx", url: ru!("encoder.int8.onnx"), size: 26214060, sha256: "e0db705e94ec35d803b1df4f40cda23d064e1142977c80ab288430b109777a9d" },
        Item { name: "decoder.onnx", url: ru!("decoder.onnx"), size: 2093080, sha256: "89b3088a9e20e1ef7f2e85ce1a3478afe6a9c4ac57369cabcc4beb8e95328ea0" },
        Item { name: "joiner.int8.onnx", url: ru!("joiner.int8.onnx"), size: 259417, sha256: "b55784b071ab7512eab4c7c44e4f5478284ef33c83562cc6a249b972515a31e5" },
        Item { name: "tokens.txt", url: ru!("tokens.txt"), size: 6388, sha256: "93bbbc0bae6b78c0bbb743d4aa9fded3bb5ff3aac5f0200e3a769a5a05e0fdf6" },
    ],
};

pub static EN: Pack = Pack {
    id: "en",
    items: &[
        Item { name: "encoder.int8.onnx", url: en!("encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"), size: 71083163, sha256: "563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1" },
        Item { name: "decoder.onnx", url: en!("decoder-epoch-99-avg-1-chunk-16-left-128.onnx"), size: 2092621, sha256: "7bf787f90b194b307e5a4ad6a34fadb4e748304c35f78a8d66358a05b13ee6ef" },
        Item { name: "joiner.int8.onnx", url: en!("joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"), size: 259335, sha256: "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297" },
        Item { name: "tokens.txt", url: en!("tokens.txt"), size: 5048, sha256: "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb" },
    ],
};

pub static PACKS: [&Pack; 2] = [&RU, &EN];

pub fn pack(id: &str) -> Option<&'static Pack> {
    PACKS.iter().copied().find(|p| p.id == id)
}

/** Модель скачана целиком: все файлы на месте и нужного размера (хэш проверен при скачивании). */
pub fn ready(dir: &Path, p: &Pack) -> bool {
    p.items.iter().all(|i| std::fs::metadata(dir.join(i.name)).is_ok_and(|m| m.is_file() && m.len() == i.size))
}

fn bytes_on_disk(dir: &Path, p: &Pack) -> u64 {
    p.items.iter().filter_map(|i| std::fs::metadata(dir.join(i.name)).ok()).map(|m| m.len()).sum()
}

/** Модель для языка интерфейса, а если скачана только другая — она. */
pub fn choose(lang: &str, is_ready: impl Fn(&Pack) -> bool) -> Option<&'static Pack> {
    let (first, second): (&'static Pack, &'static Pack) = if lang.starts_with("en") { (&EN, &RU) } else { (&RU, &EN) };
    [first, second].into_iter().find(|p| is_ready(p))
}

// ---------- библиотеки ----------

/**
 * Библиотеки sherpa-onnx и onnxruntime лежат рядом с программой и подключаются отложенно (/DELAYLOAD):
 * без них программа запускается, только голосовой ввод недоступен. Перед первым вызовом обе загружаются
 * по полному пути: так не подхватится чужой onnxruntime.dll из системной папки Windows 11.
 */
pub fn supported() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| {
        let Ok(exe) = std::env::current_exe() else { return false };
        let Some(dir) = exe.parent() else { return false };
        // В тестах программа лежит в target/debug/deps, а библиотеки — уровнем выше.
        let dirs = [Some(dir), dir.parent().filter(|_| dir.ends_with("deps"))];
        for d in dirs.into_iter().flatten() {
            let ort = d.join("onnxruntime.dll");
            let api = d.join("sherpa-onnx-c-api.dll");
            if !ort.is_file() || !api.is_file() {
                continue;
            }
            // Библиотеки остаются загруженными до выхода из программы.
            match unsafe { (libloading::Library::new(&ort), libloading::Library::new(&api)) } {
                (Ok(a), Ok(b)) => {
                    std::mem::forget(a);
                    std::mem::forget(b);
                    return true;
                }
                (a, b) => {
                    eprintln!("sherpa-onnx is not available: {:?} {:?}", a.err(), b.err());
                    return false;
                }
            }
        }
        false
    })
}

// ---------- скачивание ----------

/** Ошибка для веб-клиента: коды как у плагина Recognize на телефоне. */
pub type Code = &'static str;

/** Скачать недостающие файлы модели. Каждый пишется во временный файл и переименовывается после проверки хэша. */
pub async fn download(dir: &Path, p: &Pack, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(), Code> {
    std::fs::create_dir_all(dir).map_err(io_code)?;
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    // Hugging Face отдаёт файл переадресацией на свой CDN: переходы только по https.
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 5 || attempt.url().scheme() != "https" {
            attempt.error("redirect")
        } else {
            attempt.follow()
        }
    });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .user_agent("Dela")
        .redirect(redirects)
        .build()
        .map_err(|_| "network")?;
    let total = p.total();
    let mut done = 0u64;
    for item in p.items {
        let file = dir.join(item.name);
        if std::fs::metadata(&file).is_ok_and(|m| m.len() == item.size) {
            done += item.size;
            continue;
        }
        let part = dir.join(format!("{}.part", item.name));
        let got = fetch(&client, item, &part, cancel, done, total, &mut progress).await;
        if let Err(code) = got {
            let _ = std::fs::remove_file(&part);
            return Err(code);
        }
        if std::fs::rename(&part, &file).is_err() {
            let _ = std::fs::remove_file(&part);
            return Err("failed");
        }
        done += item.size;
        progress(done, total);
    }
    Ok(())
}

async fn fetch(client: &reqwest::Client, item: &Item, to: &Path, cancel: &AtomicBool, before: u64, total: u64, progress: &mut impl FnMut(u64, u64)) -> Result<(), Code> {
    use std::io::Write;
    let mut resp = client.get(item.url).send().await.map_err(|_| "network")?;
    if !resp.status().is_success() {
        return Err("network");
    }
    let mut out = std::io::BufWriter::new(std::fs::File::create(to).map_err(io_code)?);
    let mut hash = Sha256::new();
    let mut got = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|_| "network")? {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled");
        }
        got += chunk.len() as u64;
        if got > item.size {
            return Err("checksum");
        }
        hash.update(&chunk);
        out.write_all(&chunk).map_err(io_code)?;
        progress(before + got, total);
    }
    out.flush().map_err(io_code)?;
    drop(out);
    if got != item.size || hex(&hash.finalize()) != item.sha256 {
        return Err("checksum");
    }
    Ok(())
}

fn io_code(e: std::io::Error) -> Code {
    if e.kind() == std::io::ErrorKind::StorageFull {
        "no_space"
    } else {
        "failed"
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/** Удалить модель целиком. */
pub fn remove(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

// ---------- распознавание ----------

/** Распознаватель как на телефоне: потоковый Zipformer, жадный поиск, конец фразы по паузе. */
pub fn recognizer(dir: &Path) -> Result<OnlineRecognizer, Code> {
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let mut config = OnlineRecognizerConfig::default();
    config.model_config.transducer.encoder = path("encoder.int8.onnx");
    config.model_config.transducer.decoder = path("decoder.onnx");
    config.model_config.transducer.joiner = path("joiner.int8.onnx");
    config.model_config.tokens = path("tokens.txt");
    config.model_config.num_threads = 2;
    config.model_config.model_type = Some("zipformer2".into());
    config.decoding_method = Some("greedy_search".into());
    config.enable_endpoint = true;
    // Тишина 5 с без слов — пользователь ничего не сказал; пауза 1,5 с после слов — фраза закончена.
    config.rule1_min_trailing_silence = 5.0;
    config.rule2_min_trailing_silence = 1.5;
    config.rule3_min_utterance_length = 25.0;
    OnlineRecognizer::create(&config).ok_or("failed")
}

/** Одна диктовка: звук идёт кусками, текст растёт, пауза в речи заканчивает фразу. */
pub struct Session<'a> {
    rec: &'a OnlineRecognizer,
    stream: OnlineStream,
    rate: i32,
}

impl<'a> Session<'a> {
    pub fn new(rec: &'a OnlineRecognizer, rate: i32) -> Self {
        Session { rec, stream: rec.create_stream(), rate }
    }

    /** Принять кусок звука (моно, от -1 до 1). true — фраза закончилась паузой. */
    pub fn feed(&mut self, samples: &[f32]) -> bool {
        // Частоту микрофона (обычно 48 кГц) sherpa-onnx приводит к 16 кГц своим ресэмплером.
        self.stream.accept_waveform(self.rate, samples);
        while self.rec.is_ready(&self.stream) {
            self.rec.decode(&self.stream);
        }
        self.rec.is_endpoint(&self.stream)
    }

    pub fn partial(&self) -> String {
        self.rec.get_result(&self.stream).map(|r| r.text.trim().to_string()).unwrap_or_default()
    }

    /** Досчитать последнее слово и вернуть текст. */
    pub fn finish(self) -> String {
        // Треть секунды тишины в конце, чтобы модель досчитала последнее слово.
        self.stream.accept_waveform(self.rate, &vec![0.0; (self.rate / 3).max(1) as usize]);
        self.stream.input_finished();
        while self.rec.is_ready(&self.stream) {
            self.rec.decode(&self.stream);
        }
        self.partial()
    }
}

/** Что происходит с записью: для индикатора в поле быстрого добавления. */
pub enum Event {
    /** Микрофон открыт, можно говорить. */
    Listening,
    /** Распознанный пока текст. */
    Partial(String),
    /** Громкость последней десятой секунды, от 0 до 1. */
    Level(f32),
}

/** Флаги записи: «Стоп» заканчивает фразу, отмена выбрасывает её. */
#[derive(Default)]
pub struct Control {
    pub stop: AtomicBool,
    pub cancel: AtomicBool,
}

/** Дольше этого одна диктовка не длится. */
const MAX_RECORD: Duration = Duration::from_secs(30);

/**
 * Записать фразу с микрофона по умолчанию и распознать её. Микрофон открывается сразу, модель загружается
 * параллельно (звук копится в очереди). Конец — пауза после слов, «Стоп» или 30 секунд.
 */
pub fn listen(dir: &Path, control: &Control, mut on_event: impl FnMut(Event)) -> Result<String, Code> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let device = cpal::default_host().default_input_device().ok_or("no_mic")?;
    let supported = device.default_input_config().map_err(|_| "no_mic")?;
    let config = supported.config();
    let channels = config.channels.max(1) as usize;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => input::<f32>(&device, config, channels, tx),
        cpal::SampleFormat::I16 => input::<i16>(&device, config, channels, tx),
        cpal::SampleFormat::I32 => input::<i32>(&device, config, channels, tx),
        cpal::SampleFormat::U16 => input::<u16>(&device, config, channels, tx),
        _ => return Err("no_mic"),
    }
    .map_err(|_| "no_mic")?;
    // Нет доступа (выключен в параметрах конфиденциальности Windows) — ошибка здесь или при открытии потока.
    stream.play().map_err(|_| "no_mic")?;
    on_event(Event::Listening);

    let rec = recognizer(dir)?;
    let mut session = Session::new(&rec, config.sample_rate as i32);
    let started = Instant::now();
    let mut last_partial = String::new();
    let mut level_sum = 0f32;
    let mut level_n = 0usize;
    let mut level_at = Instant::now();
    loop {
        if control.cancel.load(Ordering::SeqCst) {
            return Err("cancelled");
        }
        if control.stop.load(Ordering::SeqCst) || started.elapsed() > MAX_RECORD {
            break;
        }
        let chunk = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(c) => c,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            // Микрофон отключили во время записи.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        level_sum += chunk.iter().map(|s| s * s).sum::<f32>();
        level_n += chunk.len();
        if level_at.elapsed() >= Duration::from_millis(100) && level_n > 0 {
            on_event(Event::Level(level(level_sum / level_n as f32)));
            level_sum = 0.0;
            level_n = 0;
            level_at = Instant::now();
        }
        let end = session.feed(&chunk);
        let partial = session.partial();
        if partial != last_partial {
            on_event(Event::Partial(partial.clone()));
            last_partial = partial;
        }
        if end {
            break;
        }
    }
    // Микрофон закрывается сразу, а не после досчёта.
    drop(stream);
    while let Ok(chunk) = rx.try_recv() {
        session.feed(&chunk);
    }
    Ok(session.finish())
}

/** Громкость для индикатора: средний квадрат в шкалу 0..1 по децибелам (-60 дБ — тишина). */
fn level(mean_square: f32) -> f32 {
    let db = 10.0 * mean_square.max(1e-10).log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

fn input<T>(device: &cpal::Device, config: cpal::StreamConfig, channels: usize, tx: std::sync::mpsc::Sender<Vec<f32>>) -> Result<cpal::Stream, cpal::Error>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    use cpal::traits::DeviceTrait;
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Каналы сводятся в моно.
            let mono: Vec<f32> = data.chunks(channels).map(|f| f.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / f.len() as f32).collect();
            let _ = tx.send(mono);
        },
        |err| eprintln!("microphone: {err}"),
        None,
    )
}

// ---------- команды для веб-клиента ----------

/** Состояние голосового ввода в программе: скачивание модели и текущая запись. */
#[derive(Default)]
pub struct VoiceState {
    downloading: Mutex<Option<&'static str>>,
    download_cancel: Mutex<Arc<AtomicBool>>,
    recording: Mutex<Option<(String, Arc<Control>)>>,
}

impl VoiceState {
    /** Окно спряталось или закрылось: его запись отменяется. */
    pub fn cancel_for(&self, label: &str) {
        if let Some((owner, c)) = self.recording.lock().unwrap().as_ref() {
            if owner == label {
                c.cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, Code> {
    // Локальная папка (AppData\Local), а не перемещаемая: модели весят десятки мегабайт.
    app.path().app_local_data_dir().map(|d| d.join("asr")).map_err(|_| "failed")
}

fn pack_dir(app: &AppHandle, p: &Pack) -> Result<PathBuf, Code> {
    Ok(models_dir(app)?.join(p.id))
}

/** Состояние в том же виде, что у плагина Recognize на телефоне (без картинок). */
#[tauri::command]
pub fn voice_status(app: AppHandle, state: tauri::State<'_, VoiceState>) -> Result<serde_json::Value, String> {
    let mut r = serde_json::json!({
        "ocr": { "ready": false, "size": 0 },
        "ocrSupported": false,
        "speechSupported": supported(),
        "downloading": *state.downloading.lock().unwrap(),
        "pending": null,
    });
    for p in PACKS {
        let dir = pack_dir(&app, p)?;
        r[p.id] = serde_json::json!({ "ready": ready(&dir, p), "size": p.total(), "bytes": bytes_on_disk(&dir, p) });
    }
    Ok(r)
}

#[tauri::command]
pub async fn voice_download(app: AppHandle, state: tauri::State<'_, VoiceState>, pack: String) -> Result<(), String> {
    let p = self::pack(&pack).ok_or("failed")?;
    {
        let mut d = state.downloading.lock().unwrap();
        if d.is_some() {
            return Err("busy".into());
        }
        *d = Some(p.id);
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.download_cancel.lock().unwrap() = cancel.clone();
    let result = match pack_dir(&app, p) {
        Ok(dir) => {
            let mut last = Instant::now() - Duration::from_secs(1);
            download(&dir, p, &cancel, |done, total| {
                // Не чаще пяти раз в секунду: событие идёт в WebView.
                if done < total && last.elapsed() < Duration::from_millis(200) {
                    return;
                }
                last = Instant::now();
                let _ = app.emit("model-progress", serde_json::json!({ "pack": p.id, "done": done, "total": total }));
            })
            .await
        }
        Err(code) => Err(code),
    };
    *state.downloading.lock().unwrap() = None;
    result.map_err(String::from)
}

#[tauri::command]
pub fn voice_cancel_download(state: tauri::State<'_, VoiceState>) {
    state.download_cancel.lock().unwrap().store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn voice_remove(app: AppHandle, state: tauri::State<'_, VoiceState>, pack: String) -> Result<(), String> {
    let p = self::pack(&pack).ok_or("failed")?;
    if *state.downloading.lock().unwrap() == Some(p.id) || state.recording.lock().unwrap().is_some() {
        return Err("busy".into());
    }
    remove(&pack_dir(&app, p)?);
    Ok(())
}

/**
 * Записать и распознать фразу. lang — язык интерфейса: модель этого языка, а если она не скачана — другая.
 * Ход записи приходит окну событием voice-event; результат — текст фразы (пустой, если слов не было).
 * Ошибки: unsupported, no_model, no_mic, busy, cancelled, failed.
 */
#[tauri::command]
pub async fn voice_record(app: AppHandle, window: WebviewWindow, state: tauri::State<'_, VoiceState>, lang: String) -> Result<String, String> {
    if !supported() {
        return Err("unsupported".into());
    }
    let root = models_dir(&app)?;
    let p = choose(&lang, |p| ready(&root.join(p.id), p)).ok_or("no_model")?;
    let dir = root.join(p.id);
    let control = Arc::new(Control::default());
    let label = window.label().to_string();
    {
        let mut r = state.recording.lock().unwrap();
        if r.is_some() {
            return Err("busy".into());
        }
        *r = Some((label.clone(), control.clone()));
    }
    let worker = control.clone();
    let emitter = app.clone();
    let target = label.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        listen(&dir, &worker, |e| {
            let payload = match e {
                Event::Listening => serde_json::json!({ "kind": "listening" }),
                Event::Partial(text) => serde_json::json!({ "kind": "partial", "text": text }),
                Event::Level(level) => serde_json::json!({ "kind": "level", "level": level }),
            };
            let _ = emitter.emit_to(target.as_str(), "voice-event", payload);
        })
    })
    .await
    .unwrap_or(Err("failed"));
    *state.recording.lock().unwrap() = None;
    result.map_err(String::from)
}

/** Второе нажатие на микрофон: закончить фразу и распознать сказанное. */
#[tauri::command]
pub fn voice_stop(state: tauri::State<'_, VoiceState>) {
    if let Some((_, c)) = state.recording.lock().unwrap().as_ref() {
        c.stop.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn voice_cancel(state: tauri::State<'_, VoiceState>) {
    if let Some((_, c)) = state.recording.lock().unwrap().as_ref() {
        c.cancel.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /** Список моделей тот же, что в приложении для Android: адреса, размеры и хэши. */
    #[test]
    fn models_match_android() {
        let java = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../mobile/android/app/src/main/java/io/github/olerast67/dela/ModelPacks.java")).unwrap();
        for p in PACKS {
            for i in p.items {
                let (base, file) = i.url.rsplit_once('/').unwrap();
                assert!(java.contains(&format!("\"{base}/\"")), "{} {}: base url", p.id, i.name);
                let line = format!("new Item(\"{}\", {} + \"{}\", {}, \"{}\")", i.name, p.id.to_uppercase(), file, i.size, i.sha256);
                assert!(java.contains(&line), "{line}");
            }
            let count = java.matches(&format!(" {} + \"", p.id.to_uppercase())).count();
            assert_eq!(count, p.items.len(), "{}: number of files", p.id);
        }
    }

    #[test]
    fn model_follows_interface_language() {
        let all = |_: &Pack| true;
        assert_eq!(choose("ru", all).unwrap().id, "ru");
        assert_eq!(choose("en", all).unwrap().id, "en");
        assert_eq!(choose("en-US", |p: &Pack| p.id == "ru").unwrap().id, "ru");
        assert_eq!(choose("ru", |p: &Pack| p.id == "en").unwrap().id, "en");
        assert!(choose("ru", |_: &Pack| false).is_none());
    }

    #[test]
    fn level_scale() {
        assert_eq!(level(0.0), 0.0);
        assert_eq!(level(1.0), 1.0);
        assert!((level(1e-3) - 0.5).abs() < 1e-6);
    }

    /** Скачать русскую модель с проверкой хэшей. Запуск: DELA_VOICE_DOWNLOAD=<пустая папка> cargo test -- --ignored voice_download */
    #[test]
    #[ignore]
    fn voice_download() {
        let dir = PathBuf::from(std::env::var("DELA_VOICE_DOWNLOAD").unwrap());
        let cancel = AtomicBool::new(false);
        let mut last = 0;
        tauri::async_runtime::block_on(download(&dir, &RU, &cancel, |done, total| {
            assert!(done >= last && done <= total);
            last = done;
        }))
        .unwrap();
        assert!(ready(&dir, &RU));
        assert_eq!(last, RU.total());
    }

    /**
     * Запись с настоящего микрофона тем же путём, что у кнопки: до паузы или 10 секунд.
     * Запуск: DELA_VOICE_MODEL=<папка модели> cargo test -- --ignored --nocapture voice_mic
     */
    #[test]
    #[ignore]
    fn voice_mic() {
        assert!(supported(), "sherpa-onnx DLLs not found");
        let dir = PathBuf::from(std::env::var("DELA_VOICE_MODEL").unwrap());
        let control = Arc::new(Control::default());
        let c = control.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(10));
            c.stop.store(true, Ordering::SeqCst);
        });
        let (mut listening, mut levels, mut loud) = (false, 0, 0f32);
        let text = listen(&dir, &control, |e| match e {
            Event::Listening => listening = true,
            Event::Level(l) => {
                levels += 1;
                loud = loud.max(l);
            }
            Event::Partial(p) => println!("partial: {p}"),
        })
        .unwrap();
        println!("recognized: {text} (levels {levels}, max {loud:.2})");
        assert!(listening && levels > 0);
    }

    /** WAV 16 бит PCM в моно float и частоту. */
    fn read_wav(path: &Path) -> (Vec<f32>, i32) {
        let b = std::fs::read(path).unwrap();
        assert_eq!(&b[0..4], b"RIFF");
        let mut pos = 12;
        let (mut channels, mut rate) = (1usize, 16000i32);
        while pos + 8 <= b.len() {
            let id = &b[pos..pos + 4];
            let len = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
            let body = &b[pos + 8..(pos + 8 + len).min(b.len())];
            if id == b"fmt " {
                assert_eq!(u16::from_le_bytes([body[14], body[15]]), 16, "16-bit PCM only");
                channels = u16::from_le_bytes([body[2], body[3]]) as usize;
                rate = u32::from_le_bytes(body[4..8].try_into().unwrap()) as i32;
            } else if id == b"data" {
                let s: Vec<f32> = body.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
                return (s.chunks(channels).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect(), rate);
            }
            pos += 8 + len + (len & 1);
        }
        panic!("no data chunk");
    }

    /**
     * Распознать WAV тем же путём, что и запись с микрофона: кусками по 10 мс, до паузы.
     * Запуск: DELA_VOICE_MODEL=<папка модели> DELA_VOICE_WAV=<файл> DELA_VOICE_EXPECT=<слова через |> cargo test -- --ignored voice_wav
     */
    #[test]
    #[ignore]
    fn voice_wav() {
        assert!(supported(), "sherpa-onnx DLLs not found");
        let dir = PathBuf::from(std::env::var("DELA_VOICE_MODEL").unwrap());
        let (samples, rate) = read_wav(Path::new(&std::env::var("DELA_VOICE_WAV").unwrap()));
        let rec = recognizer(&dir).unwrap();
        let mut s = Session::new(&rec, rate);
        for chunk in samples.chunks((rate / 100) as usize) {
            if s.feed(chunk) {
                break;
            }
        }
        let text = s.finish().to_lowercase();
        println!("recognized: {text}");
        for word in std::env::var("DELA_VOICE_EXPECT").unwrap_or_default().split('|').filter(|w| !w.is_empty()) {
            assert!(text.contains(&word.to_lowercase()), "{word:?} not in {text:?}");
        }
    }
}
