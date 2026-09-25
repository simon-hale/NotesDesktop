/** 云端目录（后端 /api/directory/* 返回的 directories[] 元素）。 */
export interface DirectoryItem {
  id: number
  name: string
}

/** 云端文件（后端 /api/directory/* 返回的 files[] 元素）。 */
export interface FileItem {
  id: number
  name: string
  type?: string
  creation_time?: string
  last_modified_time?: string
}

/** 面包屑 / 目标目录的一段。 */
export interface Breadcrumb {
  id: number
  name: string
}

/** 后端统一的错误字段。 */
export interface ApiMessage {
  error_message?: string
  warning_message?: string
}

/** /api/directory/id/ 响应。 */
export interface DirectoryListing extends ApiMessage {
  directories?: DirectoryItem[]
  files?: FileItem[]
}

/** /api/directory/init/ 响应。 */
export interface RootListing extends DirectoryListing {
  root_id?: number
}

/** /api/oss/sts/ 响应。 */
export interface StsResponse extends ApiMessage {
  region?: string
  bucket?: string
  accessKeyId?: string
  accessKeySecret?: string
  securityToken?: string
  objectKey?: string
  /**
   * STS 的**绝对**过期时间（后端新增字段）。
   *
   * 可能是 ISO-8601（`2024-01-01T00:00:00Z`），也可能是 epoch 秒 / 毫秒，
   * 具体解析见 api.ts 的 `parseStsExpirationMs`。缺省时退回 900 秒兜底寿命。
   */
  expiration?: string | number
}

/** STS 申请结果（已做校验）。 */
export interface UploadTicket {
  region: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  objectKey: string
  /** STS 绝对过期时间（epoch 毫秒），用于"是否接近过期"的判断。 */
  expirationMs: number
  /** true 表示后端返回 same_file_name：同目录同名，走覆盖语义。 */
  overwrite: boolean
}

/** Rust `stat_local_file` 返回值。 */
export interface LocalFileInfo {
  name: string
  size: number
  path: string
  /**
   * 文件最后修改时间（epoch 毫秒）。
   *
   * 0 表示当前文件系统无法提供该信息；此时"本地文件是否被改动"的检查
   * 退化为只比对大小。epoch 毫秒在 JS Number 里可以精确表示（< 2^53）。
   */
  modifiedAtMs: number
}

/** Rust `queue_upload_paths` 返回值。 */
export interface QueueUploadResult {
  added: number
  total: number
  rejected: string[]
}

/** Rust 侧的目标云目录建议：必须是完整面包屑（root 到当前目录）。 */
export interface UploadTargetHint {
  breadcrumbs: Breadcrumb[]
}

/** Rust `shell_integration_status` 返回值。 */
export interface ShellIntegrationStatus {
  platform: string
  supported: boolean
  installed: boolean
  location: string | null
  message: string
}

/**
 * 上传任务的可见状态。
 *
 * 与持久化 phase 的对应关系（见 upload-checkpoints.ts）：
 *   - `uploading`        ↔ `TRANSFERRING`
 *   - `pausing`          ↔ `TRANSFERRING`（瞬时 UX 状态，不落盘）
 *   - `paused`           ↔ `PAUSED`
 *   - `metadata_pending` ↔ `METADATA_PENDING`
 * 其余是纯内存态（`pending` / `success` / `canceled`），`error` 是可恢复失败。
 */
export type UploadStatus =
  | 'pending'
  | 'uploading'
  /** 瞬时：已经请求暂停，还有在途分片。 */
  | 'pausing'
  | 'paused'
  /** OSS 对象已经完整存在，只差 /api/file/insert/。 */
  | 'metadata_pending'
  | 'success'
  /** 可恢复的失败：checkpoint 与 multipart 都保留着，可以继续。 */
  | 'error'
  | 'canceled'

/** 上传窗口中的单个本地文件任务。 */
export interface UploadTask {
  /**
   * 任务 id。
   *
   * 它同时就是 checkpoint 里的 `transferId`：**进程重启后必须保持同一个值**，
   * 否则恢复出来的任务既找不到自己的 uploadId，也找不到已完成分片。
   */
  id: string
  /** 本地绝对路径（上传开始时 stat 到的规范路径）。 */
  path: string
  name: string
  size: number
  /** 文件最后修改时间（epoch 毫秒），与 size 一起构成"本地源身份"。 */
  modifiedAtMs: number
  /**
   * 创建这个任务的账号名。
   *
   * 会话切换时靠它判断"哪些恢复任务还属于当前账号"。
   * **只记账号名，绝不记 JWT**——重试时一律使用当时最新的访问令牌。
   */
  ownerUsername: string
  status: UploadStatus
  /** 0 ~ 1；OSS 阶段最多 OSS_PROGRESS_CAP，insert 成功后才到 1。 */
  progress: number
  /** 失败原因 / 覆盖提示等。 */
  message: string
  /** 后端返回 same_file_name 时的覆盖标记。 */
  overwrite: boolean
  /**
   * OSS 对象是否已经完整上传成功。
   * 为 true 时再次重试只会补写数据库（/api/file/insert/），不会重新上传整个文件。
   */
  objectUploaded: boolean
  /**
   * 冻结的目标云目录 string_of_path（任务开始上传时确定，之后**绝不再变**）。
   *
   * STS 刷新、multipart 操作、/api/file/insert/ 全部使用这一份快照，
   * 不再读 `uploadState.target`——用户在上传过程中改了目标目录也不会影响它。
   */
  targetStringOfPath: string
  /** 冻结的目标父目录 ID。 */
  targetParentId: number
  /** 冻结的目标文件名（＝OSS objectKey 与 insert 用的文件名）。 */
  targetFilename: string
}
