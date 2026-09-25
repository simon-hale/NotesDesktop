/**
 * 统一的上传服务（持久化可续传版本）。
 *
 * 首页 Upload 按钮、独立上传窗口、Explorer 右键上传**全部**走这里，
 * 不存在第二套上传实现。
 *
 * 上传语义（严格保留现有 NotesFrontend 的顺序）：
 *
 *   申请 STS → OSS 上传真正完成 → POST /api/file/insert/ → 才算 100% 成功
 *
 * 关键约束：
 *   - OSS 上传完成前绝不写数据库；进度在 insert 成功前永远不超过 99%；
 *   - 文件串行上传，单文件内部最多 3 个 5 MiB 分片并行；
 *   - 每个分片用完立刻释放 Uint8Array / ArrayBuffer / Blob 引用，只保留 { number, etag, size }；
 *   - 显式 multipart：InitMultipartUpload / UploadPart / CompleteMultipartUpload，
 *     绝不换成浏览器 `multipartUpload(File)`；
 *   - **本地 PartNumber + ETag 是唯一事实来源**，完成合并绝不依赖 ListParts；
 *   - 三个持久化阶段：TRANSFERRING / PAUSED / METADATA_PENDING（见 upload-checkpoints.ts）。
 *
 * 暂停 vs 取消（**这是本文件最重要的一组语义**）：
 *
 *   Pause（暂停）
 *     - 停止调度新分片；在途分片跑到安全边界后自然结束（ali-oss 6.23.0 的
 *       `client.cancel()` 只置 cancelFlag / 销毁 Node stream，**不会**中断浏览器端
 *       已经发出的 XHR，所以这里不使用它——见下面 pauseUploads 的说明）；
 *     - 保留 uploadId 与全部已完成分片记录，phase 落盘为 PAUSED；
 *     - **绝不** AbortMultipartUpload，**绝不**删除 checkpoint。
 *
 *   Cancel（取消上传）
 *     - 破坏性：abort multipart（double abort）→ 删除 checkpoint → 标记取消。
 *     - 只有显式取消、本地源身份变化、以及明确不可恢复的任务失效才会走这条路。
 *
 *   正常退出应用 = 暂停，不是取消：进程带着在途分片退出也是安全的，
 *   那个"服务端已成功但本地还没记录"的分片，下次 Resume 用同一个 partNumber 重传即可。
 */

import { computed, reactive } from 'vue'

import {
  OSS_MAX_RETRY,
  OSS_PROGRESS_CAP,
  OSS_RETRY_BASE_DELAY_MS,
  PART_PARALLEL,
  PART_SIZE,
  UPLOAD_CLEANUP_TIMEOUT_MS
} from '../config'
import type { Breadcrumb, LocalFileInfo, UploadStatus, UploadTask } from '../types'
import {
  ApiError,
  buildStringOfPath,
  insertFileRecord,
  isAuthFailure
} from './api'
import { getAccessToken, getCurrentUsername, onSessionChanged } from './auth'
import type { SessionChange } from './auth'
import { readFileChunk, setUploadActive, setUploadBatchBusy, statLocalFile } from './filesystem'
import {
  createCheckpoint,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpointsForOwner,
  loadCheckpoints,
  checkpointLoadFailed,
  recordedBytes,
  resetCheckpointForFreshUpload,
  saveCheckpoint
} from './upload-checkpoints'
import type {
  UploadCheckpoint,
  UploadCheckpointPart,
  UploadCheckpointTarget
} from './upload-checkpoints'
import {
  isOssNoSuchUpload,
  TransferCredentials,
  TransferIdentityChangedError,
  TransferSessionExpiredError
} from './transfer-credentials'
import {
  UploadCanceledError,
  UploadPausedError,
  UploadRegistrationError
} from './upload-errors'

export { UploadCanceledError, UploadPausedError, UploadRegistrationError }

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

/** Rust 侧本地文件被改动时返回的错误文本前缀（与 commands/files.rs 一致）。 */
const LOCAL_FILE_CHANGED_MARKER = 'The local file changed during upload'

/** 可以被"继续上传"接手的任务状态。 */
const RESUMABLE_STATUSES: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  'pending',
  'paused',
  'error',
  'canceled',
  'metadata_pending'
])

export interface UploadState {
  tasks: UploadTask[]
  /** 当前目标云目录（面包屑），string_of_path 由它推导；**只影响新任务**。 */
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

/**
 * 当前活动传输。
 *
 * `checkpoint` 是**内存里的权威副本**（与 upload-checkpoints.ts 的缓存是同一个对象），
 * 3 个 worker 直接把新分片写进它的 parts，然后统一走串行落盘。
 */
interface ActiveTransfer {
  task: UploadTask
  checkpoint: UploadCheckpoint
  credentials: TransferCredentials
  /** 本次传输的暂停请求（graceful）。 */
  pauseRequested: boolean
}

/** 一轮上传（一批文件串行处理）的运行时上下文。 */
interface ActiveRun {
  /** 破坏性取消信号；**只有显式取消才会 abort**。 */
  controller: AbortController
  /** 本轮是否被要求暂停（暂停不 abort）。 */
  pauseRequested: boolean
  transfer: ActiveTransfer | null
  /**
   * 本轮**正在处理**的任务（含"只补写元数据"那条没有 multipart 的分支）。
   *
   * 取消路径靠它判断"当前文件是不是已经过了 Complete 这道线"：
   * 过了线的任务没有 multipart 可取消，绝不能被当成可取消的分片上传。
   */
  currentTask: UploadTask | null
  /**
   * 本轮已经被显式取消的任务 id。
   *
   * 队列是**开跑之前**一次性捕获的（`startUpload` 里的 `queue`），之后用户仍可能
   * 单独取消其中某个还没开始的任务。那种取消不会 abort 整轮（它只影响那一个任务），
   * 所以必须在这里记一笔：否则队列循环走到它时，会因为 `canceled` 本身也在
   * RESUMABLE_STATUSES 里而把"用户刚取消的任务"重新启动。
   */
  canceledTaskIds: Set<string>
}

let activeRun: ActiveRun | null = null
let runningPromise: Promise<void> | null = null

/**
 * 当前进行中的 multipart。
 *
 * 保留它是为了让"显式取消"能**立刻**发起一次 best-effort abort，
 * 而不必等当前分片请求返回（在途 HTTP 请求无法强制中断）。
 */
interface ActiveMultipart {
  credentials: TransferCredentials
  objectKey: string
  uploadId: string
}

let activeMultipart: ActiveMultipart | null = null

/** 生成稳定的 transferId（同时就是 UploadTask.id 与 checkpoint 主键）。 */
const createTransferId = (): string => {
  const globalCrypto = globalThis.crypto

  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }

  if (globalCrypto && typeof globalCrypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)

    globalCrypto.getRandomValues(bytes)

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new UploadCanceledError()
}

/**
 * 在"取消 / 暂停"边界上做检查。
 *
 * 取消优先于暂停：一旦 abort，就绝不能再走温和的暂停路径。
 */
const throwIfStopped = (run: ActiveRun): void => {
  throwIfAborted(run.controller.signal)

  if (run.pauseRequested) throw new UploadPausedError()
}

/**
 * 本轮当前文件是否**已经过了 Complete 这条线**（只剩元数据登记）。
 *
 * 这是"暂停 / 取消"共同的分界线：
 *   - 过了线：OSS 对象已经完整存在，没有 multipart 可以 abort，
 *     也没有分片可以暂停；任何操作都只能"让这一批在这一步之后停下"；
 *   - 没过线：照旧走各自的破坏性 / 温和路径。
 *
 * 同时看 `objectUploaded` 是为了兜住"状态还没来得及切成 metadata_pending"
 * 的那一瞬：只要对象已经完整，就绝不能再把它当成可取消的分片上传。
 */
