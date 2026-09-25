/**
 * 任务级 OSS 凭证 / 客户端管理器。
 *
 * 一个传输任务（transferId）持有一个实例，它知道这次传输**不可变**的身份：
 *
 *   parentId + stringOfPath + filename  → 申请 STS 时用（目标快照，绝不读当前界面目录）
 *   bucket + region + objectKey         → 第一次申请时冻结，之后每次刷新都必须一致
 *
 * 职责：
 *   1. 在每次需要授权的 OSS 请求之前，确认当前凭证**距离过期还有 60 秒以上**
 *      （后端 STS 寿命 900 秒，见 config::STS_REFRESH_SAFETY_MARGIN_MS）；
 *   2. 需要刷新时静默调用现有的 `/api/oss/sts/`，拿到新凭证后**新建**一个 OSS client。
 *      client 换了不会改变 multipart 的身份：objectKey 与 uploadId 都保持不变；
 *   3. **去重**：3 个分片 worker 同时发现凭证快过期时，只会发出一次 STS 请求，
 *      它们 await 的是同一个 in-flight Promise；
 *   4. OSS 因为凭证失效返回 403/401 时，强制刷新一次并**重试同一个操作一次**。
 *
 * 安全约束（与仓库既有约定一致）：
 *   - STS 凭证**只存在于内存**，绝不进 checkpoint、绝不进事件、绝不写日志；
 *   - 凭证只交给 ali-oss 的构造参数，不拼进任何 URL 或自定义头。
 */

import { OSS_TIMEOUT_MS, STS_REFRESH_SAFETY_MARGIN_MS } from '../config'
import { ApiError, isAuthFailure, requestUploadTicket } from './api'
import { UploadCanceledError } from './upload-errors'
import type { UploadTicket } from '../types'

type OssClient = import('ali-oss').default

/** 无法申请 STS：当前没有有效的登录令牌。 */
export class TransferSessionExpiredError extends Error {
  constructor() {
    super('登录状态已失效，请重新登录')
    this.name = 'TransferSessionExpiredError'
  }
}

/**
 * 刷新回来的凭证与最初冻结的身份不一致。
 *
 * 出现它意味着后端对同一个 (parentId, stringOfPath, filename) 给出了**不同**的
 * objectKey / bucket / region。绝不能拿旧 uploadId 去新对象上继续传：
 * 那会在错误的位置留下一个残缺对象。此时保留 checkpoint（可重试），
 * 但本次传输必须停下。
 */
export class TransferIdentityChangedError extends Error {
  constructor(detail: string) {
    super(`上传目标已变化，已停止本次传输：${detail}`)
    this.name = 'TransferIdentityChangedError'
  }
}

interface OssLikeError {
  name?: string
  code?: string
  message?: string
  status?: number
  statusCode?: number
  response?: { status?: number }
  res?: { status?: number }
}

const OSS_CREDENTIAL_ERROR_CODES = new Set([
  'SecurityTokenExpired',
  'InvalidAccessKeyId',
  'InvalidAccessKeyId.NotFound',
  'InvalidSecurityToken',
  'SecurityTokenMalformed',
  'AccessDenied'
])

/**
 * 这个 OSS 错误是否属于"凭证问题"（值得强制刷新一次再试）。
 *
 * 只认明确的错误码或 HTTP 401/403。业务错误（NoSuchUpload、EntityTooSmall……）
 * 不在这里，因为它们刷新凭证也不会变好。
 */
export const isOssCredentialError = (error: unknown): boolean => {
  if (error instanceof TransferSessionExpiredError) return true
  if (error instanceof TransferIdentityChangedError) return false
  // 后端接口的认证失败（tokenVersion 失效）由 upload.ts 单独处理，不在这里重试。
  if (isAuthFailure(error)) return false

  if (typeof error !== 'object' || error === null) return false

  const candidate = error as OssLikeError

  if (candidate.code && OSS_CREDENTIAL_ERROR_CODES.has(candidate.code)) return true

  const status = Number(
    candidate.status ?? candidate.statusCode ?? candidate.response?.status ?? candidate.res?.status
  )

  return status === 401 || status === 403
}

/** OSS 明确表示这个 uploadId 已经不存在（被 abort / 被生命周期规则清理）。 */
export const isOssNoSuchUpload = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as OssLikeError

  if (candidate.code === 'NoSuchUpload') return true

  const status = Number(
    candidate.status ?? candidate.statusCode ?? candidate.response?.status ?? candidate.res?.status
  )

  return status === 404 && !isOssCredentialError(error)
}

export interface TransferIdentity {
  parentId: number
  stringOfPath: string
  filename: string
}

export interface TransferCredentialsOptions {
  identity: TransferIdentity
  /** 已知的 objectKey（来自 checkpoint）；空串表示"这次是全新传输，等第一次申请"。 */
  expectedObjectKey: string
  /** 每次都重新读取，绝不缓存 JWT。 */
  getToken: () => string
  /** 申请 STS 时使用的中断信号（取消上传时立刻放弃在途请求）。 */
  signal: AbortSignal
}

export class TransferCredentials {
  private readonly identity: TransferIdentity
  private readonly getToken: () => string
  private readonly signal: AbortSignal

  private ticket: UploadTicket | null = null
  private client: OssClient | null = null

  private frozenObjectKey: string
  private frozenBucket = ''
  private frozenRegion = ''

  /** 同一个任务的刷新去重：3 个 worker 共享同一个 Promise。 */
  private refreshPromise: Promise<void> | null = null

