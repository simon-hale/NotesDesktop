//! 应用退出相关命令。
//!
//! 退出流程（对应"上传中优雅退出"的要求）：
//!
//! ```text
//! 主窗口请求退出
//!   1. 没有上传在跑（UploadActivity == false）-> 直接 exit(0)
//!   2. 有上传在跑 ->
//!        a. 广播 EVENT_PREPARE_EXIT，让上传窗口**暂停**上传
//!           （持久化 checkpoint、停止调度新分片，**不** AbortMultipartUpload）
//!        b. 等待它调用 confirm_exit_ready（或 EXIT_CLEANUP_TIMEOUT_MS 超时）
//!        c. exit(0)
//! ```
//!
//! 关键点：
//!   - 是否"有上传在跑"只认显式的 `UploadActivity`，**不看窗口可见性**；
//!   - **绝不在上传仍然活跃时直接 exit(0)**，但等待一定是**有界**的：
//!     绝不会为了让一个在途的 OSS 请求（最长 180 秒）返回而拖住关机；
//!   - 退出**不是取消**：Rust 侧从不调用 AbortMultipartUpload，
//!     所有 multipart 与本地断点记录都保留，下次启动可以继续；
//!   - 进程带着在途分片退出也是安全的：那个"服务端已成功但本地还没记下 ETag"
//!     的分片，下次 Resume 会用同一个 partNumber 重传（幂等）；
//!   - 只有用户在界面上显式点"取消上传"才是破坏性操作，走的是前端 upload.ts 的
//!     取消路径（abort multipart + 删除 checkpoint），与这里无关。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::upload_queue::is_upload_active;
use crate::config;

/// 退出握手的共享状态。
#[derive(Default)]
pub struct ExitHandshake {
    /// 上传窗口已经完成清理（checkpoint 已落盘、不再调度新分片）。
    ready: AtomicBool,
    /// 已经有人请求过退出，避免重复广播与重复起线程。
    requested: AtomicBool,
}

/// 前端命令：上传窗口完成清理后调用，表示可以真正退出了。
#[tauri::command]
pub fn confirm_exit_ready(app: AppHandle) {
    app.state::<ExitHandshake>()
        .ready
        .store(true, Ordering::SeqCst);
}

/// 请求退出：有上传在跑时先走"通知暂停 -> 有界等待 -> 退出"。
///
/// 注意这里**不做任何破坏性清理**：exit 之后 multipart 与本地 checkpoint
/// 都保持原样，下次启动可以从断点继续。
pub fn request_exit(app: &AppHandle) {
    {
        let handshake = app.state::<ExitHandshake>();

        // 重复请求（例如连点两次关闭）直接忽略，避免重置等待状态。
        if handshake.requested.swap(true, Ordering::SeqCst) {
            return;
        }

        handshake.ready.store(false, Ordering::SeqCst);
    }

    if !is_upload_active(app) {
        // 没有进行中的上传：直接退出。
        app.exit(0);
        return;
    }

    if let Err(error) = app.emit(config::EVENT_PREPARE_EXIT, ()) {
        eprintln!("[notes-desktop] 广播退出清理事件失败：{error}");
    }

    let handle = app.clone();

    // 用普通线程做有界等待：不依赖异步运行时的存活性，
    // 上传窗口即使完全没有响应也会在超时后退出。
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(config::EXIT_CLEANUP_TIMEOUT_MS);

        while Instant::now() < deadline {
            if handle.state::<ExitHandshake>().ready.load(Ordering::SeqCst) {
                break;
            }

            std::thread::sleep(Duration::from_millis(config::EXIT_POLL_INTERVAL_MS));
        }

        handle.exit(0);
    });
}

/// 前端命令：退出整个应用。
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    request_exit(&app);
}