const isFinalizingMetadata = (run: ActiveRun | null): boolean =>
  run !== null &&
  run.currentTask !== null &&
  (run.currentTask.status === 'metadata_pending' || run.currentTask.objectUploaded)

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

/** Rust 命令以字符串形式 reject："本地文件在上传期间被改动"。 */
const isLocalFileChangedError = (error: unknown): boolean => {
  if (typeof error === 'string') return error.includes(LOCAL_FILE_CHANGED_MARKER)
  if (error instanceof Error) return error.message.includes(LOCAL_FILE_CHANGED_MARKER)

  return false
}

/**
 * 可重试错误：
 *   网络错误 / timeout / connection|socket|ECONNRESET|RequestError /
 *   无 HTTP status / HTTP 408 / HTTP 429 / HTTP >= 500
 *
 * **认证失败（HTTP 401 / 403）永远不重试**：它们不在上面的集合里，所以
 * 无论是后端接口返回的 `ApiError`，还是 OSS 因凭证彻底失效返回的 403，
 * 都会被判为不可重试（tokenVersion 失效、STS 过期（已由凭证管理器兜住）都属于这一类）。
 * 业务错误同样不重试。
 *
 * 本地文件改动、目标身份变化、暂停、取消这几类**本地错误**必须显式排除：
 * 它们是 Error 实例但没有 status 字段，若落到"没有 HTTP status 就重试"的兜底分支，
 * 就会变成一个毫无意义的死循环。
 */
const isRetryableError = (error: unknown): boolean => {
  if (error instanceof UploadCanceledError) return false
  if (error instanceof UploadPausedError) return false
  if (error instanceof TransferIdentityChangedError) return false
  if (error instanceof TransferSessionExpiredError) return false
  if (isLocalFileChangedError(error)) return false
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

/**
 * best-effort 清理：abort 自身失败不能覆盖原始错误。
 *
 * 走 `credentials.run` 是为了让"凭证刚好过期"也能被一次静默刷新兜住：
 * 取消上传时因为 403 而 abort 失败，会留下一个真正的孤儿 multipart。
 */
const abortMultipartSafely = async (
  credentials: TransferCredentials,
  objectKey: string,
  uploadId: string
): Promise<void> => {
  if (!uploadId || !objectKey) return

  try {
    await credentials.run((client) => client.abortMultipartUpload(objectKey, uploadId))
  } catch (error) {
    // 404 / NoSuchUpload 表示"目标已达成"：multipart 已经不存在了。
    if (isOssNoSuchUpload(error)) return

    // 其它失败一律静默：清理失败不影响调用方拿到的真实错误。
  }
}

/** 对当前进行中的 multipart 发起一次 best-effort abort（失败静默）。 */
const abortActiveMultipartNow = async (): Promise<void> => {
  const multipart = activeMultipart

  if (!multipart) return

  await abortMultipartSafely(multipart.credentials, multipart.objectKey, multipart.uploadId)
}

/** 删除 checkpoint（失败重试一次；仍失败也不能影响主流程的成功判定）。 */
const deleteCheckpointSafely = async (transferId: string): Promise<void> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deleteCheckpoint(transferId)
      return
    } catch {
      // 再试一次；仍失败就交给下次启动时的整体覆盖写。
    }
  }
}

// ---------------------------------------------------------------------------
// 分片上传
// ---------------------------------------------------------------------------

interface PartUploadOptions {
  credentials: TransferCredentials
  objectKey: string
  uploadId: string
  partNo: number
  localPath: string
  expected: { size: number; modifiedAtMs: number }
  offset: number
  length: number
  signal: AbortSignal
}

/**
 * 上传单个分片，失败时按策略只重试这一个分片。
 *
 * 每个分片：Rust read_file_chunk（带源快照校验）→ ArrayBuffer → Blob → uploadPart，
 * 返回后立即释放这些二进制引用，只把 { number, etag, size } 交给调用方。
 *
 * "本地文件改动"是**不可重试**的：重试同一个 offset 只会拿到同样的错误，
 * 而且继续用旧快照上传会拼出一个前后不一致的对象。
 */
async function uploadPartWithRetry(
  options: PartUploadOptions
): Promise<MultipartPart> {
  const {
    credentials,
    objectKey,
    uploadId,
    partNo,
    localPath,
    expected,
    offset,
    length,
    signal
  } = options

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal)

    try {
      const buffer = await readFileChunk(localPath, offset, length, expected)
      const blob = new Blob([buffer])

      // ali-oss 6.23.0 的浏览器实现要求 Blob/File：
      // 内部执行 file.slice(start, end)，所以单分片用 start=0、end=blob.size。
      //
      // 通过 credentials.run 发出：凭证接近过期会先静默刷新，
      // 收到 403/401 会强制刷新一次并重试这同一个分片（uploadPart 幂等）。
      const result = await credentials.run((client) =>
        client.uploadPart(objectKey, uploadId, partNo, blob, 0, blob.size)
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
  credentials: TransferCredentials,
  objectKey: string,
  signal: AbortSignal
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal)

    try {
      await credentials.run((client) => client.put(objectKey, new Blob([])))
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
  credentials: TransferCredentials
  objectKey: string
  uploadId: string
  localPath: string
  expected: { size: number; modifiedAtMs: number }
  size: number
  /** 使用 checkpoint 里记下的分片大小：中途改过 PART_SIZE 也能正确续传。 */
  partSize: number
  /** 本地已记录的分片（**权威**）。worker 直接往里写。 */
  completed: Map<number, UploadCheckpointPart>
  /** 每个分片成功后调用：落盘 checkpoint（串行化）。 */
  onPartUploaded: (part: UploadCheckpointPart) => Promise<void>
  onBytes: (uploadedBytes: number) => void
  isPauseRequested: () => boolean
  signal: AbortSignal
}

/**
 * 显式 multipart：init 由调用方负责 → 分片并发上传（最多 3 个 worker）→ 本地 ETag 升序 complete。
 *
 * 返回值 `paused: true` 表示"因为暂停而停在安全边界"，**没有**执行 Complete，
 * 且 multipart 与本地分片记录都完整保留。
 */
async function uploadMultipart(
  options: MultipartOptions
): Promise<{ paused: boolean }> {
  const {
    credentials,
    objectKey,
    uploadId,
    localPath,
    expected,
    size,
    partSize,
    completed,
    onPartUploaded,
    onBytes,
    isPauseRequested,
    signal
  } = options

  const totalParts = Math.ceil(size / partSize)

  if (totalParts > OSS_MAX_PART_NUMBER) {
    throw new Error(`文件过大：分片数 ${totalParts} 超过 OSS 上限 ${OSS_MAX_PART_NUMBER}`)
  }

  throwIfAborted(signal)

  // 恢复时先把"已经记录过的分片"计入进度，用户一按继续就能看到真实起点。
  let uploadedBytes = 0

  for (const part of completed.values()) {
    uploadedBytes += part.size
  }

  onBytes(uploadedBytes)

  if (isPauseRequested()) return { paused: true }

  const workers: Array<Promise<void>> = []

  /**
   * 共享的"停止领取新分片"标记。
   *
   * `Promise.all` 在一个 worker 抛错后会立刻 reject，但其它 worker 并不会因此停下：
   * 它们会在当前的 part 成功后继续 `nextIndex++` 领取下一个分片。
   * 在第一次 abort 真正生效之前，那等于白传。
   *
   * 所以任一 worker 最终失败时先置位，其它 worker 完成在途 part 后即退出。
   */
  let stopScheduling = false
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(signal)

      if (stopScheduling) return
      if (isPauseRequested()) return

      const index = nextIndex
      nextIndex += 1

      if (index >= totalParts) return

      const partNo = index + 1
      const offset = index * partSize
      const length = Math.min(partSize, size - offset)

      /**
       * 本地已经记录过这个分片号：**不发网络请求**，直接跳过。
       *
       * 这正是"Resume 不重传已成功分片"的实现点；同时也是崩溃恢复的兜底——
       * 如果崩溃发生在"OSS 已接受分片"与"本地记下 ETag"之间，
       * 那么这里不会跳过它，而是用同一个 partNumber 重传一次（安全且幂等）。
       */
      if (completed.has(partNo)) continue

      let part: MultipartPart

      try {
        part = await uploadPartWithRetry({
          credentials,
          objectKey,
          uploadId,
          partNo,
          localPath,
          expected,
          offset,
          length,
          signal
        })
      } catch (error) {
        // 这个 worker 最终失败了：通知其它 worker 不要再领新分片。
        stopScheduling = true
        throw error
      }

      // ① 更新内存里的权威分片表；② 落盘（串行化，见 upload-checkpoints.ts）。
      //    顺序不能反：先落盘再记录，会让内存与磁盘短暂不一致。
      const record: UploadCheckpointPart = {
        partNumber: partNo,
        etag: part.etag,
        size: length
      }

      completed.set(partNo, record)
      await onPartUploaded(record)

      uploadedBytes += length
      onBytes(uploadedBytes)
    }
  }

  const workerCount = Math.min(PART_PARALLEL, totalParts)

  try {
    for (let index = 0; index < workerCount; index += 1) {
      workers.push(worker())
    }

    await Promise.all(workers)
  } catch (error) {
    if (error instanceof UploadCanceledError) {
      // 显式取消：破坏性清理。
      //   ① 尽早发出 abort（已发出的 HTTP 分片请求不会因此立即终止，只能等它返回或超时）；
      //   ② 等所有 worker 真正退出；
      //   ③ 再 abort 一次，清掉"第一次 abort 之后才完成"的分片。
      await abortMultipartSafely(credentials, objectKey, uploadId)
      await Promise.allSettled(workers)
      await abortMultipartSafely(credentials, objectKey, uploadId)
    } else {
      // 可恢复失败 / 暂停：**保留 multipart 与本地分片记录**，只等 worker 退出。
      // 网络中断、超时、5xx、重试预算耗尽都走这里；下次 Resume 从断点继续。
      await Promise.allSettled(workers)
    }

    throw error
  }

  // 暂停请求优先于 Complete：用户按了暂停就停在断点，绝不偷偷把剩下两步做完。
  if (isPauseRequested()) return { paused: true }

  // 严格使用**本地记录**的 partNumber + ETag，按 partNumber 升序。
  const parts = [...completed.values()].sort(
    (left, right) => left.partNumber - right.partNumber
  )

  if (parts.length !== totalParts) {
    throw new Error('分片数量不完整，已放弃合并')
  }

  const totalBytes = parts.reduce((sum, part) => sum + part.size, 0)

  if (totalBytes !== size) {
    throw new Error('分片大小与本地文件不一致，已放弃合并')
  }

  const finalParts: MultipartPart[] = parts.map((part) => ({
    number: part.partNumber,
    etag: part.etag
  }))

  await credentials.run((client) =>
    client.completeMultipartUpload(objectKey, uploadId, finalParts)
  )

  return { paused: false }
}

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------

