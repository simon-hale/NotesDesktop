//! Notes Desktop 应用入口（三平台共用）。
//!
//! 窗口约定：
//!   - `main`：普通首页（900x650），tauri.conf.json 里默认隐藏，
//!     普通启动时由 `setup` 显示；带 `--upload` 冷启动时只显示上传窗口，避免大窗口打断用户。
//!   - `upload`：独立上传窗口（560x620），默认隐藏，由首页 Upload 按钮或 Explorer 右键唤起。
//!
//! 两个窗口加载同一个 SPA，由前端读取 `getCurrentWindow().label` 决定渲染哪个视图。

mod commands;
mod config;
mod shell_integration;

use tauri::{AppHandle, Manager};

/// 显示并聚焦上传窗口。
pub(crate) fn reveal_upload_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(config::UPLOAD_WINDOW_LABEL)
        .ok_or_else(|| "上传窗口不存在".to_string())?;

    window.show().map_err(|error| error.to_string())?;
    // 已最小化时先还原，再聚焦。
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())?;

    Ok(())
}

/// 显示并聚焦主窗口。
pub(crate) fn focus_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(config::MAIN_WINDOW_LABEL)
        .ok_or_else(|| "主窗口不存在".to_string())?;

    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())?;

    Ok(())
}

/// 应用主入口。
pub fn run() {
    tauri::Builder::default()
        // ⚠️ single-instance 必须是**第一个**注册的 Tauri plugin。
        // 程序已运行时再次执行 Notes.exe --upload，会走到这里的回调。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = commands::upload_queue::collect_upload_paths(&argv);

            if paths.is_empty() {
                // 用户只是又启动了一次应用：把已有主窗口带到前台。
                let _ = focus_main_window(app);
                return;
            }

            commands::upload_queue::enqueue(app, paths);
            let _ = reveal_upload_window(app);
            commands::upload_queue::notify_pending(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(commands::upload_queue::PendingUploads::default())
        .manage(commands::upload_queue::UploadTargetHint::default())
        .manage(commands::upload_queue::UploadActivity::default())
        .manage(commands::upload_queue::UploadBatchBusy::default())
        .manage(commands::app_lifecycle::ExitHandshake::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_lifecycle::quit_app,
            commands::app_lifecycle::confirm_exit_ready,
            commands::files::stat_local_file,
            commands::files::read_file_chunk,
            commands::upload_queue::queue_upload_paths,
            commands::upload_queue::take_pending_upload_paths,
            commands::upload_queue::open_upload_window,
            commands::upload_queue::take_upload_target_hint,
            commands::upload_queue::set_upload_active,
            commands::upload_queue::upload_active,
            commands::upload_queue::set_upload_batch_busy,
            commands::upload_queue::upload_batch_busy,
            shell_integration::install_shell_integration,
            shell_integration::uninstall_shell_integration,
            shell_integration::shell_integration_status,
        ])
        .on_window_event(|window, event| {
            // 兜底：主窗口被真正销毁时结束进程，避免出现"只剩隐藏窗口"的僵尸进程。
            // 正常路径是前端先 preventDefault 再调用 quit_app；
            // 这里同样走优雅退出（先让上传窗口清理），不会直接 exit。
            if window.label() != config::MAIN_WINDOW_LABEL {
                return;
            }

            if matches!(event, tauri::WindowEvent::Destroyed) {
                commands::app_lifecycle::request_exit(window.app_handle());
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // 冷启动：Notes.exe --upload "C:\a.pdf"
            let args: Vec<String> = std::env::args().collect();
            let paths = commands::upload_queue::collect_upload_paths(&args);

            if paths.is_empty() {
                // 普通启动：显示主窗口。
                let _ = focus_main_window(&handle);
            } else {
                commands::upload_queue::enqueue(&handle, paths);
                let _ = reveal_upload_window(&handle);
                commands::upload_queue::notify_pending(&handle);
            }

            #[cfg(target_os = "windows")]
            {
                // 只在用户没有关掉这个功能时才动注册表：
                //  - 开启（默认）：幂等注册，把 executable path 刷新到当前值；
                //  - 关闭：完全不碰注册表，尊重用户的选择。
                // 失败不影响应用启动（例如受限的企业策略环境）。
                if shell_integration::is_enabled(&handle) {
                    if let Err(error) = shell_integration::install() {
                        eprintln!("[notes-desktop] 注册 Explorer 右键菜单失败：{error}");
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Notes Desktop");
}
