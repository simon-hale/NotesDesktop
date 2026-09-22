/**
 * 统一的上传服务。
 *
 * 首页 Upload 按钮、独立上传窗口、Explorer 右键上传**全部**走这里，
 * 不存在第二套上传实现。
 *
 * 上传语义（严格保留现有 NotesFrontend 的顺序）：
 *
 *   申请 STS → OSS 上传真正完成 → POST /api/file/insert/ → 才算 100% 成功
 *
 * 关键约束：
 *   - OSS 上传完成前绝不写数据库；
 *   - 文件串行上传，单文件内部最多 3 个 5 MiB 分片并行；
 *   - 每个分片用完立刻释放 Uint8Array / ArrayBuffer / Blob 引用，只保留 { number, etag }；
 *   - 重试只针对失败分片，不重传已成功的分片；
 *   - 严重失败或用户取消：best-effort abortMultipartUpload，abort 失败不覆盖原始错误；
 *   - insert 失败时明确提示"OSS 已上传成功，但文件元数据写入失败"，重试只补写数据库。
 */

import { computed, reactive } from 'vue'

import {
  OSS_MAX_RETRY,
  OSS_PROGRESS_CAP,
  OSS_RETRY_BASE_DELAY_MS,
  OSS_TIMEOUT_MS,
  PART_PARALLEL,
  PART_SIZE,
  UPLOAD_CLEANUP_TIMEOUT_MS
} from '../config'
import type { Breadcrumb, UploadTask } from '../types'
import {
  ApiError,
  buildStringOfPath,
  insertFileRecord,
  isAuthFailure,
  requestUploadTicket
} from './api'
import { getAccessToken, getCurrentUsername, onSessionChanged } from './auth'
import type { SessionChange } from './auth'
import { readFileChunk, setUploadActive, setUploadBatchBusy, statLocalFile } from './filesystem'

type OssClient = import('ali-oss').default
type MultipartPart = import('ali-oss').MultipartPart

/** OSS multipart 最多 10000 个分片。 */
const OSS_MAX_PART_NUMBER = 10000

/**
 * 登录态失效时给用户看的提示。
 *
 * 后端的 tokenVersion 机制（提升版本号即让旧 JWT 全部失效）在接口层表现为
 * HTTP 401 / 403。上传流程必须把它识别成"会话过期"，而不是笼统的上传失败：
 *   - **不重试**：认证失败重试多少次都一样；
 *   - **不清理任何上传状态**：OSS 上可能已经存在完整对象或未完成分片，
 *     清掉任务列表等于把它变成没人认领的孤儿对象。
 */
const SESSION_EXPIRED_MESSAGE = '登录状态已失效，请重新登录'

/**
 * 上传被用户取消。
 */
export class UploadCanceledError extends Error {
  constructor() {
    super('上传已取消')
    this.name = 'UploadCanceledError'
  }
}

/**
 * 无法把"上传活动状态"登记到 Rust 侧。
 *
 * 这个状态是退出逻辑的依据，属于关机正确性的一部分，因此**登记失败就不允许开始上传**，
 * 否则应用可能在有上传在跑时直接退出。
 */
export class UploadRegistrationError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? '未知原因')
    super(`无法登记上传状态，已取消本次上传：${detail}`)
    this.name = 'UploadRegistrationError'
  }
}

export interface UploadState {
  tasks: UploadTask[]
  /** 当前目标云目录（面包屑），string_of_path 由它推导。 */
  target: Breadcrumb[]
  running: boolean
}

export const uploadState = reactive<UploadState>({
  tasks: [],
  target: [],
  running: false
})

/** 整体进度：按文件大小加权，空文件按 1 字节计算避免除零。 */
export const uploadOverallProgress = computed<number>(() => {
  let total = 0
  let done = 0

  for (const task of uploadState.tasks) {
    const weight = Math.max(task.size, 1)
    total += weight
    done += weight * clamp01(task.progress)
  }

  return total > 0 ? clamp01(done / total) : 0
})

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

let taskSequence = 0
let runController: AbortController | null = null
let runningPromise: Promise<void> | null = null

