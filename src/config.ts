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

// ---- 断点续传 checkpoint（与 auth.json / settings.json 严格分开）----

/**
 * 上传断点续传记录的持久化文件。
 *
 * **绝不能**放进 auth.json：登录信息与传输状态的生命周期完全不同，
 * 而且 checkpoint 里连一个凭据字段都不允许出现（见 upload-checkpoints.ts 的说明）。
 */
export const UPLOAD_CHECKPOINT_STORE_FILE = 'upload-checkpoints.json'

/** checkpoint 存储 key：整个文件只用一个 key，值是 transferId -> 记录 的映射。 */
export const UPLOAD_CHECKPOINT_STORE_KEY = 'uploadCheckpoints'

/**
 * checkpoint schema 版本号。
 *
 * 读取时版本不匹配的记录一律**丢弃**（而不是猜测字段含义）：
 * 丢掉一个旧记录只会让那个文件重新上传一遍；错误地解释它则可能
 * 用一份不完整的 ETag 列表去 Complete，合成出损坏的对象。
 *
 * 版本历史：
 *   1 → 2：checkpoint 增加完整的 OSS 范围（bucket / region），
 *          使续传时能校验刷新回来的 STS 凭证仍属于同一个存储空间，
 *          而不是只比对 objectKey。项目尚未发布，v1 记录直接作废
 *          （不做有风险的半迁移）；它们残留的远端分片由 OSS 生命周期规则回收。
 */
export const UPLOAD_CHECKPOINT_SCHEMA_VERSION = 2

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
 * STS 过期安全余量。
 *
 * 距离过期不足这个时间就先刷新凭证，避免"请求发出时还有 3 秒、到达 OSS 时已经过期"
 * 这种必然失败的边界情况。后端 STS 寿命固定 900 秒，60 秒余量足够宽裕。
 */
export const STS_REFRESH_SAFETY_MARGIN_MS = 60 * 1000

/**
 * 后端没有返回可解析的 `expiration` 时的兜底寿命（毫秒）。
 * 与后端 STS 的 900 秒一致，宁可提前刷新也不要用过期的凭证发请求。
 */
export const STS_FALLBACK_LIFETIME_MS = 900 * 1000

/**
 * 关闭上传窗口 / 退出应用时，等待"暂停上传 + 持久化 checkpoint + 收尾"完成的
 * 有界上限（毫秒）。必须明显小于 Rust 侧 config::EXIT_CLEANUP_TIMEOUT_MS 的兜底超时。
 *
 * 超时**不代表**上传已经停止，也**不等于**取消：此时 checkpoint 已经落盘，
 * 进程带着在途的分片请求退出也是安全的——那个未被记录的服务端分片，
 * 下次 Resume 时用同一个 partNumber 重传即可（要求 9）。
 */
export const UPLOAD_CLEANUP_TIMEOUT_MS = 3000