/** 更新任务进度，OSS 阶段最多 OSS_PROGRESS_CAP。 */
const setOssProgress = (task: UploadTask, uploadedBytes: number): void => {
  if (task.size <= 0) {
    task.progress = OSS_PROGRESS_CAP
    return
  }

  task.progress = Math.min(OSS_PROGRESS_CAP, clamp01(uploadedBytes / task.size))
}

/** 根据 checkpoint 推算进度（恢复 / 暂停时使用）。 */
const progressFromCheckpoint = (
  checkpoint: UploadCheckpoint,
  size: number
): number => {
  if (checkpoint.phase === 'METADATA_PENDING') return OSS_PROGRESS_CAP

  if (size <= 0) {
    // 空文件没有分片：只要已经 init 过就说明对象已经写好了。
    return checkpoint.uploadId ? OSS_PROGRESS_CAP : 0
  }

  return Math.min(OSS_PROGRESS_CAP, clamp01(recordedBytes(checkpoint) / size))
}

// ---------------------------------------------------------------------------
// 元数据（数据库）落库
// ---------------------------------------------------------------------------

/**
 * 只补写数据库元数据。
 *
 * 前提：OSS 对象**已经完整上传成功**（task.objectUploaded === true），
 * 这里只调用 `/api/file/insert/`，不 stat 本地文件、不看当前 UI 目标目录。
 * 使用的路径 / 父目录 / 文件名全部来自任务开始时冻结的目标快照，
 * 因此**原始本地文件被删除或移动也照样能补写成功**。
 *
 * ⚠️ **刻意不接收任何 AbortSignal。**
 *
 * CompleteMultipartUpload 成功之后，OSS 对象已经完整存在，这个任务不再是
 * "可以被取消的分片上传"：剩下的只有一次极短的元数据登记。
 * 如果把它挂在 multipart 的破坏性取消信号上，用户在收尾瞬间点一次"取消上传"
 * 就会把一次**已经成功的 OSS 完成**变成语义上的"已取消上传"——
 * 对象在云端存在，`files` 表里却没有记录，用户既看不到也删不掉。
 *
 * 因此：insert 请求自己跑完，失败就保持 METADATA_PENDING，
 * 重试永远只补写元数据、绝不重传对象。要清理这种对象只能靠后端记录本身。
 */
async function insertMetadataOnly(task: UploadTask, token: string): Promise<void> {
  // 进度停在 99%，标签固定为"正在登记文件信息…"：这一步永远不重传对象。
  task.status = 'metadata_pending'
  task.progress = OSS_PROGRESS_CAP
  task.message = '正在登记文件信息…'

  try {
    await insertFileRecord({
      token,
      stringOfPath: task.targetStringOfPath,
      filename: task.targetFilename || task.name,
      parentId: task.targetParentId
    })

    task.progress = 1
    task.status = 'success'
    task.message = task.overwrite ? '已覆盖同名文件' : ''

    // 元数据已落库：checkpoint 的使命结束。删不掉也不影响本次成功，
    // 但下次启动会把这条记录当成待补写再 insert 一次，所以要重试一次。
    await deleteCheckpointSafely(task.id)
  } catch (error) {
    // 这里**没有**"被取消"这一支：对象已经在 OSS 上完整存在，
    // 任何失败（含被中断的请求）都只能停在 METADATA_PENDING。
    //
    // OSS 已经成功，只是元数据没写进去：保持 99%，
    // 重试只补写数据库、绝不重传对象。
    task.status = 'metadata_pending'
    task.objectUploaded = true
    task.progress = OSS_PROGRESS_CAP

    // 登录态失效（401/403，例如后端 tokenVersion 被提升）：
    // 明确告知会话过期，同时保留 99% 的恢复状态——重新登录后点重试只会补写元数据。
    if (isAuthFailure(error) || error instanceof TransferSessionExpiredError) {
      task.message = `${SESSION_EXPIRED_MESSAGE}；OSS 已上传，登录后重试只会补写元数据`
      return
    }

    task.message = `OSS 已上传成功，但文件元数据写入失败：${describeError(error)}`
  }
}

// ---------------------------------------------------------------------------
// checkpoint 辅助
// ---------------------------------------------------------------------------

/** 本地源身份是否与 checkpoint 记录的完全一致（路径 + 大小 + mtime）。 */
const sourceMatches = (
  source: UploadCheckpoint['source'],
  info: LocalFileInfo
): boolean =>
  source.path === info.path &&
  source.size === info.size &&
  // mtime 为 0 表示文件系统不提供：此时只比对路径与大小。
  (source.modifiedAtMs === 0 || info.modifiedAtMs === 0
    ? true
    : source.modifiedAtMs === info.modifiedAtMs)

