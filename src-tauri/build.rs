//! 构建脚本。
//!
//! 职责：
//!   1. 读取 `capabilities/default.json.example`（提交在仓库里的权限模板），
//!      把 `http:default` 的允许域名替换成 `VITE_API_BASE_URL` 的取值，
//!      写出 `capabilities/default.json`（已被 .gitignore 忽略）。
//!      取值优先级：**进程环境变量 > .env.local > .env > 占位域名**，
//!      因此 CI 可以直接注入变量而不需要往磁盘写任何文件；
//!   2. 调用 `tauri_build::build()`（校验 tauri.conf.json、生成 gen/schemas 与 ACL 清单）。
//!
//! 为什么放在 build.rs 而不是单独的 npm 脚本：
//!   权限清单是**编译期**被读进二进制的。如果只靠 npm 脚本生成，
//!   直接 `cargo build` 就会拿到仓库里的占位域名，做出一个
//!   "前端地址正确、HTTP 却被 ACL 拦死"的静默故障程序。
//!   放在这里可以保证任何构建方式拿到的都是最新配置。
//!
//! 注意：只有内容真的变化时才写盘，避免 mtime 抖动引发重复编译。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// 没有任何来源提供 `VITE_API_BASE_URL` 时使用的占位域名。
/// 此时前端同样会因为缺少 VITE_API_BASE_URL 而提示配置错误，两边行为一致。
const PLACEHOLDER_API_BASE_URL: &str = "https://your-notes-backend.example.com";

fn main() {
    // fail closed：权限清单是编译期固化进二进制的东西，
    // 生成失败必须让构建直接失败，绝不能带着缺失/过期的清单继续编译。
    if let Err(error) = sync_capability_from_env() {
        panic!("Notes Desktop: 无法生成 capabilities/default.json：{error}");
    }

    tauri_build::build()
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// src-tauri 的上一级就是前端工程根目录。
fn project_root() -> PathBuf {
    manifest_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn template_path() -> PathBuf {
    manifest_dir().join("capabilities/default.json.example")
}

fn capability_path() -> PathBuf {
    manifest_dir().join("capabilities/default.json")
}

/// 极简 dotenv 解析：KEY=VALUE，支持 # 注释和成对引号。
fn read_env_file(path: &Path) -> Vec<(String, String)> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };

    text.lines()
        .filter_map(|line| {
            let line = line.trim();

            if line.is_empty() || line.starts_with('#') {
                return None;
            }

            let (key, raw_value) = line.split_once('=')?;
            let key = key.trim();
            let mut value = raw_value.trim();

            if value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\'')))
            {
                value = &value[1..value.len() - 1];
            }

            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

/// 读取 `VITE_API_BASE_URL`，优先级：
///
/// ```text
/// 1. 进程环境变量          —— CI / 打包机直接注入，不需要往磁盘写文件
/// 2. <项目根>/.env.local   —— 本地开发（.gitignore 忽略）
/// 3. <项目根>/.env
/// 4. 占位域名              —— 什么都没配置时使用
/// ```
///
/// 返回已经去掉结尾斜杠的地址；**显式配置了但非法**的值直接报错让构建失败，
/// 而不是静默退回占位域名（那会做出一个 HTTP 被 ACL 拦死的程序）。
fn resolve_api_base_url(root: &Path) -> Result<String, String> {
    // 环境变量变了要重新跑本脚本（否则改了 CI 变量也不会重新生成权限清单）。
    println!("cargo:rerun-if-env-changed=VITE_API_BASE_URL");

    // ① 进程环境变量优先。
    if let Ok(value) = std::env::var("VITE_API_BASE_URL") {
        if !value.trim().is_empty() {
            return normalize_api_base_url(&value, "进程环境变量");
        }
    }

    // ② / ③ 依次回退到 .env.local、.env。
    for file_name in [".env.local", ".env"] {
        let path = root.join(file_name);

        // 配置文件变了要重新跑本脚本。
        println!("cargo:rerun-if-changed={}", path.display());

        for (key, value) in read_env_file(&path) {
            if key != "VITE_API_BASE_URL" || value.trim().is_empty() {
                continue;
            }

            return normalize_api_base_url(&value, file_name);
        }
    }

    // ④ 没有任何来源：使用占位域名（此时前端也会提示缺少配置，两边行为一致）。
    Ok(PLACEHOLDER_API_BASE_URL.to_string())
}

