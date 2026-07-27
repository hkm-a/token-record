pub mod core;
mod config;
mod tray;

use core::types::{Preferences, Snapshot, SnapshotOutput};
use core::collectors;
use core::sources;
use core::aggregator;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;
/// 应用状态：缓存最新快照
struct AppState {
    last_snapshot: Mutex<Option<Snapshot>>,
}

/// 刷新数据（核心 tick 逻辑）
fn refresh() -> SnapshotOutput {
    // 采集所有事件
    let mut events = Vec::new();
    events.extend(collectors::collect_claude_events());
    events.extend(collectors::collect_codex_events());
    events.extend(collectors::collect_pi_events());
    events.extend(collectors::collect_grok_events());

    // 聚合
    let mut snapshot = aggregator::aggregate(&events);

    // 探测数据源状态
    snapshot.sources = sources::probe_sources();

    let is_first = false; // 简化处理

    SnapshotOutput {
        snapshot,
        is_first,
        has_delta: true,
    }
}

/// Tauri 命令：获取快照
#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> SnapshotOutput {
    let output = refresh();
    if let Ok(mut last) = state.last_snapshot.lock() {
        *last = Some(output.snapshot.clone());
    }
    output
}

/// Tauri 命令：获取偏好设置
#[tauri::command]
fn get_prefs() -> Preferences {
    config::load_prefs()
}

/// Tauri 命令：保存偏好设置
#[tauri::command]
fn save_prefs(prefs: Preferences) {
    config::save_prefs(&prefs);
}

/// Tauri 命令：获取版本号
#[tauri::command]
fn get_version() -> String {
    "1.5.8".to_string()
}

/// Tauri 命令：获取应用信息
#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "version": "1.5.8",
        "appId": "com.hkma.token-record",
    })
}

/// Tauri 命令：退出应用
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tauri 命令：检查更新（由更新插件处理）
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let response = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = response {
        let latest = update.version.clone();
        let _ = app.emit("update-available", serde_json::json!({
            "latestVersion": latest,
        }));
    }
    Ok(())
}

/// Tauri 命令：应用更新
#[tauri::command]
async fn apply_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let response = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = response {
        update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        app.exit(0);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            last_snapshot: Mutex::new(None),
        })
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_prefs,
            save_prefs,
            get_version,
            get_app_info,
            quit_app,
            check_update,
            apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Token记录");
}