/**
 * 把 checkpoint 落成 PAUSED。
 *
 * 没有 uploadId（还没 init）时不需要落盘：远端不存在任何需要保护的状态，
 * 内存里那条记录本来也还没进缓存。
 */
async function persistPaused(transfer: ActiveTransfer): Promise<void> {
  const { checkpoint } = transfer

  if (checkpoint.phase === 'METADATA_PENDING') return
  if (!checkpoint.uploadId) return

  checkpoint.phase = 'PAUSED'

  try {
    await saveCheckpoint(checkpoint)
  } catch {
    // 落盘失败不阻塞暂停本身：内存里的分片记录仍然完整，
    // 真正危险的是"进程已经退出 + 磁盘上没有记录"，那只会导致下次重传。
  }
}

/**
 * 本地源身份已经变化：**不能**把新旧内容拼在一起。
 *
 * 处理方式（要求 5）：
 *   ① 用**新申请**的凭证 best-effort abort 旧的 multipart；
 *   ② 删除旧 checkpoint；
 *   ③ 把任务标成"需要重新上传"，绝不假装新文件就是原来那个。
 */
async function discardStaleCheckpoint(
  task: UploadTask,
  checkpoint: UploadCheckpoint,
  detail: string
): Promise<void> {
  if (checkpoint.uploadId && checkpoint.objectKey) {
    const controller = new AbortController()

    try {
      const credentials = new TransferCredentials({
        identity: checkpoint.target,
        // abort 也必须落在**原来那个** OSS 对象上：使用 checkpoint 冻结的完整范围。
        expectedBucket: checkpoint.bucket,
        expectedRegion: checkpoint.region,
        expectedObjectKey: checkpoint.objectKey,
        getToken: getAccessToken,
        signal: controller.signal
      })

      await abortMultipartSafely(credentials, checkpoint.objectKey, checkpoint.uploadId)
    } catch {
      // best-effort：abort 失败也只是留下一个由生命周期规则清理的孤儿分片。
    }
  }

  await deleteCheckpointSafely(checkpoint.transferId)

  task.objectUploaded = false
  task.progress = 0
  task.status = 'error'
  task.message = `${detail}；旧的分片上传已丢弃，请重新上传`
}

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

/** 冻结目标快照：只在这里读一次 `uploadState.target`，之后全程使用这份副本。 */
const freezeTarget = (): UploadCheckpointTarget | null => {
  const breadcrumbs = uploadState.target
  const parentId = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1]?.id : undefined

  if (!parentId) return null

  return {
    parentId,
    stringOfPath: buildStringOfPath(breadcrumbs),
    filename: ''
  }
}

interface PreparedTransfer {
  checkpoint: UploadCheckpoint
  credentials: TransferCredentials
}

/**
 * 准备一次传输：恢复旧 checkpoint 或新建一条，并校验本地源身份。
 *
 * 返回 null 表示"已经在 task 上写好了可展示的状态，调用方直接结束"。
 */
async function prepareTransfer(
  task: UploadTask,
  run: ActiveRun
): Promise<PreparedTransfer | null> {
  const existing = getCheckpoint(task.id)

  if (existing) {
    // ---- 恢复：先校验本地源身份（要求 5）
    let info: LocalFileInfo

    try {
      info = await statLocalFile(existing.source.path)
    } catch (error) {
      // 文件被删除 / 移动 / 暂时不可读：**保留** checkpoint（非破坏性）。
      // 用户可以恢复文件后继续，或者显式取消（那才会 abort multipart）。
      task.status = 'error'
      task.progress = progressFromCheckpoint(existing, existing.source.size)
      task.message = `无法读取本地文件，暂时无法继续：${describeError(error)}`
      return null
    }

    if (!sourceMatches(existing.source, info)) {
      await discardStaleCheckpoint(
        task,
        existing,
        '本地文件已改动（路径 / 大小 / 修改时间与上传时不一致）'
      )
      return null
    }

    if (existing.ownerUsername !== task.ownerUsername) {
      // 理论上不会发生：checkpoint 是按 ownerUsername 过滤后才恢复的。
      task.status = 'error'
      task.message = '这条续传记录属于其它账号，已跳过'
      return null
    }

    task.path = info.path
    task.name = existing.source.filename
    task.size = info.size
    task.modifiedAtMs = info.modifiedAtMs

    const credentials = new TransferCredentials({
      identity: existing.target,
      // 续传：完整 OSS 范围来自磁盘上的 checkpoint，此后不可变。
      expectedBucket: existing.bucket,
      expectedRegion: existing.region,
      expectedObjectKey: existing.objectKey,
      getToken: getAccessToken,
      signal: run.controller.signal
    })

    return { checkpoint: existing, credentials }
  }

  // ---- 全新传输：在这里冻结目标快照（要求 7）
  const target = freezeTarget()

  if (!target) {
    task.status = 'error'
    task.message = '未选择目标云目录'
    return null
  }

  const info = await statLocalFile(task.path)

  throwIfStopped(run)

  task.name = info.name
  task.size = info.size
  task.path = info.path
  task.modifiedAtMs = info.modifiedAtMs

  target.filename = info.name

  return {
    checkpoint: createCheckpoint({
      transferId: task.id,
      ownerUsername: task.ownerUsername,
      source: {
        path: info.path,
        filename: info.name,
        size: info.size,
        modifiedAtMs: info.modifiedAtMs
      },
      target
    }),
    credentials: new TransferCredentials({
      identity: target,
      // 全新传输：范围还未知，由第一张有效 ticket 冻结
      //（见 executeTransfer 里把 credentials 的冻结范围抄进 checkpoint）。
      expectedBucket: '',
      expectedRegion: '',
      expectedObjectKey: '',
      getToken: getAccessToken,
      signal: run.controller.signal
    })
  }
}

/**
 * 执行一次传输：init（如需要）→ 分片 → Complete。
 *
 * 可以被调用两次：第一次遇到 NoSuchUpload 时，调用方会先把 checkpoint 重置成
 * 全新上传（丢掉旧 uploadId 与旧分片表），再用同一个 transfer 重新执行一次。
 */
