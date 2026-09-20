//! 本地文件访问命令。
//!
//! 右键菜单 / 文件选择对话框给应用的是**绝对路径**，不是浏览器 File 对象，
//! 所以这里只做两件事：
//!   - `stat_local_file`：确认路径存在、是普通文件，返回文件名 / 大小 / 规范路径；
//!   - `read_file_chunk`：按 offset/length 读一个分片，用 raw IPC 返回原始字节。
//!
//! 关键约束：
//!   - 绝不 `std::fs::read` 整个大文件；
//!   - 绝不维护常驻的 FileHandle Map；
//!   - 每次调用都是 打开 -> seek -> 读取 -> 函数结束 RAII 关闭。

use std::fs::File;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::MAX_CHUNK_SIZE;

/// 本地文件在上传过程中被截断 / 替换时返回的错误。
///
/// 前端把它当作**不可重试**的业务错误：文件本身变了，重试同一个分片没有意义。
const LOCAL_FILE_CHANGED_ERROR: &str = "The local file changed during upload; please retry.";

/// `stat_local_file` 的返回值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileInfo {
    /// 文件名（不含目录），用于 OSS objectKey 和 /api/file/insert/。
    pub name: String,
    /// 文件字节数。
    pub size: u64,
    /// 规范化后的绝对路径，供后续 read_file_chunk 使用。
    pub path: String,
}

/// 去掉 Windows `canonicalize` 产生的 `\\?\` / `\\?\UNC\` 前缀。
///
/// 保留 verbatim 前缀会让展示出来的路径很别扭（`\\?\C:\...`），
/// 也不适合直接作为注册表 command 参数，所以统一转成普通路径形式。
/// 其它平台原样返回。
pub(crate) fn to_plain_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let text = path.to_string_lossy();

        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }

        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }

    path.to_path_buf()
}

/// 读取本地文件的元信息。
///
/// 只接受真实存在的**普通文件**；目录、符号链接指向的目录、不存在的路径一律报错。
#[tauri::command]
pub fn stat_local_file(path: String) -> Result<LocalFileInfo, String> {
    if path.trim().is_empty() {
        return Err("文件路径不能为空".to_string());
    }

    let raw_path = PathBuf::from(&path);

    let metadata =
        std::fs::metadata(&raw_path).map_err(|error| format!("无法读取文件信息：{error}"))?;

    if !metadata.is_file() {
        return Err("目标路径不是普通文件".to_string());
    }

    let canonical = std::fs::canonicalize(&raw_path)
        .map_err(|error| format!("无法解析文件的绝对路径：{error}"))?;

    let plain = to_plain_path(&canonical);

    let name = plain
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法获取文件名".to_string())?
        .to_string();

    if name.is_empty() {
        return Err("无法获取文件名".to_string());
    }

    Ok(LocalFileInfo {
        name,
        size: metadata.len(),
        path: plain.to_string_lossy().into_owned(),
    })
}

/// 读取本地文件的一个分片，直接以原始二进制通过 IPC 返回。
///
/// 返回 `tauri::ipc::Response` 时，前端 `invoke` 拿到的是 ArrayBuffer，
/// 全程不做 base64、不做 JSON 序列化、不构造整个文件的 Blob。
#[tauri::command]
pub fn read_file_chunk(
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    if length == 0 {
        return Err("读取长度必须大于 0".to_string());
    }

    // 硬性限制单次读取量，防止前端传入超大 length。
    if length > MAX_CHUNK_SIZE {
        return Err(format!(
            "单次读取长度不能超过 {MAX_CHUNK_SIZE} 字节，当前为 {length} 字节"
        ));
    }

    // 只读打开：函数返回时 file 会被 RAII 立即关闭，不留下任何句柄。
    let mut file = File::open(&path).map_err(|error| format!("无法打开文件：{error}"))?;

    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取文件信息：{error}"))?;

    if !metadata.is_file() {
        return Err("目标路径不是普通文件".to_string());
    }

    let file_size = metadata.len();

    if offset > file_size {
        return Err("读取偏移已超出文件大小".to_string());
    }

    // 调用方传进来的 length 已经是 min(PART_SIZE, 它 stat 到的大小 - offset)，
    // 所以正常情况下 offset + length 一定落在文件内。
    let end = offset
        .checked_add(length)
        .ok_or_else(|| "读取范围溢出".to_string())?;

    // 越界说明文件在上传过程中被截断 / 替换。
    // 绝不能返回一个"悄悄变短"的分片：那会让 OSS 合成出损坏的对象，
    // 而且前端会以为这个分片是完整的。
    if end > file_size {
        return Err(LOCAL_FILE_CHANGED_ERROR.to_string());
    }

    let wanted = length as usize;

    let mut buffer = vec![0u8; wanted];

    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("移动文件读取位置失败：{error}"))?;

    let mut filled = 0usize;
    while filled < wanted {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(ref error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("读取文件失败：{error}")),
        }
    }

    // 已经确认范围在文件内，却没有读满：文件在读取过程中仍在变化。
    if filled != wanted {
        return Err(LOCAL_FILE_CHANGED_ERROR.to_string());
    }

    Ok(tauri::ipc::Response::new(buffer))
}
