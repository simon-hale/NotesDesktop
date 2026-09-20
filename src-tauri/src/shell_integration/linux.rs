//! Linux 文件管理器右键集成（V1 未实现）。
//!
//! 各桌面环境（GNOME / KDE / XFCE）的扩展机制完全不同，
//! 常见做法是安装 `~/.local/share/file-manager/actions/*.desktop`，
//! V1 只保留模块边界，返回 Unsupported，不影响编译与主页上传。

use super::ShellIntegrationStatus;

const PLATFORM: &str = "linux";

const MESSAGE: &str =
    "V1 暂未实现 Linux 文件管理器右键集成；主页上传与上传窗口不受影响。";

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