async function executeTransfer(
  task: UploadTask,
  run: ActiveRun,
  transfer: ActiveTransfer
): Promise<void> {
  const { checkpoint, credentials } = transfer
  const signal = run.controller.signal

  // ① 首次（或刷新后）凭证：同目录同名覆盖提示**只在这里出现一次**，
  //    后续 STS 静默刷新不会重复弹这条提示。
  await credentials.ready()

  /**
   * 冻结完整的 OSS 范围（要求 1）。
   *
   * - **全新传输**：credentials 刚刚用第一张 ticket 冻结了 bucket / region / objectKey，
   *   这里把三者一起抄进 checkpoint；
   * - **续传**：credentials 是用 checkpoint 里的范围构造的，`ready()` 内部的
   *   `assertIdentityUnchanged()` 已经断言过两者完全一致——不一致会先抛
   *   `TransferIdentityChangedError`，根本走不到这三行。
   *
   * 也就是说这里只可能写入"同一份范围"，绝不会用新值覆盖旧 checkpoint 的范围。
   */
  checkpoint.bucket = credentials.bucket
  checkpoint.region = credentials.region
  checkpoint.objectKey = credentials.objectKey

  if (checkpoint.partSize <= 0) {
    checkpoint.partSize = PART_SIZE
  }

  const ticket = credentials.currentTicket

  if (ticket?.overwrite && !checkpoint.overwrite) {
    checkpoint.overwrite = true
    task.overwrite = true
    task.message = '目标目录已有同名文件，将覆盖'
  } else if (checkpoint.overwrite) {
    task.overwrite = true
    task.message = '目标目录已有同名文件，将覆盖'
  }

  throwIfStopped(run)

  if (task.size === 0) {
    // 空文件没有可拆分的数据，直接 put 一个空 Blob。
    await putEmptyObject(credentials, checkpoint.objectKey, signal)
    task.progress = OSS_PROGRESS_CAP
    await finishTransfer(task, transfer)
    return
  }

  // ② 没有 uploadId 才 init；续传**一定**复用保存下来的 uploadId。
  if (!checkpoint.uploadId) {
    const init = await credentials.run((client) =>
      client.initMultipartUpload(checkpoint.objectKey)
    )

    const uploadId = init?.uploadId

    if (!uploadId) {
      throw new Error('OSS 未返回 uploadId')
    }

    checkpoint.uploadId = uploadId
  }

  // ③ 要求 4：拿到 uploadId 之后、调度分片**之前**立刻落盘。
  //    这样即使进程在下一刻被杀，下一次启动也能认出这个远端 multipart。
  checkpoint.phase = 'TRANSFERRING'
  await saveCheckpoint(checkpoint)

  activeMultipart = {
    credentials,
    objectKey: checkpoint.objectKey,
    uploadId: checkpoint.uploadId
  }

  const outcome = await uploadMultipart({
    credentials,
    objectKey: checkpoint.objectKey,
    uploadId: checkpoint.uploadId,
    localPath: task.path,
    expected: { size: task.size, modifiedAtMs: task.modifiedAtMs },
    size: task.size,
    partSize: checkpoint.partSize,
    completed: checkpoint.parts,
    onPartUploaded: async () => {
      // parts 已经就地更新；这里只负责把它串行落盘。
      //
      // 刻意**不碰 phase**：暂停可能在分片还在途时就已经把 PAUSED 落盘了，
      // 晚到的分片记录只应该追加数据，绝不该把阶段改回 TRANSFERRING。
      await saveCheckpoint(checkpoint)
    },
    onBytes: (uploadedBytes) => setOssProgress(task, uploadedBytes),
    isPauseRequested: () => transfer.pauseRequested || run.pauseRequested,
    signal
  })

  activeMultipart = null

  if (outcome.paused) {
    checkpoint.phase = 'PAUSED'
    await persistPaused(transfer)

    task.status = 'paused'
    task.progress = progressFromCheckpoint(checkpoint, task.size)
    task.message = `已暂停，可继续（已完成的 ${checkpoint.parts.size} 个分片不会重传）`
    return
  }

  task.progress = OSS_PROGRESS_CAP

  await finishTransfer(task, transfer)
}

/** Complete 已经成功：先落盘 METADATA_PENDING，再写数据库。 */
async function finishTransfer(
  task: UploadTask,
  transfer: ActiveTransfer
): Promise<void> {
  const { checkpoint } = transfer

  task.objectUploaded = true
  task.status = 'metadata_pending'
  task.progress = OSS_PROGRESS_CAP
  task.message = '正在登记文件信息…'

  // 要求 13：Complete 成功之后、调用 /api/file/insert/ **之前**先落盘。
  // 这样即使紧接着崩溃，下次启动也只会补写元数据、绝不会重传对象。
  checkpoint.phase = 'METADATA_PENDING'
  checkpoint.metadataTarget = { ...checkpoint.target }

  try {
    await saveCheckpoint(checkpoint)
  } catch {
    // 落盘失败：仍然继续 insert（用户要的是文件真正出现在云端），
    // 代价只是"insert 失败 + 进程崩溃"这种极端组合下会丢掉恢复点。
  }

  const token = getAccessToken()

  if (!token) {
    task.status = 'metadata_pending'
    task.message = `${SESSION_EXPIRED_MESSAGE}；OSS 已上传，登录后重试只会补写元数据`
    return
  }

  // 刻意不传 run.controller.signal：对象已经完整存在，
  // 破坏性取消不得把这个任务变成"已取消上传"（详见 insertMetadataOnly）。
  await insertMetadataOnly(task, token)
}

/** 把 runTask 里抛出来的错误翻译成任务状态。 */
async function handleTransferError(
  task: UploadTask,
  transfer: ActiveTransfer | null,
  error: unknown
): Promise<void> {
  const checkpoint = transfer?.checkpoint ?? getCheckpoint(task.id) ?? null

  // ---- 暂停：不是错误，绝不 abort、绝不删 checkpoint
  if (error instanceof UploadPausedError) {
    if (checkpoint && checkpoint.uploadId) {
      checkpoint.phase = 'PAUSED'

      try {
        await saveCheckpoint(checkpoint)
      } catch {
        // 忽略：详见 persistPaused 的说明。
      }

      task.status = 'paused'
      task.progress = progressFromCheckpoint(checkpoint, task.size)
      task.message = '已暂停，可继续'
    } else {
      // 还没 init 就被暂停：远端没有任何状态，重新开始即可。
      task.status = 'paused'
      task.progress = 0
      task.message = '已暂停（尚未开始上传，可继续）'
    }

    return
  }

  // ---- 取消：破坏性路径。checkpoint 必须删掉，multipart 已在 worker 层 abort。
  if (error instanceof UploadCanceledError) {
    task.status = 'canceled'
    task.objectUploaded = false
    task.progress = 0
    task.message = '已取消'

    if (checkpoint) {
      await deleteCheckpointSafely(checkpoint.transferId)
    }

    return
  }

  // ---- 本地源身份在**读取过程中**被改动：丢弃 checkpoint，要求重新上传。
  if (isLocalFileChangedError(error)) {
    if (checkpoint) {
      await discardStaleCheckpoint(task, checkpoint, '上传过程中本地文件被改动')
    } else {
      task.status = 'error'
      task.progress = 0
      task.message = '上传过程中本地文件被改动，请重新上传'
    }

    return
  }

  // ---- 目标身份变化：保留 checkpoint（可重试），但本次必须停下。
  if (error instanceof TransferIdentityChangedError) {
    task.status = 'error'
    task.progress = checkpoint ? progressFromCheckpoint(checkpoint, task.size) : 0
    task.message = describeError(error)
    return
  }

  // ---- 登录态失效：不重试、不清理任何上传状态。
  if (isAuthFailure(error) || error instanceof TransferSessionExpiredError) {
    if (task.objectUploaded) {
      task.status = 'metadata_pending'
      task.progress = OSS_PROGRESS_CAP
      task.message = `${SESSION_EXPIRED_MESSAGE}；OSS 已上传，登录后重试只会补写元数据`
      return
    }

    task.status = 'error'
    task.progress = checkpoint ? progressFromCheckpoint(checkpoint, task.size) : 0
    task.message = SESSION_EXPIRED_MESSAGE
    return
  }

  /**
   * ---- 可恢复的传输失败（网络中断 / 超时 / 5xx / 单分片重试预算耗尽）
   *
   * 关键行为变化：**不再 abort multipart**。checkpoint 与已完成分片全部保留，
   * 任务落在"可恢复错误"上，用户点继续就从记录的断点接着传。
   * 只有显式取消、本地源身份变化、明确不可恢复的任务失效才会销毁旧 multipart。
   */
  task.status = 'error'
  task.progress = checkpoint ? progressFromCheckpoint(checkpoint, task.size) : 0

  if (checkpoint && checkpoint.uploadId) {
    checkpoint.phase = 'PAUSED'

    try {
      await saveCheckpoint(checkpoint)
    } catch {
      // 忽略：内存里仍有完整的分片记录。
    }

    task.message = `${describeError(error)}（进度已保留，可继续）`
    return
  }

  task.message = describeError(error)
}