/**
 * 当前进行中的 multipart。
 *
 * 保留 OSS client 是为了让 `cancelUpload()` 能**立刻**发起一次 best-effort abort，
 * 而不必等当前分片请求返回。
 */
interface ActiveMultipart {
  client: OssClient
  objectKey: string
  uploadId: string
}

let activeMultipart: ActiveMultipart | null = null

const nextTaskId = (): string => {
  taskSequence += 1
  return `upload-${taskSequence}`
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new UploadCanceledError()
}

/**
 * 尽力而为地把"上传活动状态"清掉。
 *
 * 清理发生在最终清理路径上，失败也不能影响收尾，所以只做一次轻量重试后放弃：
 * 即使这次没清掉，Rust 侧的退出等待仍有硬超时兜底。
 */
const clearUploadActive = async (): Promise<void> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await setUploadActive(false)
      return
    } catch {
      // 再试一次；仍失败就放弃。
    }
  }
}

/** 可取消的等待：定时器在退出时一定被清理。 */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new UploadCanceledError())
      return
    }

    let timer: ReturnType<typeof setTimeout> | null = null

    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      reject(new UploadCanceledError())
    }

    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      timer = null
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })

interface OssLikeError {
  name?: string
  code?: string
  message?: string
  status?: number
  statusCode?: number
  response?: { status?: number }
}

/**
 * 可重试错误：
 *   网络错误 / timeout / connection|socket|ECONNRESET|RequestError /
 *   无 HTTP status / HTTP 408 / HTTP 429 / HTTP >= 500
 *
 * **认证失败（HTTP 401 / 403）永远不重试**：它们不在上面的集合里，所以
 * 无论是后端接口返回的 `ApiError`，还是 OSS 因凭证失效返回的 403，
 * 都会被判为不可重试（tokenVersion 失效、STS 过期都属于这一类）。
 * 业务错误同样不重试。
 */
const isRetryableError = (error: unknown): boolean => {
  if (error instanceof UploadCanceledError) return false
  if (isAuthFailure(error)) return false

  if (error instanceof ApiError) {
    if (error.kind === 'network') return true
    return (
      error.kind === 'http' &&
      (error.status === 408 || error.status === 429 || error.status >= 500)
    )
  }

  // Rust 命令抛出的字符串错误（例如路径非法）：不重试。
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as OssLikeError
  const status = Number(
    candidate.status ?? candidate.statusCode ?? candidate.response?.status
  )

  const errorText = [candidate.name, candidate.code, candidate.message]
    .filter(Boolean)
    .join(' ')

  if (/timeout|network|connection|socket|ECONNRESET|RequestError/i.test(errorText)) {
    return true
  }

  // 没有 HTTP status 通常属于网络层错误。
  if (!Number.isFinite(status) || status === 0) return true

  return status === 408 || status === 429 || status >= 500
}

const describeError = (error: unknown): string => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error === null || error === undefined) return '未知错误'

  try {
    return JSON.stringify(error)
  } catch {
    return '未知错误'
  }
}

/** best-effort 清理：abort 自身失败不能覆盖原始错误。 */
const abortMultipartSafely = async (
  client: OssClient,
  objectKey: string,
  uploadId: string
): Promise<void> => {
  try {
    await client.abortMultipartUpload(objectKey, uploadId)
  } catch {
    // 忽略：清理失败不影响调用方拿到的真实错误。
  }
}

const createOssClient = async (ticket: {
  region: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
}): Promise<OssClient> => {
  // 按需加载，避免主页 bundle 里塞进整个 OSS SDK。
  const { default: OSS } = await import('ali-oss')

  return new OSS({
    region: ticket.region,
    bucket: ticket.bucket,
    accessKeyId: ticket.accessKeyId,
    accessKeySecret: ticket.accessKeySecret,
    stsToken: ticket.securityToken,
    secure: true,
    timeout: OSS_TIMEOUT_MS
  })
}

interface PartUploadOptions {
  client: OssClient
  objectKey: string
  uploadId: string
  partNo: number
  localPath: string
  offset: number
  length: number
  signal: AbortSignal
}

/**
 * 上传单个分片，失败时按策略只重试这一个分片。
 *
 * 每个分片：Rust read_file_chunk → ArrayBuffer → Blob → client.uploadPart，
 * 返回后立即释放这些二进制引用，只把 { number, etag } 交给调用方。
 */
