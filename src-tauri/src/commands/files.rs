//! 本地文件访问命令。
//!
//! 右键菜单 / 文件选择对话框给应用的是**绝对路径**，不是浏览器 File 对象，
//! 所以这里只做两件事：
//!   - `stat_local_file`：确认路径存在、是普通文件，返回文件名 / 大小 / mtime / 规范路径；
//!   - `read_file_chunk`：按 offset/length 读一个分片，用 raw IPC 返回原始字节，
//!     并在需要时校验"本地文件在上传期间没有被改动"。
//!
//! 关键约束：
//!   - 绝不 `std::fs::read` 整个大文件；
//!   - 绝不维护常驻的 FileHandle Map；
//!   - 每次调用都是 打开 -> 校验 -> seek -> 读取 -> 再次校验 -> 函数结束 RAII 关闭；
//!   - **不做全文件哈希**：那等于给每个大文件额外加一次完整读取，
//!     对个人客户端来说 (size, mtime) 这组元数据已经足够识别"文件被换掉了"。

use std::fs::File;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::config::MAX_CHUNK_SIZE;

/// 本地文件在上传过程中被截断 / 替换时返回的错误。
///
/// 前端把它当作**不可重试**的业务错误：文件本身变了，重试同一个分片没有意义。
/// 续传场景下它会触发"丢弃旧 checkpoint + 重新上传"，绝不会把新旧内容混在一起。
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
    /// 最后修改时间（epoch 毫秒）；0 表示当前文件系统不提供该信息。
    pub modified_at_ms: i64,
}

/// 把 `SystemTime` 转成 epoch 毫秒。
///
/// 早于 UNIX 纪元 / 超出 i64 的极端值统一返回 0（＝"未知"），
/// 调用方据此退化为"只比对大小"，而不是把一个错误的负数当成有效 mtime。
fn to_epoch_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(0),
        Err(_) => 0,
    }
}

/// 读取文件 metadata 的 mtime（失败时返回 0）。
fn modified_at_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata.modified().map(to_epoch_ms).unwrap_or(0)
}

/// 去 Windows `canonicalize` 产生的 `\\?\` / `\\?\UNC\` 前缀。
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
        modified_at_ms: modified_at_ms(&metadata),
    })
}

/// 校验"打开的文件"是否仍与前端持有的源快照一致。
///
/// - `expected_size == None` 表示调用方不关心大小；
/// - `expected_modified_at_ms` 为 `None` 或 `Some(0)` 表示不校验 mtime
///   （0 ＝ 当前文件系统不提供 mtime）。
fn ensure_matches_snapshot(
    size: u64,
    mod_ms: i64,
    expected_size: Option<u64>,
    expected_modified_at_ms: Option<i64>,
) -> Result<(), String> {
    if let Some(expected) = expected_size {
        if size != expected {
            return Err(LOCAL_FILE_CHANGED_ERROR.to_string());
        }
    }

    if let Some(expected) = expected_modified_at_ms {
        if expected != 0 && mod_ms != 0 && mod_ms != expected {
            return Err(LOCAL_FILE_CHANGED_ERROR.to_string());
        }
    }

    Ok(())
}

/// 读取本地文件的一个分片，直接以原始二进制通过 IPC 返回。
///
/// 返回 `tauri::ipc::Response` 时，前端 `invoke` 拿到的是 ArrayBuffer，
/// 全程不做 base64、不做 JSON 序列化、不构造整个文件的 Blob。
///
/// `expected_size` / `expected_modified_at_ms` 是**可选**的源快照：
/// 续传场景下前端一定会传，这里是"上传进行中文件被改动"的最后一道防线。
/// 校验发生在读取前后各一次——只在读取前校验是不够的：
/// 文件完全可能在 seek 与 read 之间被追加或被原地覆盖。
#[tauri::command]
pub fn read_file_chunk(
    path: String,
    offset: u64,
    length: u64,
    expected_size: Option<u64>,
    expected_modified_at_ms: Option<i64>,
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

    let mut file = File::open(&path).map_err(|error| format!("无法打开文件：{error}"))?;

    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取文件信息：{error}"))?;

    if !metadata.is_file() {
        return Err("目标路径不是普通文件".to_string());
    }

    let file_size = metadata.len();
    let file_mod_ms = modified_at_ms(&metadata);

    // ① 读取前：文件必须仍然是发起上传时那个文件。
    ensure_matches_snapshot(
        file_size,
        file_mod_ms,
        expected_size,
        expected_modified_at_ms,
    )?;

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

    // ② 读取后：按**路径**再取一次 metadata。
    //
    // 刻意不用打开时那个句柄：Windows 上"删除 + 重建"之后，旧句柄仍然指向
    // 已经被删除的那个文件，句柄上的 mtime 不会变，只有按路径重新查询才能
    // 发现文件已经被换掉了。
    let after = std::fs::metadata(&path).map_err(|error| format!("无法读取文件信息：{error}"))?;

    ensure_matches_snapshot(
        after.len(),
        modified_at_ms(&after),
        expected_size,
        expected_modified_at_ms,
    )?;

    Ok(tauri::ipc::Response::new(buffer))
}

