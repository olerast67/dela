// Сборка: tauri-build и библиотеки распознавания речи sherpa-onnx.
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Архив выпуска sherpa-onnx v2.0.1 для Windows x64, который скачивает сборка крейта sherpa-onnx-sys
/// (github.com/k2-fsa/sherpa-onnx/releases, Apache-2.0; onnxruntime внутри — MIT; SHA-256 архива
/// afa4de3ca4ab0afd53bb4aab40d28ee15608364b549ffc0fe0caf6489bfc39a5, как в выпуске). В git библиотеки не лежат.
const SHERPA_ARCHIVE: &str = "sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-lib";

/// Файлы из архива, которые попадают в программу, и их SHA-256: другая библиотека — сборка падает.
const SHERPA_FILES: &[(&str, &str)] = &[
    ("sherpa-onnx-c-api.dll", "0965a6e4c0254da2beff489cf7a8aaffaf7dc94f90b43b3e66448b8cab4177ea"),
    ("onnxruntime.dll", "7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25"),
    ("sherpa-onnx-c-api.lib", "edf4b780d0ab4f0320d210f9cfc7e96e01d9b0dbee7234746f6cb6b422065997"),
    ("onnxruntime.lib", "b9fc3cd678257d88a111b0773ede4bfceaf0fe95daab4379f2b2b37348a68781"),
];

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        sherpa();
    }
    tauri_build::build()
}

fn sherpa() {
    let lib = match std::env::var_os("SHERPA_ONNX_LIB_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => target_dir().join("sherpa-onnx-prebuilt").join(SHERPA_ARCHIVE).join("lib"),
    };
    for (name, expected) in SHERPA_FILES {
        let path = lib.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let got = sha256(&path).unwrap_or_else(|e| panic!("sherpa-onnx: {}: {e}", path.display()));
        if got != *expected {
            panic!("sherpa-onnx: checksum mismatch for {}: expected {expected}, got {got}", path.display());
        }
    }
    // Копия для установщика: bundle.resources в tauri.windows.conf.json ставит DLL рядом с Dela.exe.
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let bundle = manifest.join("sherpa-onnx");
    std::fs::create_dir_all(&bundle).unwrap();
    for name in ["sherpa-onnx-c-api.dll", "onnxruntime.dll"] {
        let to = bundle.join(name);
        if sha256(&to).ok() != sha256(&lib.join(name)).ok() {
            std::fs::copy(lib.join(name), &to).unwrap();
        }
    }
    // Библиотека подключается при первом вызове, а не при запуске: без неё программа работает, только без голоса.
    println!("cargo:rustc-link-arg=/DELAYLOAD:sherpa-onnx-c-api.dll");
    println!("cargo:rustc-link-arg=delayimp.lib");
    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_LIB_DIR");
}

/// Папка target, как её находит sherpa-onnx-sys.
fn target_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CARGO_TARGET_DIR") {
        return PathBuf::from(dir);
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    out.ancestors().find(|p| p.file_name().is_some_and(|n| n == "target")).map(Path::to_path_buf).unwrap_or(out)
}

fn sha256(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    // sha2 0.11 не принимает данные через io::Write: файл читается кусками.
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