async function uploadPartWithRetry(
  options: PartUploadOptions
): Promise<MultipartPart> {
  const { client, objectKey, uploadId, partNo, localPath, offset, length, signal } =
    options

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal)

    try {
      const buffer = await readFileChunk(localPath, offset, length)
      const blob = new Blob([buffer])

      // ali-oss 6.23.0 的浏览器实现要求 Blob/File：
      // 内部执行 file.slice(start, end)，所以单分片用 start=0、end=blob.size。
      const result = await client.uploadPart(
        objectKey,
        uploadId,
        partNo,
        blob,
        0,
        blob.size
      )

      // 返回对象是 { name, etag, res }，etag 来自 result.res.headers.etag。
      const etag = result?.etag || result?.res?.headers?.etag

      if (!etag) {
        throw new Error(`OSS 未返回第 ${partNo} 个分片的 ETag`)
      }

      return { number: partNo, etag }
    } catch (error) {
      if (attempt >= OSS_MAX_RETRY || !isRetryableError(error)) {
        throw error
      }

      // 500ms、1000ms 递增等待，且等待过程可被取消。
      await sleep(OSS_RETRY_BASE_DELAY_MS * 2 ** attempt, signal)
    }
  }
}

/** 空文件：直接 put 一个空 Blob，成功后再写数据库。 */
async function putEmptyObject(
  client: OssClient,
  objectKey: string,
  signal: AbortSignal
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal)

    try {
      await client.put(objectKey, new Blob([]))
      return
    } catch (error) {
      if (attempt >= OSS_MAX_RETRY || !isRetryableError(error)) {
        throw error
      }

      await sleep(OSS_RETRY_BASE_DELAY_MS * 2 ** attempt, signal)
    }
  }
}

interface MultipartOptions {
  client: OssClient
  objectKey: string
  localPath: string
  size: number
  signal: AbortSignal
  onBytes: (uploadedBytes: number) => void
}

/** 显式 multipart：init → 分片并发上传（最多 3 个 worker）→ 按 number 升序 complete。 */
async function uploadMultipart(options: MultipartOptions): Promise<void> {
  const { client, objectKey, localPath, size, signal, onBytes } = options

  const totalParts = Math.ceil(size / PART_SIZE)

  if (totalParts > OSS_MAX_PART_NUMBER) {
    throw new Error(`文件过大：分片数 ${totalParts} 超过 OSS 上限 ${OSS_MAX_PART_NUMBER}`)
  }

  throwIfAborted(signal)

  const init = await client.initMultipartUpload(objectKey)
  const uploadId = init?.uploadId

  if (!uploadId) {
    throw new Error('OSS 未返回 uploadId')
  }

  activeMultipart = { client, objectKey, uploadId }

  // 在 try 之外声明，便于失败路径等待所有 worker 退出后再收尾。
  const workers: Array<Promise<void>> = []

  try {
    // 只保存 { number, etag }，不保存任何分片内容。
    const parts: Array<MultipartPart | undefined> = new Array(totalParts)

    // 递增计数器：每完成一个分片累加一次，避免每次重扫整个分片数组。
    let uploadedBytes = 0
    let nextIndex = 0

    /**
     * 共享的"停止领取新分片"标记。
     *
     * `Promise.all` 在一个 worker 抛错后会立刻 reject，但其它 worker 并不会因此停下：
     * 它们会在当前的 part 成功后继续 `nextIndex++` 领取下一个分片。
     * 在第一次 abort 真正生效之前，那等于白传。
     *
     * 所以任一 worker 最终失败时先置位，其它 worker 完成在途 part 后即退出，
     * 不再领取新分片（不改变既有的 abort / allSettled / 二次 abort 结构）。
     */
    let stopScheduling = false

    const worker = async (): Promise<void> => {
      for (;;) {
        throwIfAborted(signal)

        if (stopScheduling) return

        const index = nextIndex
        nextIndex += 1

        if (index >= totalParts) return

        const offset = index * PART_SIZE
        const length = Math.min(PART_SIZE, size - offset)

        let part: MultipartPart

        try {
          part = await uploadPartWithRetry({
            client,
            objectKey,
            uploadId,
            partNo: index + 1,
            localPath,
            offset,
            length,
            signal
          })
        } catch (error) {
          // 这个 worker 最终失败了：通知其它 worker 不要再领新分片。
          stopScheduling = true
          throw error
        }

        parts[index] = part
        uploadedBytes += length
        onBytes(uploadedBytes)
      }
    }

    const workerCount = Math.min(PART_PARALLEL, totalParts)

    for (let index = 0; index < workerCount; index += 1) {
      workers.push(worker())
    }

    await Promise.all(workers)

    const completed = parts.filter(
      (part): part is MultipartPart => part !== undefined
    )

    if (completed.length !== totalParts) {
      throw new Error('分片数量不完整，已放弃合并')
    }

    // completeMultipartUpload 内部也会排序，这里显式升序以保证语义清晰。
    completed.sort((left, right) => left.number - right.number)

    throwIfAborted(signal)

    await client.completeMultipartUpload(objectKey, uploadId, completed)
  } catch (error) {
    // 严重失败或取消：先尽力 abort（尽早发出清理请求；
    // 已发出的 HTTP 分片请求并不会因此立即终止，只能等它返回或超时），
    // 再等所有 worker 退出。
    await abortMultipartSafely(client, objectKey, uploadId)

    // ② 等所有 worker 真正退出，保证没有游离的分片上传任务残留。
    await Promise.allSettled(workers)

    // ③ 收尾再 abort 一次：清掉"第一次 abort 之后才完成"的分片。
    //    纯属清理优化，失败同样不能覆盖原始错误。
    await abortMultipartSafely(client, objectKey, uploadId)

    throw error
  } finally {
    if (activeMultipart?.uploadId === uploadId) {
      activeMultipart = null
    }
  }
}

