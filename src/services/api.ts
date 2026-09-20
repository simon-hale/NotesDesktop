/**
 * Notes 后端 HTTP 封装。
 *
 * 约定（与现有 NotesFrontend 完全一致）：
 *   - 全部 POST，表单编码 application/x-www-form-urlencoded;charset=UTF-8；
 *   - 统一带 language=zh-CN；
 *   - 受保护接口带 Authorization: Bearer <JWT>；
 *   - 使用 @tauri-apps/plugin-http 的 fetch（请求在 Rust 侧发出，不受 WebView CORS 限制），
 *     不使用 jQuery。
 *
 * JWT 只出现在这里构造的 Authorization 头里：不打印日志、不拼 URL、不发给 OSS。
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import {
  API_BASE_URL,
  API_LANGUAGE,
  CONFIG_ERROR_MESSAGE,
  STS_USAGE_SINGLE_FILE_UPLOAD
} from '../config'
import type {
  ApiMessage,
  Breadcrumb,
  DirectoryItem,
  DirectoryListing,
  FileItem,
  RootListing,
  StsResponse,
  UploadTicket
} from '../types'

export type ApiErrorKind =
  | 'config'
  | 'network'
  | 'http'
  | 'business'
  | 'aborted'
  | 'parse'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number

  constructor(message: string, kind: ApiErrorKind, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

/** 请求被主动取消（切换目录 / 关闭窗口），调用方应静默忽略。 */
export const isAbortedError = (error: unknown): boolean =>
  error instanceof ApiError && error.kind === 'aborted'

/** 明确的认证失败：401 / 403 才算，普通断网/超时不算。 */
export const isAuthFailure = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.kind === 'http' &&
  (error.status === 401 || error.status === 403)

const HTTP_STATUS_MESSAGES: Record<number, string> = {
  400: '请求参数有误（400）',
  401: '登录状态已失效，请重新登录（401）',
  403: '没有权限或登录已失效（403）',
  404: '接口不存在（404）',
  500: '服务器内部错误（500）'
}

export const httpStatusMessage = (status: number): string =>
  HTTP_STATUS_MESSAGES[status] ?? `请求失败（HTTP ${status}）`

const describeTransportError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)

  if (/not allowed|url not allowed|scope|capability/i.test(text)) {
    return `请求被 Tauri 权限拦截：${text}。请确认 .env.local 中的 VITE_API_BASE_URL 与 src-tauri/capabilities/default.json 中的 http 作用域一致。`
  }

  if (/timeout|timed out|deadline/i.test(text)) {
    return '请求超时，请检查网络后重试。'
  }

  return `网络请求失败：${text}`
}

interface FormRequest {
  path: string
  form: Record<string, string | number>
  token?: string
  signal?: AbortSignal
}

const buildFormBody = (form: Record<string, string | number>): string => {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(form)) {
    params.append(key, String(value))
  }

  // 统一使用 zh-CN。
  if (!params.has('language')) {
    params.append('language', API_LANGUAGE)
  }

  return params.toString()
}

/** 表单 POST 的统一入口。 */
export async function postForm<T extends ApiMessage>(
  request: FormRequest
): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiError(CONFIG_ERROR_MESSAGE, 'config')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
  }

  if (request.token) {
    headers.Authorization = `Bearer ${request.token}`
  }

  let response: Awaited<ReturnType<typeof tauriFetch>>

  try {
    response = await tauriFetch(`${API_BASE_URL}${request.path}`, {
      method: 'POST',
      headers,
      body: buildFormBody(request.form),
      signal: request.signal
    })
  } catch (error) {
    if (request.signal?.aborted) {
      throw new ApiError('请求已取消', 'aborted')
    }

    throw new ApiError(describeTransportError(error), 'network')
  }

  if (!response.ok) {
    throw new ApiError(httpStatusMessage(response.status), 'http', response.status)
  }

  let payload: unknown

  try {
    payload = await response.json()
  } catch {
    throw new ApiError('后端返回了无法解析的数据', 'parse', response.status)
  }

  if (payload === null || typeof payload !== 'object') {
    throw new ApiError('后端返回了无法解析的数据', 'parse', response.status)
  }

  return payload as T
}

/** 目标目录路径：必须包含 root 到当前目录所有 id，并保留末尾 `/`，例如 `1/12/34/`。 */
export const buildStringOfPath = (breadcrumbs: Breadcrumb[]): string =>
  breadcrumbs.map((item) => `${item.id}/`).join('')

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

export async function requestToken(
  username: string,
  password: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await postForm<ApiMessage & { token?: string }>({
    path: '/api/user/token/',
    form: { username, password },
    signal
  })

  if (response.error_message !== 'success' || !response.token) {
    throw new ApiError(response.error_message || '登录失败', 'business')
  }

  return response.token
}

