//! macOS Finder 右键集成（V1 未实现）。
//!
//! 真正实现需要 Finder Sync Extension（App Extension + 宿主 App 签名），
//! 属于独立工程，V1 只保留模块边界，返回 Unsupported，不影响编译与主页上传。

use super::ShellIntegrationStatus;

const PLATFORM: &str = "macos";

const MESSAGE: &str = "V1 暂未实现 macOS Finder 右键集成；主页上传与上传窗口不受影响。";

pub fn install() -> Result<ShellIntegrationStatus, String> {
    Ok(status())
}

pub fn uninstall() -> Result<ShellIntegrationStatus, String> {
    Ok(status())
}

pub fn status() -> ShellIntegrationStatus {
    ShellIntegrationStatus {
        platform: PLATFORM.to_string(),
        supported: false,
        installed: false,
        location: None,
        message: MESSAGE.to_string(),
    }
}