/** 更新任务进度，OSS 阶段最多 OSS_PROGRESS_CAP。 */
const setOssProgress = (task: UploadTask, uploadedBytes: number): void => {
  if (task.size <= 0) {
    task.progress = OSS_PROGRESS_CAP
    return
  }

  task.progress = Math.min(OSS_PROGRESS_CAP, clamp01(uploadedBytes / task.size))
}

/**
 * 只补写数据库元数据。
 *
 * 前提：OSS 对象**已经完整上传成功**（task.objectUploaded === true），
 * 这里只调用 `/api/file/insert/`，不 stat 本地文件、不看当前 UI 目标目录。
 * 使用的路径 / 父目录 / 文件名全部来自上传成功时保存下来的快照。
 */
async function insertMetadataOnly(
  task: UploadTask,
  token: string,
  signal: AbortSignal
): Promise<void> {
  try {
    await insertFileRecord({
      token,
      stringOfPath: task.uploadedPath,
      filename: task.uploadedFilename || task.name,
      parentId: task.uploadedParentId,
      signal
    })

    task.progress = 1
    task.status = 'success'
    task.message = '文件元数据已补写成功'
  } catch (error) {
    if (error instanceof UploadCanceledError) {
      task.status = 'canceled'
      task.progress = OSS_PROGRESS_CAP
      task.message = '已取消：OSS 已上传，文件元数据尚未写入'
      return
    }

    task.status = 'error'
    task.progress = OSS_PROGRESS_CAP

    // 登录态失效（401/403，例如后端 tokenVersion 被提升）：
    // 明确告知会话过期，同时**保留 99% 的恢复状态**——OSS 对象已经完整上传，
    // 重新登录后点重试只会补写元数据，不会重传文件。
    if (isAuthFailure(error)) {
      task.message = `${SESSION_EXPIRED_MESSAGE}；OSS 已上传，登录后重试只会补写元数据`
      return
    }

    // OSS 已经成功，只是元数据没写进去：不要偷偷重传整个文件。
    task.message = `OSS 已上传成功，但文件元数据写入失败：${describeError(error)}`
  }
}

