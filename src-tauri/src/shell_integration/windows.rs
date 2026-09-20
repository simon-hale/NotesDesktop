//! Windows Explorer 右键集成。
//!
//! 使用**当前用户级** classic Shell Verb，不需要管理员权限，也不修改系统级 HKLM。
//!
//! ```text
//! HKCU\Software\Classes\*\shell\NotesUpload
//!   (默认)            = "Upload to Notes"      REG_SZ
//!   MultiSelectModel  = "Single"               REG_SZ
//!   Icon              = "<当前 exe 绝对路径>"
//! HKCU\Software\Classes\*\shell\NotesUpload\command
//!   (默认)            = "\"<当前 exe 绝对路径>\" --upload \"%1\""   REG_SZ
//! ```
//!
//! 注意：这里**只是写注册表字符串**。应用收到 `%1` 之后把它当普通参数处理，
//! 绝不会把文件路径拼接成 shell 命令去执行。

use std::env;
use std::path::PathBuf;

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winreg::RegKey;

use super::ShellIntegrationStatus;
use crate::commands::files::to_plain_path;
use crate::config;

const PLATFORM: &str = "windows";

/// 当前可执行文件的绝对路径（已去掉 `\\?\` 前缀）。
fn current_exe_path() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|error| format!("无法获取当前可执行文件路径：{error}"))?;
    Ok(to_plain_path(&exe))
}

/// 注册表 command 的值。
///
/// 用双引号包住 exe 路径与 `%1`，这样带空格、中文、Unicode 的路径都能正确传递。
fn command_value(exe: &PathBuf) -> String {
    format!(
        "\"{}\" {} \"%1\"",
        exe.display(),
        config::UPLOAD_FLAG
    )
}

fn command_key_path() -> String {
    format!(r"{}\command", config::SHELL_VERB_KEY_PATH)
}

pub fn install() -> Result<ShellIntegrationStatus, String> {
    let exe = current_exe_path()?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // create_subkey 本身是幂等的：已存在时直接打开。
    let (verb_key, _) = hkcu
        .create_subkey(config::SHELL_VERB_KEY_PATH)
        .map_err(|error| format!("无法创建注册表项 {}：{error}", config::SHELL_VERB_KEY_PATH))?;

    verb_key
        .set_value("", &config::SHELL_VERB_DISPLAY_NAME)
        .map_err(|error| format!("无法写入右键菜单显示名：{error}"))?;

    verb_key
        .set_value("MultiSelectModel", &"Single")
        .map_err(|error| format!("无法写入 MultiSelectModel：{error}"))?;

    let exe_text = exe.to_string_lossy().into_owned();

    verb_key
        .set_value("Icon", &exe_text)
        .map_err(|error| format!("无法写入右键菜单图标：{error}"))?;

    let (command_key, _) = hkcu
        .create_subkey(command_key_path())
        .map_err(|error| format!("无法创建注册表项 {}：{error}", command_key_path()))?;

    let command = command_value(&exe);
    command_key
        .set_value("", &command)
        .map_err(|error| format!("无法写入右键菜单命令：{error}"))?;

    Ok(status())
}

pub fn uninstall() -> Result<ShellIntegrationStatus, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    match hkcu.delete_subkey_all(config::SHELL_VERB_KEY_PATH) {
        Ok(()) => Ok(status()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(status()),
        Err(error) => Err(format!(
            "无法删除注册表项 {}：{error}",
            config::SHELL_VERB_KEY_PATH
        )),
    }
}

pub fn status() -> ShellIntegrationStatus {
    let expected = current_exe_path().map(|exe| command_value(&exe)).ok();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let installed = match hkcu.open_subkey_with_flags(command_key_path(), KEY_READ) {
        Ok(key) => match key.get_value::<String, _>("") {
            // 只有当前注册的命令确实指向本可执行文件时才算"已安装"。
            Ok(value) => expected.as_deref() == Some(value.as_str()),
            Err(_) => false,
        },
        Err(_) => false,
    };

    ShellIntegrationStatus {
        platform: PLATFORM.to_string(),
        supported: true,
        installed,
        location: Some(format!(r"HKCU\{}", config::SHELL_VERB_KEY_PATH)),
        message: if installed {
            "已注册 Explorer 右键菜单：右键单个文件 → 显示更多选项 → Upload to Notes".to_string()
        } else {
            "尚未注册 Explorer 右键菜单，可点击按钮注册（无需管理员权限）".to_string()
        },
    }
}
