/**
 * 断点续传 checkpoint 的持久化层。
 *
 * 设计要点：
 *
 * 1. **独立 Store 文件**（`upload-checkpoints.json`），与 auth.json / settings.json 完全分开。
 *    传输状态与登录信息的生命周期不同，混在一起会让"清登录态"顺手毁掉续传记录。
 *
 * 2. **绝不持久化任何凭据**：没有 JWT、没有 AccessKey ID / Secret、没有 SecurityToken。
 *    STS 只在内存里活着（见 transfer-credentials.ts），重启后重新申请即可。
 *
 * 3. **本地 PartNumber + ETag 是唯一事实来源**。
 *    完成合并时只使用这里记录的分片列表，绝不从 `ListParts` 反推：
 *    ListParts 是服务端视角，它可能包含"上一次崩溃前已经成功、但本地还没来得及记录"
 *    的分片，而本地记录里没有它——两者混用会得到一个来源不明的分片列表。
 *    本地缺哪个分片号，重传那一个分片号永远比信任未经验证的 ListParts 结果更安全。
 *
 * 4. **写入串行化**：3 个分片 worker 会并发更新同一条记录。所有落盘都经过
 *    单条 Promise 链排队，并且真正写入时**重新读取当前内存缓存**（不是调用时刻的快照），
 *    因此后完成的分片绝不会覆盖先完成分片刚写下的 ETag。
 *
 * 5. **损坏即丢弃**：读不出来 / 结构不合法 / schema 版本不认识 → 整条记录丢掉。
 *    丢掉只会让那个文件重新传一遍；错误地解释它则可能用一份不完整的 ETag 列表
 *    Complete 出一个损坏的对象。
 */

import { load, type Store } from '@tauri-apps/plugin-store'

import {
  UPLOAD_CHECKPOINT_SCHEMA_VERSION,
  UPLOAD_CHECKPOINT_STORE_FILE,
  UPLOAD_CHECKPOINT_STORE_KEY
} from '../config'

/** 持久化阶段：只有这三个是"有意义"的断点。 */
export type UploadCheckpointPhase = 'TRANSFERRING' | 'PAUSED' | 'METADATA_PENDING'

/** 本地源身份快照：路径 + 大小 + mtime。 */
export interface UploadCheckpointSource {
  /** stat_local_file 返回的规范绝对路径。 */
  path: string
  /** 原始文件名。 */
  filename: string
  size: number
  /** epoch 毫秒；0 表示文件系统不提供。 */
  modifiedAtMs: number
}

/** 冻结的传输目标快照：STS / multipart / insert 全程共用这一份。 */
export interface UploadCheckpointTarget {
  parentId: number
  stringOfPath: string
  filename: string
}

/** 一个已完成分片的本地记录。 */
export interface UploadCheckpointPart {
  partNumber: number
  etag: string
  size: number
}

/** 落盘形态（parts 是数组，JSON 友好）。 */
export interface StoredUploadCheckpoint {
  schemaVersion: number
  transferId: string
  ownerUsername: string
  source: UploadCheckpointSource
  target: UploadCheckpointTarget
  /** 冻结的 OSS objectKey（刷新 STS 时必须保持一致）。 */
  objectKey: string
  /** 空串表示"还没 init"。 */
  uploadId: string
  partSize: number
  parts: UploadCheckpointPart[]
  phase: UploadCheckpointPhase
  /**
   * METADATA_PENDING 专用的目标快照。
   *
   * Complete 成功那一刻把 target 原样抄一份：这条记录接下来唯一的用途就是
   * 调用 `/api/file/insert/`，它必须自带完整的落库参数——**不能**依赖任何
   * 运行时状态（当前目录、本地文件是否还在、任务对象是否还在内存里）。
   */
  metadataTarget?: UploadCheckpointTarget
  /** 后端 same_file_name 的覆盖语义；只用于提示，不影响 objectKey。 */
  overwrite: boolean
  createdAtMs: number
  updatedAtMs: number
}