async function runTask(task: UploadTask, signal: AbortSignal): Promise<void> {
  task.status = 'uploading'
  task.message = ''
  task.overwrite = false

  const token = getAccessToken()

  if (!token) {
    task.status = 'error'
    task.message = '登录状态已失效，请重新登录'
    return
  }

  // 特殊分支：OSS 已经完整上传、只是数据库没落库 —— **只补 insert**。
  //
  //    刻意做在 stat 本地文件与读取当前 UI 目标之前：
  //      - 本地文件可能已经被删除 / 移动，那不应该妨碍补写元数据；
  //      - 用户可能已经改了目标目录，但那也不该导致"重新上传一遍"，
  //        否则原来那个已经完整上传、没有 DB 记录的 OSS object 会被永久遗留。
  //    所以一律使用上传成功时保存下来的 path / parentId / filename。
  if (task.objectUploaded && task.uploadedPath && task.uploadedParentId > 0) {
    await insertMetadataOnly(task, token, signal)
    return
  }

  const target = uploadState.target
  const parentId = target.length > 0 ? target[target.length - 1]?.id : undefined

  if (!parentId) {
    task.status = 'error'
    task.message = '未选择目标云目录'
    return
  }

  const stringOfPath = buildStringOfPath(target)

  try {
    const info = await statLocalFile(task.path)

    throwIfAborted(signal)

    task.name = info.name
    task.size = info.size
    task.path = info.path

    task.progress = 0

    // ① 申请 STS（success / same_file_name 都继续）
    const ticket = await requestUploadTicket({
      token,
      stringOfPath,
      filename: info.name,
      parentId,
      signal
    })

    task.overwrite = ticket.overwrite

    if (ticket.overwrite) {
      task.message = '目标目录已有同名文件，将覆盖'
    }

    // ② OSS 上传真正完成
    const client = await createOssClient(ticket)

    if (info.size === 0) {
      // 空文件没有可拆分的数据，直接 put 一个空 Blob。
      await putEmptyObject(client, ticket.objectKey, signal)
      task.progress = OSS_PROGRESS_CAP
    } else {
      await uploadMultipart({
        client,
        objectKey: ticket.objectKey,
        localPath: info.path,
        size: info.size,
        signal,
        onBytes: (uploadedBytes) => setOssProgress(task, uploadedBytes)
      })

      task.progress = OSS_PROGRESS_CAP
    }

    task.objectUploaded = true
    task.uploadedPath = stringOfPath
    task.uploadedParentId = parentId
    task.uploadedFilename = info.name

    throwIfAborted(signal)

    // ③ 只有 OSS 完整成功后才写数据库
    await insertFileRecord({
      token,
      stringOfPath,
      filename: info.name,
      parentId,
      signal
    })

    // ④ 数据库写入成功才算 100%
    task.progress = 1
    task.status = 'success'
    task.message = ticket.overwrite ? '已覆盖同名文件' : ''
  } catch (error) {
    if (error instanceof UploadCanceledError) {
      task.status = 'canceled'

      if (task.objectUploaded) {
        // OSS 已经传完，只是元数据没写：保留 99%，重试时只补写数据库。
        task.progress = OSS_PROGRESS_CAP
        task.message = '已取消：OSS 已上传，文件元数据尚未写入'
      } else {
        task.progress = 0
        task.message = '已取消'
      }

      return
    }

    if (task.objectUploaded) {
      // OSS 已经成功，只是元数据没写进去：不要偷偷重传整个文件。
      task.status = 'error'
      task.progress = OSS_PROGRESS_CAP

      // 登录态失效（401/403，例如后端 tokenVersion 被提升）：
      // 保留 99% 恢复状态与 objectUploaded 快照，重新登录后重试只补写元数据。
      task.message = isAuthFailure(error)
        ? `${SESSION_EXPIRED_MESSAGE}；OSS 已上传，登录后重试只会补写元数据`
        : `OSS 已上传成功，但文件元数据写入失败：${describeError(error)}`

      return
    }

    task.status = 'error'
    task.progress = 0

    // 登录态失效要给出明确原因，而不是笼统的上传失败。
    // 注意：这里**不做任何清理**（不清任务、不清目标目录、不触发 logout）——
    // OSS 上可能已经有传完的对象，清掉这些状态会让它变成没人认领的孤儿对象。
    task.message = isAuthFailure(error)
      ? SESSION_EXPIRED_MESSAGE
      : describeError(error)
  }
}

