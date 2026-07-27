fn main() {
    // Only run tauri-build when the GUI feature is enabled
    if std::env::var("CARGO_FEATURE_GUI").is_ok() {
        tauri_build::build()
    }
}