async function runTask(task: UploadTask, run: ActiveRun): Promise<void> {
  const token = getAccessToken()

  if (!token) {
    task.status = 'error'
    task.message = SESSION_EXPIRED_MESSAGE
    return
  }

  // 特殊分支：OSS 已经完整上传、只是数据库没落库 —— **只补 insert**。
  //
  //    刻意做在 stat 本地文件与读取当前 UI 目标之前：
  //      - 本地文件可能已经被删除 / 移动，那不应该妨碍补写元数据；
  //      - 用户可能已经改了目标目录，但那也不该导致"重新上传一遍"，
  //        否则原来那个已经完整上传、没有 DB 记录的 OSS object 会被永久遗留。
  //    所以一律使用任务开始时冻结的目标快照。
  if (task.objectUploaded) {
    // 同样不接破坏性取消信号：这条分支只补写元数据。
    run.currentTask = task

    try {
      await insertMetadataOnly(task, token)
    } finally {
      if (run.currentTask === task) run.currentTask = null
    }

    return
  }

  task.status = 'uploading'
  task.message = ''
  run.currentTask = task

  let transfer: ActiveTransfer | null = null

  try {
    throwIfStopped(run)

    const prepared = await prepareTransfer(task, run)

    if (!prepared) return

    transfer = {
      task,
      checkpoint: prepared.checkpoint,
      credentials: prepared.credentials,
      pauseRequested: false
    }

    // task.id 在恢复场景下就是 checkpoint 的 transferId；这里再对齐一次，
    // 保证"任务的 id ≡ checkpoint 的 transferId"这条不变式永远成立。
    task.id = prepared.checkpoint.transferId
    task.targetParentId = prepared.checkpoint.target.parentId
    task.targetStringOfPath = prepared.checkpoint.target.stringOfPath
    task.targetFilename = prepared.checkpoint.target.filename
    task.overwrite = prepared.checkpoint.overwrite
    task.progress = progressFromCheckpoint(prepared.checkpoint, task.size)

    run.transfer = transfer

    try {
      await executeTransfer(task, run, transfer)
    } catch (error) {
      // OSS 明确告诉我们 uploadId 已经不存在（被 abort / 被生命周期规则清理）：
      // 丢掉旧 checkpoint，重新 init 一个 multipart，**从头干净地重传**。
      // 绝不允许把旧的 completed parts 带到新的 uploadId 上。
      if (isOssNoSuchUpload(error) && prepared.checkpoint.uploadId) {
        await resetCheckpointForFreshUpload(prepared.checkpoint, PART_SIZE)

        task.progress = 0
        task.message = '远端分片任务已失效，正在重新上传…'

        activeMultipart = null

        await executeTransfer(task, run, transfer)
        return
      }

      throw error
    }
  } catch (error) {
    await handleTransferError(task, transfer, error)
  } finally {
    if (run.currentTask === task) {
      run.currentTask = null
    }

    if (run.transfer === transfer) {
      run.transfer = null
    }

    if (transfer && activeMultipart?.uploadId === transfer.checkpoint.uploadId) {
      activeMultipart = null
    }
  }
}

// ---------------------------------------------------------------------------
// 队列操作
// ---------------------------------------------------------------------------