/** 设置当前目标云目录（上传进行中不允许切换）。 */
export function setUploadTarget(target: Breadcrumb[]): void {
  if (uploadState.running) return

  uploadState.target = target.map((item) => ({ id: item.id, name: item.name }))
}

export interface AddPathsResult {
  added: number
  failed: Array<{ path: string; reason: string }>
}

/**
 * 上传会话代际号。
 *
 * 每次"账号会话变化"（退出登录 / 换账号）都会自增。任何可能在 await 之后写
 * `uploadState` 的异步操作都必须先捕获它，并在每个 await 之后重新比对，
 * 避免在账号 A 下发起、账号 B 下才返回的请求把任务/目标写进 B 的会话。
 */
let uploadSessionGeneration = 0

/** 当前的"上传会话代际号"。 */
export const getUploadSessionGeneration = (): number => uploadSessionGeneration

/** 把本地绝对路径加入待上传列表（会先 stat 确认是普通文件）。 */
export async function addPaths(paths: string[]): Promise<AddPathsResult> {
  const result: AddPathsResult = { added: 0, failed: [] }
  const generation = uploadSessionGeneration

  for (const path of paths) {
    const duplicated = uploadState.tasks.some(
      (task) =>
        task.path === path &&
        (task.status === 'pending' || task.status === 'uploading')
    )

    if (duplicated) continue

    try {
      const info = await statLocalFile(path)

      // 这次 stat 属于上一个账号会话：结果必须整体丢弃，不能推进 B 的任务列表。
      if (generation !== uploadSessionGeneration) return result

      uploadState.tasks.push({
        id: nextTaskId(),
        path: info.path,
        name: info.name,
        size: info.size,
        // 记下创建者账号（只记账号名，不记令牌）：
        // 会话切换时靠它判断这个恢复任务还能不能留。
        ownerUsername: getCurrentUsername(),
        status: 'pending',
        progress: 0,
        message: '',
        overwrite: false,
        objectUploaded: false,
        uploadedPath: '',
        uploadedParentId: 0,
        uploadedFilename: ''
      })

      result.added += 1
    } catch (error) {
      if (generation !== uploadSessionGeneration) return result

      result.failed.push({ path, reason: describeError(error) })
    }
  }

  return result
}

/**
 * 这个任务是否"OSS 已成功但数据库还没落库"。
 *
 * 这种任务不能被悄悄丢掉：丢掉它等于把一个已经存在于 OSS、
 * 却在 `files` 表里没有记录的对象永久遗留（用户看不到、也删不掉）。
 * 因此它只能 Retry（补写元数据），不能 Remove / Clear。
 */
export const isMetadataPendingTask = (task: UploadTask): boolean =>
  task.objectUploaded && task.status !== 'success'

/** 移除一个任务（上传中的任务、以及元数据待补写的任务都不允许移除）。 */
export function removeTask(taskId: string): void {
  const index = uploadState.tasks.findIndex((task) => task.id === taskId)

  if (index < 0) return

  const task = uploadState.tasks[index]

  if (task.status === 'uploading' || isMetadataPendingTask(task)) return

  uploadState.tasks.splice(index, 1)
}

/** 把失败/取消的任务重新排队。 */
export function retryTask(taskId: string): void {
  const task = uploadState.tasks.find((item) => item.id === taskId)

  if (!task || task.status === 'uploading') return

  task.status = 'pending'
  task.message = ''
  task.progress = task.objectUploaded ? OSS_PROGRESS_CAP : 0
}

/**
 * 清空已结束（完成 / 失败 / 取消）的任务。
 *
 * "OSS 已成功但元数据待补写"的任务会被保留：丢掉它等于永久遗留一个
 * OSS 上存在、`files` 表里却没有记录的对象。这类任务只能 Retry。
 */
export function clearFinishedTasks(): void {
  for (let index = uploadState.tasks.length - 1; index >= 0; index -= 1) {
    const task = uploadState.tasks[index]

    if (task.status === 'uploading' || task.status === 'pending') continue
    if (isMetadataPendingTask(task)) continue

    uploadState.tasks.splice(index, 1)
  }
}

