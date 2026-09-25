//! 待上传队列 / 上传窗口相关命令。
//!
//! 设计要点（对应开发文档第 9、10 节）：
//!   - 真正的数据放在 Rust 侧 `PendingUploads`，事件只做"有新东西了"的通知，
//!     避免"窗口 listener 还没初始化 → 路径丢失"；
//!   - 上传窗口 mount 时主动调用 `take_pending_upload_paths()` 取走队列；
//!   - 冷启动（`Notes.exe --upload path`）与二次启动（single instance callback）
//!     走的是完全相同的入队 / 显示 / 通知流程；
//!   - `UploadActivity` 显式记录"是否有上传在跑"，退出逻辑只认它，
//!     不用"上传窗口是否可见"来推断。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::files::to_plain_path;
use crate::config;
use crate::reveal_upload_window;

/// 待上传的本地文件路径队列。
#[derive(Default)]
pub struct PendingUploads(Mutex<Vec<PathBuf>>);

/// 上传窗口的目标目录建议（由首页点 Upload 时写入）。
#[derive(Default)]
pub struct UploadTargetHint(Mutex<Option<UploadTarget>>);

/// 上传活动状态。
///
/// 由上传窗口在上传**真正开始**时置 `true`，在整轮上传的最终清理路径
/// （`startUpload()` 的 `finally`）里置 `false`——**暂停也会走到那条清理路径**，
/// 因此暂停之后这个状态自然变回 false，退出逻辑不会误以为还有上传在跑。
///
/// 退出逻辑只认这个状态，**不再**用"上传窗口是否可见"作为是否在上传的依据：
/// 窗口可见 ≠ 正在上传，窗口隐藏也可能有一个还没收尾的任务。
#[derive(Default)]
pub struct UploadActivity {
    active: AtomicBool,
}

/// 当前是否有上传在跑（Rust 内部读取）。
pub fn is_upload_active(app: &AppHandle) -> bool {
    app.state::<UploadActivity>()
        .active
        .load(Ordering::SeqCst)
}

/// 前端命令：上报"是否有上传在跑"。
///
/// 契约：
///   - `active = true` 必须成功，上传才会开始（fail closed）；
///     失败时前端会放弃本次上传，因此这里不需要额外校验。
///   - `active = false` 是 best-effort 的最终清理，调用方失败也会继续收尾。
#[tauri::command]
pub fn set_upload_active(app: AppHandle, active: bool) {
    app.state::<UploadActivity>()
        .active
        .store(active, Ordering::SeqCst);
}

/// 前端命令：查询是否有上传在跑（首页关闭确认等场景使用）。
#[tauri::command]
pub fn upload_active(app: AppHandle) -> bool {
    is_upload_active(&app)
}

/// 上传窗口里"这一批"是否已被占用。
///
/// 与 [`UploadActivity`] 刻意分开，两者语义不同：
///   - `UploadActivity`：**此刻是否有上传在跑**，只服务退出逻辑；
///   - `UploadBatchBusy`：上传窗口里是否已经有一批任务占着目标目录
///     （待上传 / 上传中 / 失败 / 已取消，含只差补写元数据的任务）。
///
/// 之所以需要后者：目标目录在客户端里是**全局唯一**的，首页如果在前一批还没处理完时
/// 再开一批，新批次的目标目录提示会被 `setUploadTarget()`（上传中拒绝切换）丢掉，
/// 用户以为文件要去 /B，实际却跟着当前批次进了 /A。
#[derive(Default)]
pub struct UploadBatchBusy {
    busy: AtomicBool,
}

/// 前端命令：上报"这一批是否已被占用"。
///
/// 由**上传窗口**在任务列表变化时调用；首页只读不写。
#[tauri::command]
pub fn set_upload_batch_busy(app: AppHandle, busy: bool) {
    app.state::<UploadBatchBusy>()
        .busy
        .store(busy, Ordering::SeqCst);
}

/// 前端命令：查询"这一批是否已被占用"（首页开新批次前检查）。
#[tauri::command]
pub fn upload_batch_busy(app: AppHandle) -> bool {
    app.state::<UploadBatchBusy>().busy.load(Ordering::SeqCst)
}

/// 面包屑的一段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTargetBreadcrumb {
    pub id: i64,
    pub name: String,
}

/// 目标云目录。
///
/// 必须是**完整**面包屑（root 到当前目录），因为 string_of_path 由它推导：
/// `breadcrumbs.map(id => `${id}/`).join('')`，缺少中间层级会写出错误的 objectKey。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTarget {
    pub breadcrumbs: Vec<UploadTargetBreadcrumb>,
}