/** 设置当前目标云目录（上传进行中不允许切换；已经开始的传输永远用它自己的冻结快照）。 */
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
        (task.status === 'pending' ||
          task.status === 'uploading' ||
          task.status === 'paused' ||
          task.status === 'pausing')
    )

    if (duplicated) continue

    try {
      const info = await statLocalFile(path)

      // 这次 stat 属于上一个账号会话：结果必须整体丢弃，不能推进 B 的任务列表。
      if (generation !== uploadSessionGeneration) return result

      uploadState.tasks.push({
        id: createTransferId(),
        path: info.path,
        name: info.name,
        size: info.size,
        modifiedAtMs: info.modifiedAtMs,
        // 记下创建者账号（只记账号名，不记令牌）：
        // 会话切换时靠它判断这个恢复任务还能不能留。
        ownerUsername: getCurrentUsername(),
        status: 'pending',
        progress: 0,
        message: '',
        overwrite: false,
        objectUploaded: false,
        targetStringOfPath: '',
        targetParentId: 0,
        targetFilename: ''
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
 * 从 checkpoint 恢复一个任务（**不校验本地文件**）。
 *
 * METADATA_PENDING 的任务即使本地文件已经被删除 / 移动也必须恢复：
 * OSS 对象已经完整存在，此时本地源已经不再必要。
 */
const taskFromCheckpoint = (checkpoint: UploadCheckpoint): UploadTask => {
  const metadataPending = checkpoint.phase === 'METADATA_PENDING'
  // METADATA_PENDING 用记录里自带的落库快照；其余阶段用冻结的传输目标。
  const target = metadataPending
    ? (checkpoint.metadataTarget ?? checkpoint.target)
    : checkpoint.target

  return {
    id: checkpoint.transferId,
    path: checkpoint.source.path,
    name: checkpoint.source.filename,
    size: checkpoint.source.size,
    modifiedAtMs: checkpoint.source.modifiedAtMs,
    ownerUsername: checkpoint.ownerUsername,
    status: metadataPending ? 'metadata_pending' : 'paused',
    progress: progressFromCheckpoint(checkpoint, checkpoint.source.size),
    message: metadataPending
      ? '正在登记文件信息…（可重试，不会重传文件）'
      : '上次未传完，已暂停，可继续',
    overwrite: checkpoint.overwrite,
    objectUploaded: metadataPending,
    targetStringOfPath: target.stringOfPath,
    targetParentId: target.parentId,
    targetFilename: target.filename
  }
}

/**
 * 加载并恢复**当前账号**的续传任务。
 *
 * 只由上传窗口调用：
 *   - 主窗口的任务列表永远是空的，让它去写会把上传窗口的状态覆盖掉；
 *   - checkpoint 按 ownerUsername 过滤，**绝不**把上一个账号的传输状态暴露给新账号。
 *
 * 恢复出来的任务一律是 paused / metadata_pending，**不会自动开始**——
 * 是否继续由用户决定。
 *
 * 返回恢复出来的任务数。
 */
export async function restoreUploadCheckpoints(): Promise<number> {
  const username = getCurrentUsername()

  if (!username) return 0

  const generation = uploadSessionGeneration

  await loadCheckpoints()

  if (generation !== uploadSessionGeneration) return 0

  const restored: UploadTask[] = []

  for (const checkpoint of listCheckpointsForOwner(username)) {
    if (uploadState.tasks.some((task) => task.id === checkpoint.transferId)) continue

    restored.push(taskFromCheckpoint(checkpoint))
  }

  if (restored.length === 0) return 0

  uploadState.tasks.push(...restored)

  return restored.length
}

/**
 * 上一次加载 checkpoint 时是否出现过损坏 / 读取失败。
 *
 * 损坏的记录会被整条丢弃（绝不猜测字段含义），因此界面应该明确告诉用户
 * "有一部分续传记录没能恢复，需要重新上传"，而不是静默地少几个任务。
 */
export const checkpointsRestoreFailed = (): boolean => checkpointLoadFailed()

/**
 * 这个任务是否"OSS 已成功但数据库还没落库"。
 *
 * 这种任务不能被悄悄丢掉：丢掉它等于把一个已经存在于 OSS、
 * 却在 `files` 表里没有记录的对象永久遗留（用户看不到、也删不掉）。
 * 因此它只能 Retry（补写元数据），不能 Remove / Clear。
 */
export const isMetadataPendingTask = (task: UploadTask): boolean =>
  task.objectUploaded && task.status !== 'success'

/**
 * 破坏性清理一个任务：best-effort abort multipart + 删除 checkpoint。
 *
 * **只有显式取消 / 放弃任务才会调用它**——暂停与正常退出绝不走这里。
 */
async function destroyTransfer(task: UploadTask): Promise<void> {
  const checkpoint = getCheckpoint(task.id)

  if (checkpoint && checkpoint.uploadId && checkpoint.objectKey) {
    const controller = new AbortController()

    try {
      const credentials = new TransferCredentials({
        identity: checkpoint.target,
        // 破坏性清理同样只能命中 checkpoint 冻结的那一个 OSS 对象。
        expectedBucket: checkpoint.bucket,
        expectedRegion: checkpoint.region,
        expectedObjectKey: checkpoint.objectKey,
        getToken: getAccessToken,
        signal: controller.signal
      })

      await abortMultipartSafely(credentials, checkpoint.objectKey, checkpoint.uploadId)
    } catch {
      // best-effort：失败也只是留下由 OSS 生命周期规则清理的分片。
    }
  }

  await deleteCheckpointSafely(task.id)

  task.objectUploaded = false
}

/** 移除一个任务（上传中的任务、以及元数据待补写的任务都不允许移除）。 */
export function removeTask(taskId: string): void {
  const index = uploadState.tasks.findIndex((task) => task.id === taskId)

  if (index < 0) return

  const task = uploadState.tasks[index]

  if (
    task.status === 'uploading' ||
    task.status === 'pausing' ||
    isMetadataPendingTask(task)
  ) {
    return
  }

  uploadState.tasks.splice(index, 1)

  // 有 checkpoint 的任务必须先做破坏性清理，否则 OSS 上会留下一个
  // 永远没人认领的 multipart（用户以为文件已经"移除"了）。
  void destroyTransfer(task)
}

/**
 * 把一个失败 / 取消 / 已暂停的任务重新排队（"继续"按钮）。
 *
 * 对 METADATA_PENDING 的任务，这只是"补写元数据"的重试：runTask 会走
 * insertMetadataOnly 分支，绝不重新上传对象。
 */
export function resumeTask(taskId: string): void {
  const task = uploadState.tasks.find((item) => item.id === taskId)

  if (!task || task.status === 'uploading' || task.status === 'pausing') return

  if (isMetadataPendingTask(task)) {
    task.status = 'metadata_pending'
    task.message = '正在登记文件信息…'
    task.progress = OSS_PROGRESS_CAP
    return
  }

  task.status = 'pending'
  task.message = ''
}

/**
 * 清空已结束（完成 / 失败 / 取消）的任务。
 *
 * - "OSS 已成功但元数据待补写"的任务会被保留：丢掉它等于永久遗留一个
 *   OSS 上存在、`files` 表里却没有记录的对象。这类任务只能 Retry。
 * - 被清掉的失败任务如果还有 checkpoint，先做一次破坏性清理，避免留下孤儿 multipart。
 */
export function clearFinishedTasks(): void {
  for (let index = uploadState.tasks.length - 1; index >= 0; index -= 1) {
    const task = uploadState.tasks[index]

    if (
      task.status === 'uploading' ||
      task.status === 'pausing' ||
      task.status === 'pending' ||
      task.status === 'paused'
    ) {
      continue
    }

    if (isMetadataPendingTask(task)) continue

    uploadState.tasks.splice(index, 1)

    void destroyTransfer(task)
  }
}

/** 清空整个列表，但同样保留"元数据待补写"的任务与正在上传/暂停中的任务。 */
export function clearAllTasks(): void {
  if (uploadState.running) return

  for (let index = uploadState.tasks.length - 1; index >= 0; index -= 1) {
    const task = uploadState.tasks[index]

    if (isMetadataPendingTask(task)) continue
    if (task.status === 'paused' || task.status === 'pausing') continue

    uploadState.tasks.splice(index, 1)

    void destroyTransfer(task)
  }
}

// ---------------------------------------------------------------------------
// 运行控制：开始 / 暂停 / 继续 / 取消
// ---------------------------------------------------------------------------

/**
 * 开始（或继续）上传：文件串行，单文件内部 3 个分片并行。
 *
 * 队列里包含 pending / paused / error / canceled / metadata_pending 的任务；
 * 每次运行都会新建 AbortController，**只有显式取消才会 abort 它**。
 */
export async function startUpload(): Promise<void> {
  if (uploadState.running) return

  const queue = uploadState.tasks.filter((task) => RESUMABLE_STATUSES.has(task.status))

  if (queue.length === 0) return

  const controller = new AbortController()

  const run: ActiveRun = {
    controller,
    pauseRequested: false,
    transfer: null,
    currentTask: null,
    canceledTaskIds: new Set<string>()
  }

  activeRun = run
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
        if (run.pauseRequested) break

        // 队列是开跑之前捕获的快照：等待期间用户可能已经取消 / 移除了其中某个任务，
        // 也可能已经替换成别的批次。此时**绝不能**再启动它。
        if (run.canceledTaskIds.has(task.id)) continue
        if (!uploadState.tasks.includes(task)) continue

        await runTask(task, run)

        // 暂停是"停在这一批的安全边界"：本轮不再开始下一个文件，
        // 剩下的任务保持原状（pending 的还没落任何 checkpoint）。
        if (run.pauseRequested) break
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
    //   - runningPromise 置空、activeRun 释放
    uploadState.running = false
    runningPromise = null

    if (activeRun === run) {
      activeRun = null
    }
  }
}

/**
 * 同步置位"暂停请求"。
 *
 * 刻意不落盘、不 await：调用方（会话切换）需要它在**任何 await 之前**生效，
 * 否则新会话可能已经初始化了自己的状态，却被这次清理抹掉。
 *
 * 返回当前活动传输（需要落盘 PAUSED 时使用）。
 */
function requestPauseSync(): ActiveTransfer | null {
  const run = activeRun

  if (!run) return null

  const transfer = run.transfer

  /**
   * 当前文件已经过了 Complete 这条线：没有可暂停的东西
   * （OSS 对象已经完整存在，剩下的只是一次极短的元数据登记）。
   *
   * 此时**不打断元数据请求**，但可以把这一批解释成"登记完就停下"：
   * 置位 pauseRequested 让队列循环在这一步之后退出。
   * UI 在同样情况下也不会显示"暂停"按钮，这里是服务层的独立保证。
   */
  if (isFinalizingMetadata(run)) {
    run.pauseRequested = true
    return null
  }

  run.pauseRequested = true

  if (!transfer) return null

  transfer.pauseRequested = true

  if (transfer.task.status === 'uploading') {
    transfer.task.status = 'pausing'
    transfer.task.message = '正在暂停…'
  }

  return transfer
}

/**
 * 暂停上传（**不是取消**）。
 *
 * 为什么不用 `client.cancel()`：
 *   已确认本地安装的 ali-oss 6.23.0 里 `client.cancel()`（lib/common/parallel.js）
 *   只做两件事——置 `options.cancelFlag = true`、销毁 `multipartUploadStreams`
 *   （那是 Node 流式上传才有的东西）。它**不会**中断浏览器端已经发出的 XHR：
 *   本项目的 `uploadPart` 走的是 `urllib.request`，没有 cancelFlag 检查，
 *   也没有任何 abort 通道。也就是说 `cancel()` 对"让暂停更跟手"毫无帮助，
 *   反而会永久污染这个 client 的 cancelFlag。
 *
 *   所以这里选方案 A：让至多 3 个在途分片请求自然跑到安全边界，
 *   每个成功返回的分片照常记录并落盘；没有在途请求时立即停止调度。
 *
 * 暂停的正确性不依赖"服务端是否多了一个未记录的分片"：
 * 下次 Resume 会对本地没有记录的分片号重传，这是幂等且安全的。
 */
export async function pauseUploads(): Promise<void> {
  const transfer = requestPauseSync()

  if (!transfer) return

  await persistPaused(transfer)
}

/**
 * 显式取消上传（**破坏性**）。
 *
 *   1. 阻止新分片被调度（abort signal）；
 *   2. 立刻发起一次 best-effort AbortMultipartUpload（不必等在途分片返回）；
 *   3. 等 worker 真正退出；
 *   4. 收尾再 abort 一次（清掉"第一次 abort 之后才完成"的分片）；
 *   5. 删除本地 checkpoint；
 *   6. 按既有 UX 把任务标记为已取消。
 *
 * 注意语义：第 2 步只是"尽早发出清理请求"，**不保证**在途分片立刻终止
 * （HTTP 请求无法强制中断）。真正的收尾在 multipart 的取消路径里完成
 * （abort -> Promise.allSettled(workers) -> 再次 abort）。
 *
 * ---- METADATA_PENDING 边界（要求 2）
 *
 * 如果当前文件已经走完 CompleteMultipartUpload（任务处于 `metadata_pending`），
 * 那么它**已经没有 multipart 可以取消了**，剩下的只是一次元数据登记：
 *
 *   - 不 abort 这一轮的 AbortController（那没有意义，也会打断别的东西）；
 *   - 不调用 AbortMultipartUpload；
 *   - 不删除它的 checkpoint；
 *   - 只置位 `run.pauseRequested`，让这一批在**元数据落库之后**停下，
 *     不再开始下一个文件。
 *
 * 其余 pending / paused / error 的任务照旧走破坏性取消。
 */
export async function cancelUpload(): Promise<void> {
  const run = activeRun
  const transfer = run?.transfer ?? null

  /** 当前文件是否只剩"登记元数据"这一步（详见 isFinalizingMetadata）。 */
  const finalizingMetadata = isFinalizingMetadata(run)

  if (run) {
    if (finalizingMetadata) {
      // 只停止调度：批处理在这一步之后退出，当前元数据请求不受影响。
      run.pauseRequested = true
    } else if (!run.controller.signal.aborted) {
      run.controller.abort()
    }
  }

  if (!finalizingMetadata) {
    // 不 await：立刻发起、后台完成，绝不阻塞调用方（取消/退出都要保持有界）。
    void abortActiveMultipartNow()
  }

  const cleanups: Array<Promise<void>> = []

  for (const task of uploadState.tasks) {
    if (isMetadataPendingTask(task)) {
      // OSS 对象已经完整存在：取消它等于制造一个没有 DB 记录的孤儿对象，
      // 而且会把一次**已经成功的 OSS 完成**说成"已取消上传"。
      // 这类任务只能"重试补写元数据"，不能取消。
      continue
    }

    if (transfer && task === transfer.task) {
      // 当前正在跑的那一个：由 runTask 自己的取消/收尾路径负责（含 abort 与删 checkpoint）。
      continue
    }

    if (task.status === 'uploading' || task.status === 'pausing') {
      // 理论上不会出现（同一时刻只有一个活动传输），保险起见也交给它自己的收尾路径。
      continue
    }

    if (task.status === 'pending' || task.status === 'paused' || task.status === 'error') {
      task.status = 'canceled'
      task.progress = 0
      task.message = '已取消'

      // 队列是开跑之前捕获的快照：记下来，保证它之后不会被重新启动。
      run?.canceledTaskIds.add(task.id)

      cleanups.push(destroyTransfer(task))
    }
  }

  await Promise.all(cleanups)
}

/** 取消单个任务（破坏性；与"暂停"严格区分）。 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = uploadState.tasks.find((item) => item.id === taskId)

  if (!task) return

  // 元数据待补写的任务不能被取消：那会留下一个用户看不到、也删不掉的 OSS 对象。
  if (isMetadataPendingTask(task)) return

  if (task.status === 'uploading' || task.status === 'pausing') {
    // 它是当前运行中的任务：abort 这一轮（worker 会走破坏性清理路径）。
    const run = activeRun

    if (run && !run.controller.signal.aborted) {
      run.controller.abort()
    }

    void abortActiveMultipartNow()

    return
  }

  task.status = 'canceled'
  task.progress = 0
  task.message = '已取消'

  // 它可能还在本轮捕获的队列里等着被启动：记下来，绝不能再开始它。
  activeRun?.canceledTaskIds.add(task.id)

  await destroyTransfer(task)
}

/** 让一个已暂停 / 失败的任务重新排队（等价于"继续"）。 */
export const retryTask = resumeTask

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

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
 * 对暂停/退出路径来说这完全可以接受：checkpoint 已经落盘，
 * 带着在途分片退出也不会破坏续传的正确性。
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
 * **语义变化**：以前这里是"取消上传"（abort multipart），现在改成"暂停"。
 * 登录态变化既不是用户显式取消，也不是任务失效，没有任何理由销毁一个
 * 已经传了一半的 multipart——按仓库的破坏性清理约定，只有
 * 显式取消 / 本地源身份变化 / 明确不可恢复的失效才允许 abort。
 *
 * 顺序很重要：
 *   ① 同步置位暂停请求并**立即**重算 tasks 与 target（都在任何 await 之前），
 *      否则新会话可能已经初始化了自己的状态，却被这次清理抹掉；
 *   ② 再把 PAUSED 落盘；
 *   ③ 最后对上一会话的上传做有界等待。
 *
 * 保留规则（**只保留仍然属于当前/刚离开账号的恢复类任务**）：
 *   - 普通任务一律清掉（与之前一致）；
 *   - "元数据待补写"的任务即使跨登出也要留下，否则会遗留无记录的 OSS 对象；
 *   - paused / pausing 的任务代表磁盘上真实存在的 checkpoint，留下它们，
 *     账号切回来时还能继续（checkpoint 本身也按 ownerUsername 过滤）。
 *
 * 第 ③ 步**不再**清 tasks/target：那时新会话可能已经加载了自己的 root。
 * 被移出界面的任务对象仍被 worker 持有（startUpload 捕获了任务引用），
 * 它们会照常走完暂停 / 清理流程，不影响收尾。
 */
async function resetUploadStateForSessionChange(change: SessionChange): Promise<void> {
  // 先让代际号前进：所有在途的异步操作（addPaths 等）从此刻起一律失效。
  uploadSessionGeneration += 1

  // ① 同步暂停（不 abort、不删 checkpoint）。
  const transferToPersist = requestPauseSync()

  // ② 立即重算任务列表与目标目录——必须在第一个 await 之前。
  const hadTasks = uploadState.tasks.length > 0

  // 登出时 currentUsername 为空串：此时保留"刚离开的那个账号"的恢复任务，
  // 等它重新登录后还能继续 / 补写元数据；换账号时保留的是新账号自己的任务。
  const keepUsername = change.currentUsername || change.previousUsername

  const keptTasks = uploadState.tasks.filter(
    (task) =>
      task.ownerUsername === keepUsername &&
      (isMetadataPendingTask(task) ||
        task.status === 'paused' ||
        task.status === 'pausing')
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

  // ③ 把 PAUSED 落到磁盘，再有界等待上一会话的上传收尾。
  if (transferToPersist) {
    await persistPaused(transferToPersist)
  }

  await waitForUploadIdleBounded(UPLOAD_CLEANUP_TIMEOUT_MS)
}

// 账号被清空 / 更换账号 / 重新登录时自动暂停或保留，避免状态跨账号泄漏。
onSessionChanged((change) => {
  void resetUploadStateForSessionChange(change)
})

/**
 * 窗口卸载时调用：**暂停**进行中的上传并释放引用。
 *
 * 卸载上传窗口不等于用户取消上传：暂停后 multipart 与 checkpoint 都还在，
 * 重新打开上传窗口就能继续。
 */
export function disposeUpload(): void {
  void pauseUploads()
  activeMultipart = null
}
