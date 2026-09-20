/**
 * 前端统一配置入口。
 *
 * 这是整个前端**唯一**读取环境变量的地方：真实后端地址只存在于 .env.local，
 * 业务代码（.vue / .ts）里不允许出现任何硬编码域名。
 *
 * 注意：VITE_* 会进入客户端构建产物，因此这里只用于环境隔离，
 * 绝不能存放密码、JWT、AccessKey、STS 凭证等任何 secret。
 */

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '')

/** Notes 后端根地址，例如 https://notes.example.com（不含结尾斜杠）。 */
export const API_BASE_URL = trimTrailingSlashes(
  (import.meta.env.VITE_API_BASE_URL ?? '').trim()
)

/** 未配置后端地址时给出的可操作提示。 */
export const CONFIG_ERROR_MESSAGE = API_BASE_URL
  ? ''
  : '未配置后端地址：请在项目根目录创建 .env.local，并设置 VITE_API_BASE_URL（可参考 .env.example）。'

/** 后端统一使用的语言参数。 */
export const API_LANGUAGE = 'zh-CN'

/** 登录信息的持久化文件（Tauri Store，只做持久化，不是密钥链）。 */
export const AUTH_STORE_FILE = 'auth.json'

/**
 * 应用偏好设置的持久化文件。
 * Rust 侧启动时也会读它（见 src-tauri/src/config.rs），文件名不可随意更改。
 */
export const SETTINGS_STORE_FILE = 'settings.json'

/**
 * 是否允许应用管理 Windows Explorer 右键菜单。
 * 缺省视为 true（装好即注册）；用户关闭后写入 false，启动时不再触碰注册表。
 */
export const SHELL_INTEGRATION_ENABLED_KEY = 'shellIntegrationEnabled'

// ---- OSS 上传参数（与现有 NotesFrontend 的 ossUpload.async.js 保持一致）----

/** 每个分片 5 MiB。 */
export const PART_SIZE = 5 * 1024 * 1024

/** 单文件内部最多 3 个分片并行。 */
export const PART_PARALLEL = 3

/** 单个 OSS 请求超时 180 秒。 */
export const OSS_TIMEOUT_MS = 180 * 1000

/** 失败分片最多额外重试 2 次（合计最多 3 次尝试）。 */
export const OSS_MAX_RETRY = 2

/** 重试等待基数：500ms、1000ms。 */
export const OSS_RETRY_BASE_DELAY_MS = 500

/** OSS 阶段进度最多显示到 99%，数据库 insert 成功后才到 100%。 */
export const OSS_PROGRESS_CAP = 0.99

/** STS 用途。 */
export const STS_USAGE_SINGLE_FILE_UPLOAD = 'SINGLE_FILE_UPLOAD'

/**
 * 关闭上传窗口 / 退出应用时，等待"取消上传 + abort multipart + 状态清理"完成的
 * 有界上限（毫秒）。必须明显小于 Rust 侧 config::EXIT_CLEANUP_TIMEOUT_MS 的兜底超时。
 *
 * 超时**不代表**上传已经停止：此时界面要保持可见并显示"正在取消"，
 * 后台继续等待真正 idle，绝不能假装已经停下来了。
 */
export const UPLOAD_CLEANUP_TIMEOUT_MS = 3000
