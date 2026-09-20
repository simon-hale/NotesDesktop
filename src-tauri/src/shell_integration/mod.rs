//! 文件管理器右键集成（按平台隔离）。
//!
//! Tauri 本身没有统一的三平台"文件管理器右键菜单"API，所以这里把平台代码彻底隔离开：
//!   - `windows.rs`：当前用户级 classic Shell Verb（HKCU），不需要管理员权限，V1 真正实现；
//!   - `macos.rs` / `linux.rs`：V1 返回 Unsupported / No-op，只保留模块边界，
//!     不影响整个应用在三平台的编译，也不影响主页上传功能。
//!
//! Windows 11 上该 classic verb 会出现在"显示更多选项"里，这是 V1 接受的形态；
//! 不实现 COM `IExplorerCommand` / DLL / sparse package。

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(all(unix, not(target_os = "macos")))]
mod linux;

#[cfg(target_os = "windows")]
use self::windows as platform;

#[cfg(target_os = "macos")]
use self::macos as platform;

#[cfg(all(unix, not(target_os = "macos")))]
use self::linux as platform;

use serde::Serialize;

/// 右键集成的状态，回传给前端展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellIntegrationStatus {
    /// 平台标识：windows / macos / linux。
    pub platform: String,
    /// 该平台 V1 是否支持。
    pub supported: bool,
    /// 是否已经注册（且指向当前可执行文件）。
    pub installed: bool,
    /// 注册位置描述（Windows 上是注册表路径）。
    pub location: Option<String>,
    /// 面向用户的说明。
    pub message: String,
}

/// 注册右键菜单。幂等：重复调用只会把 executable path / 显示名刷新到最新值。
pub fn install() -> Result<ShellIntegrationStatus, String> {
    platform::install()
}

/// 卸载右键菜单（主要给 Windows 用）。
pub fn uninstall() -> Result<ShellIntegrationStatus, String> {
    platform::uninstall()
}

/// 查询当前状态。
pub fn status() -> ShellIntegrationStatus {
    platform::status()
}

/// 读取用户偏好：是否允许应用管理 Explorer 右键菜单。
///
/// 默认 `true`，即保持"装好即注册"的既有行为；
/// 用户在界面上关掉之后会写入 `false`，之后启动就完全不再触碰注册表。
///
/// 仅 Windows 使用，非 Windows 平台不编译这段代码。
#[cfg(target_os = "windows")]
pub fn is_enabled<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri_plugin_store::StoreExt;

    match app.store(crate::config::SETTINGS_STORE_FILE) {
        Ok(store) => store
            .get(crate::config::SHELL_INTEGRATION_ENABLED_KEY)
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
        // 读不到偏好（首次运行 / 文件损坏）时按默认值处理。
        Err(_) => true,
    }
}

/// 前端命令：注册。
#[tauri::command]
pub fn install_shell_integration() -> Result<ShellIntegrationStatus, String> {
    install()
}

/// 前端命令：卸载。
#[tauri::command]
pub fn uninstall_shell_integration() -> Result<ShellIntegrationStatus, String> {
    uninstall()
}

/// 前端命令：查询状态。
#[tauri::command]
pub fn shell_integration_status() -> ShellIntegrationStatus {
    status()
}