/** 清空整个列表，但同样保留"元数据待补写"的任务。 */
export function clearAllTasks(): void {
  if (uploadState.running) return

  for (let index = uploadState.tasks.length - 1; index >= 0; index -= 1) {
    if (isMetadataPendingTask(uploadState.tasks[index])) continue

    uploadState.tasks.splice(index, 1)
  }
}

/**
 * 开始上传：文件串行，单文件内部 3 个分片并行。
 * 每次运行都会新建 AbortController，作为取消上传的唯一信号源。
 */
export async function startUpload(): Promise<void> {
  if (uploadState.running) return

  const queue = uploadState.tasks.filter(
    (task) =>
      task.status === 'pending' ||
      task.status === 'error' ||
      task.status === 'canceled'
  )

  if (queue.length === 0) return

  const controller = new AbortController()
  runController = controller
  uploadState.running = true

  /**
   * Rust 侧的"有上传在跑"是否**登记成功过**。
   *
   * 登记失败时绝不能在 finally 里再调一次 `setUploadActive(false)`：
   * 那是去清一个从未登记成功（甚至可能属于别人）的状态。
   */
  let activeRegistered = false

  /**
   * 完整生命周期：从"登记 active"开始，到"清掉 active"结束。
   *
   * `runningPromise` 必须覆盖**整段**——如果只包住任务循环，
   * 那么在 `setUploadActive(true)` 这个 IPC 还在路上的窗口里，
   * `running === true` 而 `runningPromise === null`，
   * `waitForUploadIdle()` 会立刻误判为已经 idle。
   */
  const lifecyclePromise = (async () => {
    try {
      // 登记失败 fail closed：不开始上传，由调用方提示用户。
      await setUploadActive(true)
      activeRegistered = true

      for (const task of queue) {
        if (controller.signal.aborted) break
        await runTask(task, controller.signal)
      }
    } catch (error) {
      // 登记阶段就失败：换成带清晰提示的错误（契约与之前一致）。
      if (!activeRegistered) {
        throw new UploadRegistrationError(error)
      }

      throw error
    } finally {
      // 只有真正登记成功过才清理（best-effort + 一次轻量重试）。
      if (activeRegistered) {
        await clearUploadActive()
      }
    }
  })()

  runningPromise = lifecyclePromise

  try {
    await lifecyclePromise
  } finally {
    // 只有上面的生命周期 promise 真正结束（含 Rust 侧清理）之后，才允许：
    //   - running 变 false（否则新上传可能在旧清理还没落地时就开始，
    //     旧的那次 setUploadActive(false) 甚至可能盖掉新的 active=true）
    //   - runningPromise 置空、runController 释放
    uploadState.running = false
    runningPromise = null

    if (runController === controller) {
      runController = null
    }
  }
}

/**
 * 取消上传。
 *
 * 做两件事：
 *   1. 设置 cancellation flag（abort signal）：进行中的分片停止重试，worker 尽快退出；
 *   2. 如果此刻有进行中的 multipart，**立刻**发一次 best-effort `abortMultipartUpload`，
 *      不必等当前分片请求返回。
 *
 * 注意语义：第 2 步只是"尽早发出清理请求"，**不保证**在途分片立刻终止
 * （HTTP 请求无法强制中断）。真正的收尾仍在 multipart 的失败/取消路径里完成
 * （abort -> Promise.allSettled(workers) -> 再次 abort）。
 */
export function cancelUpload(): void {
  const controller = runController

  if (controller && !controller.signal.aborted) {
    controller.abort()
  }

  // 不 await：立刻发起、后台完成，绝不阻塞调用方（取消/退出都要保持有界）。
  void abortActiveMultipartNow()

  for (const task of uploadState.tasks) {
    if (task.status === 'pending') {
      task.status = 'canceled'
      task.progress = task.objectUploaded ? OSS_PROGRESS_CAP : 0
      task.message = task.objectUploaded
        ? '已取消：OSS 已上传，文件元数据尚未写入'
        : '已取消'
    }
  }
}

/** 对当前进行中的 multipart 发起一次 best-effort abort（失败静默）。 */
const abortActiveMultipartNow = async (): Promise<void> => {
  const multipart = activeMultipart

  if (!multipart) return

  await abortMultipartSafely(multipart.client, multipart.objectKey, multipart.uploadId)
}