/** 内存形态：parts 用 Map，便于并发 upsert 与 O(1) 查重。 */
export interface UploadCheckpoint extends Omit<StoredUploadCheckpoint, 'parts'> {
  parts: Map<number, UploadCheckpointPart>
}

let storePromise: Promise<Store> | null = null

/** 内存缓存：transferId -> checkpoint。整个应用只有这一份权威副本。 */
const cache = new Map<string, UploadCheckpoint>()

/** 是否已经从磁盘读过一次（避免重复 IO，也避免把未落盘的改动覆盖掉）。 */
let loaded = false
let loadPromise: Promise<void> | null = null

/**
 * 读取失败（文件损坏 / 权限问题 / 非 Tauri 环境）时的标记。
 *
 * 只用于"要不要告诉用户"，不改变上面的 fail-safe 行为：
 * 读不到就等于没有 checkpoint，一切从头开始。
 */
let loadFailed = false

const getStore = (): Promise<Store> => {
  if (!storePromise) {
    storePromise = load(UPLOAD_CHECKPOINT_STORE_FILE, { autoSave: false }).catch(
      (error) => {
        // 不要缓存失败的 Promise：下次调用可以重试。
        storePromise = null
        throw error
      }
    )
  }

  return storePromise
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isPositiveInt = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value > 0

const isSource = (value: unknown): value is UploadCheckpointSource => {
  if (typeof value !== 'object' || value === null) return false

  const source = value as Record<string, unknown>

  return (
    isNonEmptyString(source.path) &&
    isNonEmptyString(source.filename) &&
    isFiniteNumber(source.size) &&
    source.size >= 0 &&
    isFiniteNumber(source.modifiedAtMs)
  )
}

const isTarget = (value: unknown): value is UploadCheckpointTarget => {
  if (typeof value !== 'object' || value === null) return false

  const target = value as Record<string, unknown>

  return (
    isPositiveInt(target.parentId) &&
    isNonEmptyString(target.stringOfPath) &&
    isNonEmptyString(target.filename)
  )
}

const isPart = (value: unknown): value is UploadCheckpointPart => {
  if (typeof value !== 'object' || value === null) return false

  const part = value as Record<string, unknown>

  return (
    isPositiveInt(part.partNumber) &&
    isNonEmptyString(part.etag) &&
    isPositiveInt(part.size)
  )
}

/**
 * 校验一条落盘记录。
 *
 * 刻意"宁缺毋滥"：任何一个字段不合法就丢掉整条记录。
 * 一份"大部分可用"的 ETag 列表是最危险的东西——它足以让 Complete 通过校验，
 * 却合成出一个内容错误的对象。
 */
const isValidStored = (value: unknown): value is StoredUploadCheckpoint => {
  if (typeof value !== 'object' || value === null) return false

  const record = value as Record<string, unknown>

  if (record.schemaVersion !== UPLOAD_CHECKPOINT_SCHEMA_VERSION) return false
  if (!isNonEmptyString(record.transferId)) return false
  // ownerUsername 允许为空串（理论上不会发生），但必须是字符串。
  if (typeof record.ownerUsername !== 'string') return false
  if (!isSource(record.source)) return false
  if (!isTarget(record.target)) return false
  if (!isNonEmptyString(record.objectKey)) return false
  // uploadId 允许为空（刚冻结目标、还没 init）。
  if (typeof record.uploadId !== 'string') return false
  if (!isPositiveInt(record.partSize)) return false
  if (!Array.isArray(record.parts)) return false
  if (!record.parts.every(isPart)) return false

  if (
    record.phase !== 'TRANSFERRING' &&
    record.phase !== 'PAUSED' &&
    record.phase !== 'METADATA_PENDING'
  ) {
    return false
  }

  // metadataTarget 是可选的；一旦存在就必须合法。
  if (record.metadataTarget !== undefined && !isTarget(record.metadataTarget)) {
    return false
  }

  // METADATA_PENDING 必须自带落库参数，否则重启后无法只补写元数据。
  if (record.phase === 'METADATA_PENDING' && !record.metadataTarget) {
    return false
  }

  // METADATA_PENDING 必须已经有完整对象：没有 uploadId 却处于该阶段是自相矛盾的记录。
  if (record.phase === 'METADATA_PENDING' && record.parts.length === 0) {
    // 空文件走的不是 multipart（没有分片，也没有 uploadId），因此这里只要求
    // "有 uploadId 就必须有分片"，反之不成立。
    if (isNonEmptyString(record.uploadId)) return false
  }

  // 分片号不得超过 OSS 上限，且不能重复。
  const seen = new Set<number>()

  for (const part of record.parts as UploadCheckpointPart[]) {
    if (part.partNumber > 10000) return false
    if (seen.has(part.partNumber)) return false
    seen.add(part.partNumber)
  }

  return true
}

const toMemory = (record: StoredUploadCheckpoint): UploadCheckpoint => ({
  ...record,
  parts: new Map(record.parts.map((part) => [part.partNumber, { ...part }]))
})

const toStored = (checkpoint: UploadCheckpoint): StoredUploadCheckpoint => ({
  schemaVersion: UPLOAD_CHECKPOINT_SCHEMA_VERSION,
  transferId: checkpoint.transferId,
  ownerUsername: checkpoint.ownerUsername,
  source: { ...checkpoint.source },
  target: { ...checkpoint.target },
  objectKey: checkpoint.objectKey,
  uploadId: checkpoint.uploadId,
  partSize: checkpoint.partSize,
  parts: [...checkpoint.parts.values()]
    .map((part) => ({ ...part }))
    .sort((left, right) => left.partNumber - right.partNumber),
  phase: checkpoint.phase,
  metadataTarget: checkpoint.metadataTarget
    ? { ...checkpoint.metadataTarget }
    : undefined,
  overwrite: checkpoint.overwrite,
  createdAtMs: checkpoint.createdAtMs,
  updatedAtMs: checkpoint.updatedAtMs
})

/**
 * 落盘写队列。
 *
 * 所有写操作排在同一条链上，保证：
 *   - 不会出现两个 `set` / `save` 交错；
 *   - 真正写入时读的是**当前**缓存，而不是排队时刻的快照。
 */
let writeChain: Promise<unknown> = Promise.resolve()
let lastWriteError: unknown = null

async function flush(): Promise<void> {
  const store = await getStore()

  const payload: Record<string, StoredUploadCheckpoint> = {}

  for (const [transferId, checkpoint] of cache) {
    payload[transferId] = toStored(checkpoint)
  }

  await store.set(UPLOAD_CHECKPOINT_STORE_KEY, payload)
  await store.save()
}

/**
 * 把当前缓存整体落盘（串行）。
 *
 * 返回的 Promise 只代表**这一次**写入的结果：暂停 / 退出路径需要 `await` 它，
 * 确认 checkpoint 真的落到磁盘上了再放行。内部的链本身永远不会因为一次失败而
 * 变成 rejected（否则后续所有写入都会被连带跳过）。
 */
export function persistCheckpoints(): Promise<void> {
  const run = writeChain.then(flush, flush)

  writeChain = run.then(
    () => {
      lastWriteError = null
    },
    (error) => {
      lastWriteError = error
    }
  )

  return run
}

/** 最近一次落盘失败的原因（没有失败时为 null）；调用方据此决定是否提示用户。 */
export const getLastPersistError = (): unknown => lastWriteError

/** 从磁盘加载一次（幂等）。读失败时按"没有 checkpoint"处理。 */
export async function loadCheckpoints(): Promise<void> {
  if (loaded) return

  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const store = await getStore()
        const raw = await store.get<unknown>(UPLOAD_CHECKPOINT_STORE_KEY)

        if (raw === undefined || raw === null) {
          loadFailed = false
          return
        }

        if (typeof raw !== 'object' || Array.isArray(raw)) {
          // 结构不认识：整份丢掉，绝不猜测。
          loadFailed = true
          return
        }

        let dropped = 0

        for (const [transferId, value] of Object.entries(
          raw as Record<string, unknown>
        )) {
          if (!isValidStored(value) || value.transferId !== transferId) {
            dropped += 1
            continue
          }

          cache.set(transferId, toMemory(value))
        }

        loadFailed = dropped > 0
      } catch {
        // 读失败：当作没有任何断点。孤儿分片最终由 OSS 生命周期规则清理。
        loadFailed = true
      } finally {
        loaded = true
      }
    })()
  }

  try {
    await loadPromise
  } finally {
    // 失败也允许下次重新尝试加载（但 loaded 已置位时不会再进这里）。
    if (!loaded) {
      loadPromise = null
    }
  }
}