/// 规范化单个来源的取值：去空格、去结尾斜杠，并校验基本合法性。
fn normalize_api_base_url(raw: &str, source: &str) -> Result<String, String> {
    let value = raw.trim().trim_end_matches('/');

    if value.is_empty() {
        return Err(format!("{source} 中的 VITE_API_BASE_URL 为空"));
    }

    if !value.starts_with("http://") && !value.starts_with("https://") {
        return Err(format!(
            "{source} 中的 VITE_API_BASE_URL 必须以 http:// 或 https:// 开头：{value}"
        ));
    }
    // 该值会被拼进 JSON，拒绝引号与反斜杠。
    if value.contains('"') || value.contains('\\') {
        return Err(format!(
            "{source} 中的 VITE_API_BASE_URL 含有非法字符（引号或反斜杠）：{value}"
        ));
    }

    Ok(value.to_string())
}

/// 用给定的后端地址替换模板里 `http:default` 的允许域名，并写上"生成物"说明。
fn render_capability(template: &str, api_base_url: &str) -> Result<String, String> {
    let mut capability: Value = serde_json::from_str(template)
        .map_err(|error| format!("default.json.example 不是合法 JSON：{error}"))?;

    capability["description"] = json!(format!(
        "Notes Desktop 运行时权限清单：由 src-tauri/build.rs 依据 VITE_API_BASE_URL（进程环境变量 > .env.local > .env）生成，请勿手工修改。HTTP 权限仅放行 {api_base_url}。"
    ));

    let permissions = capability
        .get_mut("permissions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "default.json.example 缺少 permissions 数组".to_string())?;

    let mut patched = false;

    for entry in permissions.iter_mut() {
        if entry.get("identifier").and_then(Value::as_str) == Some("http:default") {
            entry["allow"] = json!([{ "url": format!("{api_base_url}/*") }]);
            patched = true;
        }
    }

    if !patched {
        return Err("default.json.example 中没有找到 http:default 权限条目".to_string());
    }

    serde_json::to_string_pretty(&capability)
        .map(|text| format!("{text}\n"))
        .map_err(|error| format!("序列化权限清单失败：{error}"))
}

/// 生成 `capabilities/default.json`。
///
/// **任何一步失败都返回 `Err`**，由 `main()` 直接 panic 让构建失败：
/// 读不到模板、JSON 非法、找不到 `http:default` 条目、写不出去，
/// 都属于"权限清单会缺失或过期"的情况，不能静默继续编译。
fn sync_capability_from_env() -> Result<(), String> {
    let template_file = template_path();
    println!("cargo:rerun-if-changed={}", template_file.display());

    let template = fs::read_to_string(&template_file)
        .map_err(|error| format!("无法读取权限模板 {}：{error}", template_file.display()))?;

    let api_base_url = resolve_api_base_url(&project_root())?;

    let generated = render_capability(&template, &api_base_url)?;

    let target = capability_path();

    // 内容没变就不写盘，避免 mtime 抖动引发重复编译。
    if fs::read_to_string(&target).is_ok_and(|current| current == generated) {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}：{error}", parent.display()))?;
    }

    fs::write(&target, generated)
        .map_err(|error| format!("无法写入 {}：{error}", target.display()))?;

    println!(
        "cargo:warning=Notes Desktop: 已生成 capabilities/default.json，HTTP 权限作用域为 {api_base_url}/*"
    );

    Ok(())
}