/// `queue_upload_paths` 的返回结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueUploadResult {
    /// 本次真正新增进队列的文件数（重复路径会被跳过）。
    pub added: usize,
    /// 队列中当前的文件总数。
    pub total: usize,
    /// 被拒绝的原始路径（不存在 / 不是普通文件）。
    pub rejected: Vec<String>,
}

/// 校验一个命令行 / 前端传入的路径：必须真实存在且是普通文件。
///
/// 这里只把字符串当**数据**处理，绝不解释成命令，也不会执行任何 shell。
fn validate_upload_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let path = PathBuf::from(trimmed);

    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => {
            let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            Some(to_plain_path(&canonical))
        }
        _ => None,
    }
}

/// 从进程参数中提取 `--upload <path>`。
///
/// 只接受这一种形式，其余参数（包括 `--upload=`）一律忽略。
/// 第一个参数是可执行文件自身，跳过。
pub fn collect_upload_paths(args: &[String]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut index = 1usize;

    while index < args.len() {
        if args[index] == config::UPLOAD_FLAG {
            if let Some(value) = args.get(index + 1) {
                if let Some(path) = validate_upload_path(value) {
                    paths.push(path);
                }
            }
            index += 2;
            continue;
        }

        index += 1;
    }

    paths
}

/// 入队（自动去重），返回真正新增的数量。
pub fn enqueue(app: &AppHandle, paths: Vec<PathBuf>) -> usize {
    let state = app.state::<PendingUploads>();
    let mut queue = match state.0.lock() {
        Ok(guard) => guard,
        // 其它线程 panic 不应导致整个队列不可用。
        Err(poisoned) => poisoned.into_inner(),
    };

    let mut added = 0usize;
    for path in paths {
        if queue.iter().any(|existing| existing == &path) {
            continue;
        }
        queue.push(path);
        added += 1;
    }

    added
}

/// 通知前端"队列有新内容"。事件只是通知，数据仍然在 Rust 侧。
pub fn notify_pending(app: &AppHandle) {
    if let Err(error) = app.emit(config::EVENT_UPLOAD_PENDING, ()) {
        eprintln!("[notes-desktop] 发送待上传通知失败：{error}");
    }
}

/// 首页选择本地文件后调用：把绝对路径放进队列。
#[tauri::command]
pub fn queue_upload_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<QueueUploadResult, String> {
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();

    for raw in paths {
        match validate_upload_path(&raw) {
            Some(path) => accepted.push(path),
            None => rejected.push(raw),
        }
    }

    if accepted.is_empty() {
        return Err("没有可上传的本地文件".to_string());
    }

    let added = enqueue(&app, accepted);

    // 取出锁之后再放进局部变量，避免 MutexGuard 临时值比 State 活得更久。
    let total = {
        let state = app.state::<PendingUploads>();
        let queue = match state.0.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        queue.len()
    };

    Ok(QueueUploadResult {
        added,
        total,
        rejected,
    })
}

/// 上传窗口 mount 时主动调用：取走当前队列（取走即清空）。
#[tauri::command]
pub fn take_pending_upload_paths(app: AppHandle) -> Vec<String> {
    let state = app.state::<PendingUploads>();
    let mut queue = match state.0.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    let taken = std::mem::take(&mut *queue);

    taken
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// 打开（显示 + 聚焦）上传窗口。
///
/// `target` 可选：首页点 Upload 时把**当前完整面包屑**作为目标目录建议传过来；
/// Explorer 右键走的是 Rust 内部路径，不带建议，上传窗口保持它已有的目标目录。
#[tauri::command]
pub fn open_upload_window(
    app: AppHandle,
    target: Option<Vec<UploadTargetBreadcrumb>>,
) -> Result<(), String> {
    if let Some(breadcrumbs) = target {
        let breadcrumbs: Vec<UploadTargetBreadcrumb> = breadcrumbs
            .into_iter()
            .filter(|item| item.id > 0 && !item.name.trim().is_empty())
            .collect();

        if !breadcrumbs.is_empty() {
            let hint = UploadTarget { breadcrumbs };

            {
                let state = app.state::<UploadTargetHint>();
                let mut slot = match state.0.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                *slot = Some(hint.clone());
            }

            if let Err(error) = app.emit(config::EVENT_UPLOAD_TARGET, hint) {
                eprintln!("[notes-desktop] 发送目标目录通知失败：{error}");
            }
        }
    }

    reveal_upload_window(&app)
}

/// 上传窗口 mount 时调用：取走目标目录建议（取走即清空），避免使用过期建议。
#[tauri::command]
pub fn take_upload_target_hint(app: AppHandle) -> Option<UploadTarget> {
    let state = app.state::<UploadTargetHint>();
    let mut hint = match state.0.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    hint.take()
}