/** 上一次加载是否出现过损坏 / 读取失败（界面可以据此给一句提示）。 */
export const checkpointLoadFailed = (): boolean => loadFailed

/** 取一条记录（内存缓存）。 */
export const getCheckpoint = (transferId: string): UploadCheckpoint | undefined =>
  cache.get(transferId)

/** 全部记录（只读用途）。 */
export const listCheckpoints = (): UploadCheckpoint[] => [...cache.values()]

/** 某个账号名下的记录。**跨账号绝不互相暴露。** */
export const listCheckpointsForOwner = (ownerUsername: string): UploadCheckpoint[] =>
  [...cache.values()].filter((checkpoint) => checkpoint.ownerUsername === ownerUsername)

/** 新建一条内存记录（不落盘；调用方在 init 之后才持久化）。 */
export function createCheckpoint(options: {
  transferId: string
  ownerUsername: string
  source: UploadCheckpointSource
  target: UploadCheckpointTarget
}): UploadCheckpoint {
  const now = Date.now()

  return {
    schemaVersion: UPLOAD_CHECKPOINT_SCHEMA_VERSION,
    transferId: options.transferId,
    ownerUsername: options.ownerUsername,
    source: { ...options.source },
    target: { ...options.target },
    objectKey: '',
    uploadId: '',
    partSize: 0,
    parts: new Map(),
    phase: 'TRANSFERRING',
    overwrite: false,
    createdAtMs: now,
    updatedAtMs: now
  }
}