export async function requestAutoLogin(
  token: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await postForm<ApiMessage>({
    path: '/api/user/auto-login/',
    form: {},
    token,
    signal
  })

  if (response.error_message !== 'success') {
    throw new ApiError(response.error_message || '自动登录失败', 'business')
  }
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

export interface RootSnapshot {
  rootId: number
  directories: DirectoryItem[]
  files: FileItem[]
}

export async function fetchRoot(
  token: string,
  signal?: AbortSignal
): Promise<RootSnapshot> {
  const response = await postForm<RootListing>({
    path: '/api/directory/init/',
    form: {},
    token,
    signal
  })

  if (response.error_message !== 'success') {
    throw new ApiError(response.error_message || '加载根目录失败', 'business')
  }

  const rootId = Number(response.root_id)

  if (!Number.isFinite(rootId) || rootId <= 0) {
    throw new ApiError('后端未返回有效的 root_id', 'business')
  }

  return {
    rootId,
    directories: response.directories ?? [],
    files: response.files ?? []
  }
}

export interface DirectorySnapshot {
  directories: DirectoryItem[]
  files: FileItem[]
}

export async function fetchDirectory(
  token: string,
  parentId: number,
  signal?: AbortSignal
): Promise<DirectorySnapshot> {
  const response = await postForm<DirectoryListing>({
    path: '/api/directory/id/',
    form: { parent_id: parentId },
    token,
    signal
  })

  if (response.error_message !== 'success') {
    throw new ApiError(response.error_message || '加载目录失败', 'business')
  }

  return {
    directories: response.directories ?? [],
    files: response.files ?? []
  }
}

/** 所有"写操作"接口都要求 error_message === 'success'。 */
const expectSuccess = (response: ApiMessage, fallback: string): void => {
  if (response.error_message !== 'success') {
    throw new ApiError(response.error_message || fallback, 'business')
  }
}

export async function createDirectory(
  token: string,
  name: string,
  parentId: number,
  signal?: AbortSignal
): Promise<void> {
  const response = await postForm<ApiMessage>({
    path: '/api/directory/create/',
    form: { name, parent_id: parentId },
    token,
    signal
  })

  expectSuccess(response, '创建目录失败')
}

export async function renameDirectory(
  token: string,
  id: number,
  name: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await postForm<ApiMessage>({
    path: '/api/directory/modify/name/',
    form: { id, name },
    token,
    signal
  })

  expectSuccess(response, '重命名目录失败')
}

export async function deleteDirectory(
  token: string,
  id: number,
  signal?: AbortSignal
): Promise<void> {
  const response = await postForm<ApiMessage>({
    path: '/api/directory/delete/',
    form: { id },
    token,
    signal
  })

  expectSuccess(response, '删除目录失败')
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

export interface RenameFileResult {
  /** 非空表示后端返回 success_oss_error：数据库已改成功，但 OSS 有警告。 */
  warning: string
}

export async function renameFile(
  token: string,
  parentId: number,
  fileId: number,
  filenameNew: string,
  signal?: AbortSignal
): Promise<RenameFileResult> {
  const response = await postForm<ApiMessage>({
    path: '/api/file/modify/name/',
    form: { parentId, fileId, filenameNew },
    token,
    signal
  })

  if (response.error_message === 'success') {
    return { warning: '' }
  }

  // 特殊情况：数据库修改已成功，但 OSS 操作产生警告——不能当成完全失败。
  if (response.error_message === 'success_oss_error') {
    return {
      warning: response.warning_message || '文件已重命名，但旧 OSS 对象暂未删除'
    }
  }

  throw new ApiError(response.error_message || '重命名文件失败', 'business')
}

export async function deleteFile(
  token: string,
  id: number,
  signal?: AbortSignal
): Promise<void> {
  const response = await postForm<ApiMessage>({
    path: '/api/file/delete/',
    form: { id },
    token,
    signal
  })

  expectSuccess(response, '删除文件失败')
}

// ---------------------------------------------------------------------------
// 上传：STS + 数据库落库
// ---------------------------------------------------------------------------

export interface UploadTicketRequest {
  token: string
  stringOfPath: string
  filename: string
  parentId: number
  signal?: AbortSignal
}

/**
 * 申请 STS。
 *
 * `success` 与 `same_file_name` 都允许继续上传；
 * `same_file_name` 只是"同目录同名覆盖"，由调用方给用户一个简短提示。
 */
export async function requestUploadTicket(
  request: UploadTicketRequest
): Promise<UploadTicket> {
  const response = await postForm<StsResponse>({
    path: '/api/oss/sts/',
    form: {
      string_of_path: request.stringOfPath,
      filename: request.filename,
      parent_id: request.parentId,
      usage: STS_USAGE_SINGLE_FILE_UPLOAD
    },
    token: request.token,
    signal: request.signal
  })

  const message = response.error_message

  if (message !== 'success' && message !== 'same_file_name') {
    throw new ApiError(message || '获取上传凭证失败', 'business')
  }

  const { region, bucket, accessKeyId, accessKeySecret, securityToken, objectKey } =
    response

  if (
    !region ||
    !bucket ||
    !accessKeyId ||
    !accessKeySecret ||
    !securityToken ||
    !objectKey
  ) {
    throw new ApiError('后端返回的 STS 凭证不完整', 'business')
  }

  return {
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    securityToken,
    objectKey,
    overwrite: message === 'same_file_name'
  }
}

export interface InsertFileRequest {
  token: string
  stringOfPath: string
  filename: string
  parentId: number
  signal?: AbortSignal
}

/**
 * OSS 对象**完整上传成功之后**才允许调用。
 * 只有 error_message === 'success' 才把 UI 标记为 100%。
 */
export async function insertFileRecord(request: InsertFileRequest): Promise<void> {
  const response = await postForm<ApiMessage>({
    path: '/api/file/insert/',
    form: {
      string_of_path: request.stringOfPath,
      filename: request.filename,
      parent_id: request.parentId
    },
    token: request.token,
    signal: request.signal
  })

  expectSuccess(response, '文件元数据写入失败')
}