/**
 * 当前这一轮上传是否已经**完全**结束（含 Rust 侧 setUploadActive(false) 清理）。
 *
 * 用于关闭窗口 / 取消 / 会话清理前的等待：它代表整个上传/取消/清理生命周期，
 * 而不只是文件 worker 跑完了。
 */
export function waitForUploadIdle(): Promise<void> {
  return runningPromise ?? Promise.resolve()
}

/**
 * 有界等待上传结束：返回是否在超时前真正 idle。
 *
 * 返回 `false` 只表示"超时了，任务还在收尾"，**不能**当成"上传已经停止"。
 */
export function waitForUploadIdleBounded(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)

    void waitForUploadIdle().then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * 会话变化（退出登录 / 换账号 / 登录）时清理与账号绑定的上传状态。
 *
 * 顺序很重要（必须是"先清界面状态、后等待收尾"）：
 *   ① 请求取消：abort signal + 立刻发一次 best-effort multipart abort；
 *   ② **立即**重算 tasks 与清空 target —— 都在任何 await 之前完成，
 *      否则新会话可能已经初始化了自己的状态，却被这次清理抹掉；
 *   ③ 再对上一会话的上传做有界等待。
 *
 * 保留规则（**只保留恢复任务**）：
 *   - 普通 / 未完成的任务一律清掉（与之前完全一致）；
 *   - 只有"OSS 对象已经完整上传、只差写元数据"的任务才可能留下，
 *     而且必须属于**当前（或刚刚离开的）账号**——绝不把一个账号的待办暴露给另一个账号。
 *   - 任务上只记了账号名，没有令牌；重试时用的是那时最新的访问令牌，
 *     并且只走补写元数据的分支，绝不会重传 OSS 对象。
 *
 * 第 ③ 步**不再**清 tasks/target：那时新会话可能已经加载了自己的 root。
 * 被移出界面的任务对象仍被 worker 持有（startUpload 捕获了任务引用），
 * 它们会照常走完取消 / abort / 清理流程，不影响收尾。
 */
async function resetUploadStateForSessionChange(change: SessionChange): Promise<void> {
  // 先让代际号前进：所有在途的异步操作（addPaths 等）从此刻起一律失效。
  uploadSessionGeneration += 1

  // ① 请求取消（没有活动上传时是空操作）。
  cancelUpload()

  // ② 立即重算任务列表与目标目录——必须在第一个 await 之前。
  const hadTasks = uploadState.tasks.length > 0

  // 登出时 currentUsername 为空串：此时保留"刚离开的那个账号"的恢复任务，
  // 等它重新登录后还能补写元数据；换账号时保留的是新账号自己的任务。
  const keepUsername = change.currentUsername || change.previousUsername

  const keptTasks = uploadState.tasks.filter(
    (task) => isMetadataPendingTask(task) && task.ownerUsername === keepUsername
  )

  uploadState.tasks.splice(0, uploadState.tasks.length, ...keptTasks)
  uploadState.target = []

  // 任务列表变了 => 同步"这一批是否仍被占用"。
  // 只有这个窗口真的持有过任务时才写：主窗口的任务列表永远是空的，
  // 让它去写会把上传窗口的状态覆盖掉。
  if (hadTasks) {
    try {
      await setUploadBatchBusy(keptTasks.some((task) => task.status !== 'success'))
    } catch {
      // 状态同步失败不影响清理本身。
    }
  }

  // ③ 有界等待上一会话的上传收尾：不因为某个分片卡住就无限拖延
  //    （Rust 侧退出另有硬超时兜底）。这里绝不再清 tasks/target。
  await waitForUploadIdleBounded(UPLOAD_CLEANUP_TIMEOUT_MS)
}

// 账号被清空 / 更换账号 / 重新登录时自动清理或保留，避免状态跨账号泄漏。
onSessionChanged((change) => {
  void resetUploadStateForSessionChange(change)
})

/** 窗口卸载时调用：取消进行中的上传并释放引用。 */
export function disposeUpload(): void {
  cancelUpload()
  activeMultipart = null
}