/**
 * 写入 / 更新一条记录并落盘。
 *
 * 传入的 checkpoint **就是**缓存里的那个对象（调用方持有引用并就地修改），
 * 因此这里不需要做任何合并：flush 时读到的天然是包含所有 worker 最新成果的状态。
 */
export async function saveCheckpoint(checkpoint: UploadCheckpoint): Promise<void> {
  checkpoint.updatedAtMs = Date.now()
  cache.set(checkpoint.transferId, checkpoint)

  await persistCheckpoints()
}

/**
 * 丢掉一条记录。
 *
 * 显式取消、本地源身份变化、Complete 成功之后调用。
 * 注意：**Pause 与正常退出绝不调用它**。
 */
export async function deleteCheckpoint(transferId: string): Promise<void> {
  if (!cache.delete(transferId)) return

  await persistCheckpoints()
}

/**
 * 把一个 checkpoint 重置成"全新上传"。
 *
 * 只用于 OSS 明确告诉我们 uploadId 已经不存在（NoSuchUpload / 生命周期清理）的场景。
 * 语义上等价于"丢掉旧 checkpoint，重新 init 一个 multipart"：
 * **绝不允许把旧的 completed parts 带到新的 uploadId 上**。
 */
export async function resetCheckpointForFreshUpload(
  checkpoint: UploadCheckpoint,
  partSize: number
): Promise<void> {
  checkpoint.uploadId = ''
  checkpoint.parts.clear()
  checkpoint.partSize = partSize
  checkpoint.phase = 'TRANSFERRING'

  await saveCheckpoint(checkpoint)
}

/** 已记录分片的总字节数（用于恢复进度显示）。 */
export const recordedBytes = (checkpoint: UploadCheckpoint): number => {
  let total = 0

  for (const part of checkpoint.parts.values()) {
    total += part.size
  }

  return total
}

/** 仅用于测试 / 调试：清空内存缓存（不影响磁盘）。 */
export const __resetCheckpointCacheForTests = (): void => {
  cache.clear()
  loaded = false
  loadPromise = null
  loadFailed = false
}
