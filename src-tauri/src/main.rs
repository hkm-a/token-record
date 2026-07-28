// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use token_record_lib::core::types::{Preferences, SnapshotOutput};
use token_record_lib::config;

// ── Tauri 命令 ──

/// 快照刷新是重 IO（全量/增量扫描各工具会话目录），必须放到阻塞线程池执行；
/// 若作为同步命令跑在主线程，会阻塞 Win32 消息循环，导致拖拽卡顿、按钮点击丢失。
#[tauri::command]
async fn get_snapshot() -> SnapshotOutput {
    tauri::async_runtime::spawn_blocking(token_record_lib::refresh)
        .await
        .expect("snapshot 刷新任务异常退出")
}

#[tauri::command]
fn get_prefs() -> Preferences {
    config::load_prefs()
}

/// 偏好写盘走阻塞线程池，避免折叠/展开点击时在主线程做文件 IO
#[tauri::command]
async fn save_prefs(prefs: Preferences) {
    let _ = tauri::async_runtime::spawn_blocking(move || config::save_prefs(&prefs)).await;
}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 缩放后强制刷新非客户区/DWM 命中区域。
/// 必须带 SWP_NOSIZE|SWP_NOMOVE：SetWindowPos 的 cx/cy 传 0 而缺少 SWP_NOSIZE
/// 会把窗口真实缩成 0x0（1.6.2 的窗口消失/死区来源之一）。
#[cfg(windows)]
#[tauri::command]
fn force_window_resize(window: tauri::Window) {
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP,
            SWP_NOACTIVATE, SWP_NOZORDER, SWP_NOMOVE, SWP_NOSIZE, SWP_FRAMECHANGED
        };
        unsafe {
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
            );
        }
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn force_window_resize(_window: tauri::Window) {}


/// 检查更新。有更新时发出 update-available 事件并返回最新版本号；
/// 无更新返回 None——前端据此给出"已是最新"反馈，避免"检查中"状态卡死。
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let response = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = response {
        let latest = update.version.clone();
        let _ = app.emit("update-available", serde_json::json!({
            "latestVersion": latest,
        }));
        return Ok(Some(latest));
    }
    Ok(None)
}

#[tauri::command]
async fn apply_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let response = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = response {
        let latest = update.version.clone();
        let app_progress = app.clone();
        let app_ready = app.clone();
        let latest_progress = latest.clone();
        update
            .download_and_install(
                move |bytes_downloaded, content_length| {
                    let total = content_length.unwrap_or(0) as f64;
                    let percent = if total > 0.0 {
                        (bytes_downloaded as f64 / total * 100.0).round() as u32
                    } else {
                        0
                    };
                    let _ = app_progress.emit(
                        "update-download-progress",
                        serde_json::json!({
                            "status": "downloading",
                            "percent": percent,
                            "latestVersion": latest_progress,
                        }),
                    );
                },
                move || {
                    let _ = app_ready.emit(
                        "update-download-progress",
                        serde_json::json!({
                            "status": "ready",
                            "latestVersion": latest,
                        }),
                    );
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        app.exit(0);
    }
    Ok(())
}

// ── 托盘 ──

fn setup_tray<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;

    let show_i = MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
    let refresh_i = MenuItem::with_id(app, "refresh", "刷新", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &refresh_i, &quit_i])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Token记录")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            match event.id().0.as_str() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                "refresh" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("refresh-now", ());
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

// ── 入口 ──

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_prefs,
            save_prefs,
            get_version,
            quit_app,
            force_window_resize,
            check_update,
            apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Token记录");
}
