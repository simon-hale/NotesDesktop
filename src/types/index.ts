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
}

/** STS 申请结果（已做校验）。 */
export interface UploadTicket {
  region: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  objectKey: string
  /** true 表示后端返回 same_file_name：同目录同名，走覆盖语义。 */
  overwrite: boolean
}

/** Rust `stat_local_file` 返回值。 */
export interface LocalFileInfo {
  name: string
  size: number
  path: string
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

export type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'success'
  | 'error'
  | 'canceled'

/** 上传窗口中的单个本地文件任务。 */
export interface UploadTask {
  id: string
  /** 本地绝对路径。 */
  path: string
  name: string
  size: number
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
  /** objectUploaded 为 true 时，对象所在的 string_of_path（上传成功时的快照）。 */
  uploadedPath: string
  /** objectUploaded 为 true 时，对象所属的父目录 ID（上传成功时的快照）。 */
  uploadedParentId: number
  /** objectUploaded 为 true 时，对象对应的文件名（上传成功时的快照）。 */
  uploadedFilename: string
}