  /**
   * 凭证代际号：每成功刷新一次 +1。
   *
   * 它是"强制刷新"去重的关键：一个 worker 拿到的 403 只有在**它用的那份凭证
   * 仍然是当前凭证**时才值得再申请一次 STS。如果失败返回时代际号已经前进
   * （说明别的 worker 刚换过凭证），直接用新的那份重试即可，不必重复申请。
   *
   * 这比"按时间冷却"精确：它不会因为"刚刷新过"就拒绝一次真正需要的刷新，
   * 也不会因为"刷新已经过去几秒"就放出多次并发 STS 请求。
   */
  private generation = 0

  constructor(options: TransferCredentialsOptions) {
    this.identity = options.identity
    this.getToken = options.getToken
    this.signal = options.signal
    this.frozenObjectKey = options.expectedObjectKey
  }

  /** 冻结的 objectKey（第一次申请之后就有值）。 */
  get objectKey(): string {
    return this.frozenObjectKey
  }

  /** 当前内存中的凭证（只读用途；**绝不**持久化）。 */
  get currentTicket(): UploadTicket | null {
    return this.ticket
  }

  private isExpiringSoon(): boolean {
    if (!this.ticket) return true

    return this.ticket.expirationMs - Date.now() <= STS_REFRESH_SAFETY_MARGIN_MS
  }

  /**
   * 拿到一个"距离过期还有安全余量"的 client。
   *
   * `force = true` 表示"上一个请求被 OSS 判为凭证失效"，此时即使本地认为还没过期
   * 也要换一份。3 个 worker 同时撞上凭证过期时，只有第一个真的去申请 STS：
   * 其余两个要么 join 同一个 in-flight 刷新，要么发现代际号已经前进而直接复用新 client。
   */
  private async ensureClient(force: boolean): Promise<OssClient> {
    if (!force && this.client && !this.isExpiringSoon()) {
      return this.client
    }

    if (this.refreshPromise) {
      // 已经有一次刷新在路上：所有人共享它。
      await this.refreshPromise
      return this.requireClient()
    }

    const pending = this.performRefresh()
    this.refreshPromise = pending

    try {
      await pending
    } finally {
      if (this.refreshPromise === pending) {
        this.refreshPromise = null
      }
    }

    return this.requireClient()
  }

  private requireClient(): OssClient {
    if (!this.client) {
      throw new Error('OSS 客户端尚未就绪')
    }

    return this.client
  }

  private async performRefresh(): Promise<void> {
    const token = this.getToken()

    if (!token) {
      // 登录态已经没了：重试多少次都一样，交给上层按"会话过期"处理。
      throw new TransferSessionExpiredError()
    }

    // 取消上传时不要把在途的 STS 请求留到最后才失败。
    if (this.signal.aborted) {
      throw new UploadCanceledError()
    }

    const ticket = await requestUploadTicket({
      token,
      stringOfPath: this.identity.stringOfPath,
      filename: this.identity.filename,
      parentId: this.identity.parentId,
      signal: this.signal
    })

    this.assertIdentityUnchanged(ticket)

    // 先建好新 client 再替换：中途失败时旧 client 仍然可用（会以它自己的过期时间为准）。
    const client = await createOssClient(ticket)

    this.ticket = ticket
    this.client = client
    this.generation += 1
  }

  /**
   * 校验刷新回来的凭证仍然指向同一个对象。
   *
   * bucket / region 在第一次申请时冻结；objectKey 在续传时来自 checkpoint，
   * 因此这里能挡住"后端换了 bucket"或"objectKey 规则变了"这类情况。
   */
  private assertIdentityUnchanged(ticket: UploadTicket): void {
    if (!this.frozenObjectKey) {
      this.frozenObjectKey = ticket.objectKey
      this.frozenBucket = ticket.bucket
      this.frozenRegion = ticket.region
      return
    }

    if (ticket.objectKey !== this.frozenObjectKey) {
      throw new TransferIdentityChangedError('objectKey 发生变化')
    }

    if (this.frozenBucket && ticket.bucket !== this.frozenBucket) {
      throw new TransferIdentityChangedError('bucket 发生变化')
    }

    if (this.frozenRegion && ticket.region !== this.frozenRegion) {
      throw new TransferIdentityChangedError('region 发生变化')
    }
  }

  /**
   * 执行一个需要授权的 OSS 操作。
   *
   * 凭证失效（403/401）时最多**强制刷新一次**并重试同一个操作一次：
   * 刷新凭证不会改变 uploadId，所以重试是安全的（UploadPart / Complete 都是幂等的
   * ——同一个 partNumber 重传只会覆盖它自己）。
   *
   * 去重规则：只有当"失败时用的那份凭证仍然是当前凭证"（代际号没变）才真的去申请 STS。
   * 如果代际号已经前进，说明别的 worker 刚刚换过凭证，直接用它重试即可——
   * 这正是 3 个 worker 同时收到 403 时不会打出 3 次 STS 请求的原因。
   */
  async run<T>(operation: (client: OssClient) => Promise<T>): Promise<T> {
    const client = await this.ensureClient(false)
    const generation = this.generation

    try {
      return await operation(client)
    } catch (error) {
      if (!isOssCredentialError(error)) throw error

      if (this.generation === generation) {
        await this.ensureClient(true)
      }

      return await operation(this.requireClient())
    }
  }

  /** 立刻确保有一份可用凭证（用于 best-effort abort 这类一次性操作）。 */
  async ready(): Promise<OssClient> {
    return this.ensureClient(false)
  }
}

/** 按需加载 ali-oss，避免主页 bundle 里塞进整个 SDK。 */
export async function createOssClient(ticket: UploadTicket): Promise<OssClient> {
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

/** 后端接口层的认证失败（JWT 失效）与任务级会话过期统一判定。 */
export const isTransferAuthFailure = (error: unknown): boolean =>
  error instanceof TransferSessionExpiredError || isAuthFailure(error)

export { ApiError }
