//! 全局常量配置。
//!
//! 这里只放"与运行环境无关"的固定值。环境相关的地址一律走 `.env.local`
//! （前端 `VITE_API_BASE_URL` / 生成出来的 Tauri capability），不要在 Rust 代码里散落常量。

/// 主窗口 label（与 tauri.conf.json 中的 windows[].label 一致）。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 独立上传窗口 label。
pub const UPLOAD_WINDOW_LABEL: &str = "upload";

/// Rust -> 前端：待上传队列有新内容。
/// 事件只作为"通知"，真正的数据始终放在 Rust 侧 `PendingUploads` 里，
/// 避免前端 listener 还没注册就丢路径。
pub const EVENT_UPLOAD_PENDING: &str = "notes:upload-pending";

/// Rust -> 前端：上传窗口的目标目录建议发生了变化。
pub const EVENT_UPLOAD_TARGET: &str = "notes:upload-target";

/// `read_file_chunk` 单次允许读取的最大字节数。
/// 前端分片为 5 MiB，这里留出余量并硬性限制，避免前端传入超大 length 撑爆内存。
pub const MAX_CHUNK_SIZE: u64 = 8 * 1024 * 1024;

/// Rust -> 上传窗口：主窗口要退出了，请**暂停**上传并完成清理。
///
/// 注意语义：暂停 ≠ 取消。收到这个事件后前端只做三件事——
/// 持久化 checkpoint、停止调度新分片、有界地等在途分片收尾；
/// **绝不**调用 AbortMultipartUpload，multipart 留待下次启动继续。
pub const EVENT_PREPARE_EXIT: &str = "notes:prepare-exit";

/// 退出前等待上传窗口回报"清理完成"的总超时（毫秒）。
///
/// 超时后无条件退出：OSS 请求慢、上传窗口无响应都不能卡死进程。
/// 这个值必须明显小于前端上传窗口自己的有界等待（UPLOAD_CLEANUP_TIMEOUT_MS），
/// 更要远小于单个 OSS 请求 180 秒的超时——退出时**绝不会**去等一个在途请求。
/// 带着在途分片退出是安全的：那个未被记录的分片下次会用同一个 partNumber 重传。
pub const EXIT_CLEANUP_TIMEOUT_MS: u64 = 5000;

/// 等待退出握手的轮询间隔（毫秒）。
pub const EXIT_POLL_INTERVAL_MS: u64 = 50;

/// 命令行只接受 `--upload <path>` 这一种形式。
pub const UPLOAD_FLAG: &str = "--upload";

/// 应用偏好设置文件。必须与前端 src/config.ts 的 SETTINGS_STORE_FILE 一致。
#[cfg(target_os = "windows")]
pub const SETTINGS_STORE_FILE: &str = "settings.json";

/// 是否允许应用管理 Explorer 右键菜单的偏好 key。
/// 必须与前端 src/config.ts 的 SHELL_INTEGRATION_ENABLED_KEY 一致。
#[cfg(target_os = "windows")]
pub const SHELL_INTEGRATION_ENABLED_KEY: &str = "shellIntegrationEnabled";

/// Windows Explorer 右键 verb 的注册表路径（当前用户级，不需要管理员权限）。
#[cfg(target_os = "windows")]
pub const SHELL_VERB_KEY_PATH: &str = r"Software\Classes\*\shell\NotesUpload";

/// Windows Explorer 右键菜单显示名。
#[cfg(target_os = "windows")]
pub const SHELL_VERB_DISPLAY_NAME: &str = "Upload to Notes";
