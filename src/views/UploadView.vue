<script setup lang="ts">
/**
 * 独立上传窗口。
 *
 * 数据来源只有两条，且都汇聚到同一个 UploadService：
 *   1) 首页点 Upload：Rust `queue_upload_paths` 入队 → 显示本窗口 → mount 时 take 走；
 *   2) Explorer 右键：single-instance callback 入队 → 显示本窗口 → 同样 take 走。
 *
 * 事件只做"有新内容了"的通知，真正的数据始终在 Rust 侧队列里，
 * 因此不存在"listener 尚未初始化导致路径丢失"的问题。
 *
 * 断点续传：本窗口 mount 时会从 `upload-checkpoints.json` 恢复**当前账号**的
 * 未完成任务（paused / METADATA_PENDING）。恢复出来的任务一律不会自动开始，
 * 由用户决定继续还是放弃。
 *
 * 关闭窗口 / 应用退出 = **暂停**，不是取消：multipart 与 checkpoint 全部保留，
 * 下次打开（或下次启动）还能继续。只有显式点"取消上传"才是破坏性操作。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm as confirmDialog, open as openDialog } from '@tauri-apps/plugin-dialog'

import Breadcrumbs from '../components/Breadcrumbs.vue'
import DirectoryPicker from '../components/DirectoryPicker.vue'
import UploadItem from '../components/UploadItem.vue'
import { UPLOAD_CLEANUP_TIMEOUT_MS } from '../config'
import { fetchRoot, isAuthFailure } from '../services/api'
import { getAccessToken, logout, onSessionChanged } from '../services/auth'
import {
  confirmExitReady,
  setUploadBatchBusy,
  takePendingUploadPaths,
  takeUploadTargetHint
} from '../services/filesystem'
import {
  addPaths,
  cancelTask,
  cancelUpload,
  checkpointsRestoreFailed,
  clearFinishedTasks,
  disposeUpload,
  getUploadSessionGeneration,
  pauseUploads,
  removeTask,
  restoreUploadCheckpoints,
  resumeTask,
  setUploadTarget,
  startUpload,
  uploadOverallProgress,
  uploadState,
  waitForUploadIdleBounded
} from '../services/upload'
import {
  EVENT_PREPARE_EXIT,
  EVENT_UPLOAD_PENDING,
  EVENT_UPLOAD_TARGET
} from '../services/events'
import type { Breadcrumb, UploadStatus } from '../types'
import { formatBytes, formatPercent } from '../utils/format'
import { createListenerRegistry } from '../utils/listeners'

const pickerOpen = ref(false)
const preparingExit = ref(false)
const pausing = ref(false)
const cancelling = ref(false)
const errorMessage = ref('')
const hintMessage = ref('')

const tasks = computed(() => uploadState.tasks)

/** 能"继续上传"的任务：暂停 / 可恢复错误 / 已取消 / 元数据待补写。 */
const RESUMABLE_STATUSES: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  'pending',
  'paused',
  'error',
  'canceled',
  'metadata_pending'
])

const hasResumable = computed(() =>
  uploadState.tasks.some((task) => RESUMABLE_STATUSES.has(task.status))
)

const canUpload = computed(() => !uploadState.running && hasResumable)

/** 有 paused 任务时，"取消上传"才是需要单独暴露的破坏性动作。 */
const hasDestructible = computed(() =>
  uploadState.tasks.some((task) => task.status === 'paused')
)

const hasFinished = computed(() =>
  uploadState.tasks.some(
    (task) =>
      task.status === 'success' ||
      task.status === 'error' ||
      task.status === 'canceled'
  )
)

const primaryLabel = computed(() => {
  if (uploadState.running) return '上传中…'
  if (uploadState.tasks.some((task) => task.status === 'paused')) return '继续上传'
  if (hasResumable.value) return '继续上传'
  return 'Upload'
})

const targetSize = computed(() =>
  uploadState.tasks.reduce((sum, task) => sum + Math.max(task.size, 1), 0)
)

const uploadedSize = computed(() =>
  uploadState.tasks.reduce(
    (sum, task) => sum + Math.max(task.size, 1) * Math.min(1, Math.max(0, task.progress)),
    0
  )
)

const initializeTarget = async (): Promise<void> => {
  if (uploadState.target.length > 0) return

  // 捕获发起请求时的令牌：这次请求的结果只允许应用于**同一个**账号会话。
  const token = getAccessToken()

  if (!token) return

  try {
    const snapshot = await fetchRoot(token)

    // 应用结果前必须同时满足：
    // 组件未销毁、令牌没变（没有换账号）、目标仍为空、且没有上传在跑。
    // 否则一个在账号 A 下发出的 root 请求会污染账号 B 的目标目录。
    if (
      disposed ||
      getAccessToken() !== token ||
      uploadState.target.length > 0 ||
      uploadState.running
    ) {
      return
    }

    setUploadTarget([{ id: snapshot.rootId, name: 'root' }])
  } catch (error) {
    // 这个结果属于上一个账号 / 组件已销毁：
    // 既不能写错误提示，更不能把**新**账号登出。
    if (disposed || getAccessToken() !== token) return

    if (isAuthFailure(error)) {
      await logout()
      return
    }

    errorMessage.value = `无法读取根目录：${
      error instanceof Error ? error.message : '未知错误'
    }`
  }
}

/**
 * 恢复本账号的续传任务（paused / METADATA_PENDING）。
 *
 * 放在目标目录初始化之后：恢复出来的任务用的是它自己冻结的目标快照，
 * 与当前浏览目录无关，但界面先有目录更符合用户预期。
 */
const restoreCheckpoints = async (): Promise<void> => {
  const generation = getUploadSessionGeneration()

  try {
    const restored = await restoreUploadCheckpoints()

    if (disposed || generation !== getUploadSessionGeneration()) return

    if (restored > 0) {
      hintMessage.value = `已恢复 ${restored} 个未完成的上传任务，可以继续或取消`
    }

    if (checkpointsRestoreFailed()) {
      errorMessage.value =
        '部分续传记录已损坏并被丢弃（相关文件需要重新上传），其余任务不受影响。'
    }
  } catch {
    // 恢复失败只影响"能不能续传"，不影响新上传。
  }
}

/** 取走 Rust 侧待上传队列（mount 时主动调用，也由事件触发再次调用）。 */
const consumePending = async (): Promise<void> => {
  const generation = getUploadSessionGeneration()

  try {
    const paths = await takePendingUploadPaths()

    if (paths.length === 0) return

    // 取队列期间换了账号：这批路径属于上一个会话，直接丢弃，
    // 绝不能推进新账号的任务列表。
    if (disposed || generation !== getUploadSessionGeneration()) return

    const result = await addPaths(paths)

    // 组件已经卸载 / 会话已切换：不要再写状态
    //（上传队列本身在模块级 state 里，不受影响）。
    if (disposed || generation !== getUploadSessionGeneration()) return

    if (result.failed.length > 0) {
      errorMessage.value = result.failed
        .map((item) => `${item.path}（${item.reason}）`)
        .join('；')
    }

    await initializeTarget()
  } catch (error) {
    if (disposed || generation !== getUploadSessionGeneration()) return

    errorMessage.value =
      error instanceof Error ? error.message : '读取待上传列表失败'
  }
}

const consumeTargetHint = async (): Promise<void> => {
  const generation = getUploadSessionGeneration()

  try {
    const hint = await takeUploadTargetHint()

    // 读取期间换了账号：这个提示属于上一个会话，丢弃。
    if (disposed || generation !== getUploadSessionGeneration()) return

    if (hint && hint.breadcrumbs.length > 0) {
      setUploadTarget(hint.breadcrumbs)
    }
  } catch {
    // 目标目录建议只是锦上添花，失败不影响上传。
  }
}

// 退出登录 / 换账号会把目标目录清空（见 upload.ts 的会话清理）：
// 这时必须重新加载**本账号**的 root，绝不能沿用上一个账号的目录 ID。
//
// 同时监听 running：目标被清空时上一会话的上传可能还在收尾，
// 而 setUploadTarget() 在上传进行中会被忽略——所以要等它变成 idle 再初始化。
watch(
  [() => uploadState.target.length, () => uploadState.running],
  ([targetLength, running]) => {
    if (disposed || targetLength > 0 || running) return

    void initializeTarget()
  }
)

/**
 * 把"这一批是否已被占用"同步给 Rust。
 *
 * 只要列表里还有**没成功的任务**（待上传 / 上传中 / 已暂停 / 失败 / 已取消，
 * 含只差补写元数据的），就算占用中——这样首页不会在前一批还没处理完时再开一批、
 * 让两批共用同一个全局目标目录。
 *
 * 只有上传窗口会写这个状态（首页只读），避免主窗口的空列表把它清掉。
 */
watch(
  () => uploadState.tasks.some((task) => task.status !== 'success'),
  (busy) => {
    void setUploadBatchBusy(busy)
  },
  { immediate: true }
)

const handleAddFiles = async (): Promise<void> => {
  errorMessage.value = ''

  // 打开系统文件对话框之前先捕获会话代际号：对话框可能停留很久，
  // 期间账号可能被换掉，那时这次选择必须整批丢弃。
  const generation = getUploadSessionGeneration()

  let selected: string | string[] | null = null

  try {
    selected = await openDialog({
      multiple: true,
      directory: false,
      title: '选择要上传的文件'
    })
  } catch (error) {
    if (disposed || generation !== getUploadSessionGeneration()) return

    errorMessage.value = error instanceof Error ? error.message : '无法打开文件选择器'
    return
  }

  // 对话框期间换了账号 / 组件已销毁：丢弃这次选择。
  if (disposed || generation !== getUploadSessionGeneration()) return

  if (!selected) return

  const paths = Array.isArray(selected) ? selected : [selected]

  if (paths.length === 0) return

  // addPaths 内部也有同样的代际守卫，这里再检查一次是为了不写脏 errorMessage。
  const result = await addPaths(paths)

  if (disposed || generation !== getUploadSessionGeneration()) return

  if (result.failed.length > 0) {
    errorMessage.value = result.failed
      .map((item) => `${item.path}（${item.reason}）`)
      .join('；')
  }
}

const handleUpload = async (): Promise<void> => {
  errorMessage.value = ''
  hintMessage.value = ''

  try {
    await startUpload()
  } catch (error) {
    // 活动状态登记失败时 startUpload 会 fail closed：不上传，并在这里给用户明确提示。
    errorMessage.value =
      error instanceof Error ? error.message : '无法开始上传，请稍后重试'
    return
  }

  if (disposed) return

  if (!errorMessage.value) {
    const failed = uploadState.tasks.filter((task) => task.status === 'error').length
    const paused = uploadState.tasks.filter((task) => task.status === 'paused').length

    if (failed === 0 && uploadState.tasks.every((task) => task.status === 'success')) {
      hintMessage.value = '全部文件上传完成'
    } else if (paused > 0) {
      hintMessage.value = `${paused} 个文件已暂停，可以继续`
    } else if (failed > 0) {
      hintMessage.value = `${failed} 个文件上传中断，进度已保留，可继续`
    }
  }
}

/** 暂停：保留 uploadId 与已完成分片，**绝不** abort multipart。 */
const handlePause = async (): Promise<void> => {
  if (pausing.value) return

  pausing.value = true
  hintMessage.value = '正在暂停上传，已完成的进度会保留…'

  try {
    await pauseUploads()
  } catch {
    // 暂停本身不会失败（落盘失败也只是少一个恢复点）。
  }

  const idle = await waitForIdle(UPLOAD_CLEANUP_TIMEOUT_MS)

  if (disposed) return

  pausing.value = false
  hintMessage.value = idle
    ? '已暂停，可随时继续'
    : '正在等在途分片收尾，进度已经保存，可随时继续'
}

/** 破坏性取消：abort multipart + 删除本地 checkpoint。 */
const handleCancel = async (): Promise<void> => {
  if (cancelling.value) return

  let confirmed = false

  try {
    confirmed = await confirmDialog(
      '取消上传会中止未完成的分片上传，并删除本地续传记录（已上传的部分将被丢弃）。确定取消吗？',
      {
        title: '取消上传',
        kind: 'warning',
        okLabel: '取消上传',
        cancelLabel: '继续上传'
      }
    )
  } catch {
    confirmed = false
  }

  if (!confirmed || disposed) return

  cancelling.value = true

  try {
    await cancelUpload()
    await waitForIdle(UPLOAD_CLEANUP_TIMEOUT_MS)
  } finally {
    if (!disposed) {
      cancelling.value = false
    }
  }
}

const handleSelectTarget = (breadcrumbs: Breadcrumb[]): void => {
  setUploadTarget(breadcrumbs)
  pickerOpen.value = false
}

/**
 * 单条任务的"暂停"。
 *
 * 同一时刻只有一个文件在传（串行队列），所以它与窗口级的暂停是同一件事：
 * 停在当前文件的安全边界，已完成的分片与 uploadId 全部保留。
 */
const handleTaskPause = async (): Promise<void> => {
  await handlePause()
}

/**
 * 单条任务的"取消上传"（破坏性）。
 *
 * 只对**暂停中**的任务暴露：它会 abort 这个任务残留的 multipart 并删除 checkpoint。
 * 正在上传的任务必须走窗口级的"取消上传"，因为中断在途 worker 只有一个信号源。
 */
const handleTaskCancel = async (taskId: string): Promise<void> => {
  let confirmed = false

  try {
    confirmed = await confirmDialog(
      '取消这一项会中止它的分片上传并删除本地续传记录，已上传的部分将被丢弃。确定吗？',
      {
        title: '取消上传',
        kind: 'warning',
        okLabel: '取消上传',
        cancelLabel: '保留'
      }
    )
  } catch {
    confirmed = false
  }

  if (!confirmed || disposed) return

  await cancelTask(taskId)
}

/**
 * 等待上传真正结束，返回是否在超时前结束。
 *
 * 注意语义：返回 false 只表示"超时了，任务还在收尾"，
 * 绝不能把它当成"上传已经停止"。
 */
const waitForIdle = (timeoutMs: number): Promise<boolean> =>
  waitForUploadIdleBounded(timeoutMs)

/** 隐藏上传窗口（非 Tauri 环境下忽略）。 */
const hideUploadWindow = async (): Promise<void> => {
  try {
    await getCurrentWindow().hide()
  } catch {
    // 非 Tauri 环境：忽略。
  }
}

const listeners = createListenerRegistry()

/** 组件卸载后不再写任何状态，也不发起新的请求。 */
let disposed = false

/** 会话订阅（换账号时重新恢复本账号的续传记录）。 */
let unsubscribeSession: (() => void) | null = null

/**
 * 退出前清场：**暂停**上传（不 abort multipart）-> 有界等待 -> 回报 ready。
 *
 * 关键点：
 *   - 暂停会先把 checkpoint 落盘，因此即使进程带着在途分片退出，
 *     下次启动也能从这个断点继续；
 *   - 等待是**有界**的：绝不为了等在途请求而让关机卡到 OSS 的 180 秒超时；
 *   - Rust 侧本身还有 EXIT_CLEANUP_TIMEOUT_MS 兜底，这里失败不会卡住退出。
 */
const handlePrepareExit = async (): Promise<void> => {
  preparingExit.value = true

  try {
    await pauseUploads()
  } catch {
    // 暂停失败也不能让退出流程卡住：checkpoint 在分片成功时就已落盘。
  }

  await waitForIdle(UPLOAD_CLEANUP_TIMEOUT_MS)

  try {
    await confirmExitReady()
  } catch {
    // 通知失败也无妨：Rust 侧超时后会照常退出。
  }
}

/**
 * 关闭上传窗口：**暂停**并只隐藏不销毁，保证上传状态不丢。
 *
 * 顺序严格是：请求暂停 -> 有界等待收尾 -> 隐藏。
 * 关闭窗口不是取消：multipart 与 checkpoint 都保留着，重新打开就能继续。
 */
const handleCloseRequested = async (event: {
  preventDefault: () => void
}): Promise<void> => {
  event.preventDefault()

  // 已经在收尾：重复点关闭不做任何事，避免重复暂停/重复隐藏。
  if (cancelling.value || pausing.value) return

  const hasPendingWork = uploadState.tasks.some((task) => task.status !== 'success')

  if (uploadState.running) {
    let confirmed = false

    try {
      confirmed = await confirmDialog(
        '上传正在进行。关闭窗口会暂停上传并保留已完成的分片，下次打开可以继续。确定吗？',
        {
          title: '暂停上传',
          kind: 'warning',
          okLabel: '暂停并关闭',
          cancelLabel: '继续上传'
        }
      )
    } catch {
      confirmed = false
    }

    if (!confirmed || disposed) return
  }

  if (!uploadState.running && !hasPendingWork) {
    // 没有进行中的上传：直接隐藏。
    await hideUploadWindow()
    return
  }

  pausing.value = true

  try {
    await pauseUploads()
    await waitForIdle(UPLOAD_CLEANUP_TIMEOUT_MS)
  } catch {
    // 暂停失败也直接隐藏：checkpoint 已经落盘，续传正确性不受影响。
  }

  if (disposed) return

  pausing.value = false
  await hideUploadWindow()
}

onMounted(async () => {
  // 先注册 listener，再主动 take，两者结合可以同时覆盖"窗口还在加载"与"窗口已就绪"。
  await listeners.track(
    listen(EVENT_UPLOAD_PENDING, () => {
      void consumePending()
    })
  )

  // 目标目录建议同样是"事件只做通知，数据统一 take"：
  // 若直接使用 event.payload，Rust 侧的 slot 永远不会被清空，
  // 上一个账号留下的 hint 会在下一次 mount 时被重新取出来。
  await listeners.track(
    listen(EVENT_UPLOAD_TARGET, () => {
      void consumeTargetHint()
    })
  )

  // 主窗口退出前会广播这个事件：本窗口负责**暂停**上传并回报清理完成。
  await listeners.track(
    listen(EVENT_PREPARE_EXIT, () => {
      void handlePrepareExit()
    })
  )

  try {
    await listeners.track(getCurrentWindow().onCloseRequested(handleCloseRequested))
  } catch {
    // 非 Tauri 环境（直接用浏览器跑 vite dev）：忽略。
  }

  // 换账号：上一个账号的任务已被 upload.ts 清掉，这里只恢复新账号自己的续传记录。
  unsubscribeSession = onSessionChanged(() => {
    if (disposed) return

    void restoreCheckpoints()
  })

  if (disposed) return

  await initializeTarget()

  if (disposed) return

  await restoreCheckpoints()

  if (disposed) return

  await consumeTargetHint()

  if (disposed) return

  await consumePending()
})

onUnmounted(() => {
  disposed = true

  unsubscribeSession?.()
  unsubscribeSession = null

  listeners.dispose()
  disposeUpload()
})

</script>

<template>
  <div class="upload">
    <header class="upload__header">
      <div class="upload__target">
        <span class="upload__label">目标云目录</span>
        <Breadcrumbs :items="uploadState.target" :disabled="uploadState.running" />
      </div>
      <button
        class="btn btn--small"
        type="button"
        :disabled="uploadState.running"
        @click="pickerOpen = true"
      >
        更改目录
      </button>
    </header>

    <p v-if="preparingExit" class="alert alert--warning upload__alert">
      应用正在退出：正在暂停上传并保存进度，下次启动可以继续…
    </p>
    <p v-else-if="pausing" class="alert alert--warning upload__alert">
      正在暂停上传，已完成的进度会保留…
    </p>
    <p v-else-if="cancelling" class="alert alert--warning upload__alert">
      正在取消上传并清理未完成的分片，请稍候…
    </p>
    <p v-if="errorMessage" class="alert alert--error upload__alert">{{ errorMessage }}</p>
    <p v-if="hintMessage" class="alert alert--info upload__alert">{{ hintMessage }}</p>

    <main class="upload__body">
      <p v-if="tasks.length === 0" class="upload__empty">
        还没有待上传文件。<br />
        可以点下方“添加文件”，或从首页 / 资源管理器右键把文件发过来。
      </p>

      <ul v-else class="upload__items">
        <UploadItem
          v-for="task in tasks"
          :key="task.id"
          :task="task"
          @pause="handleTaskPause"
          @resume="resumeTask"
          @cancel="handleTaskCancel"
          @remove="removeTask"
        />
      </ul>
    </main>

    <footer class="upload__footer">
      <div class="upload__overall">
        <div class="upload__overall-text">
          <span>{{ formatPercent(uploadOverallProgress) }}</span>
          <span class="upload__overall-bytes">
            {{ formatBytes(Math.round(uploadedSize)) }} / {{ formatBytes(Math.round(targetSize)) }}
          </span>
        </div>
        <div class="progress">
          <div
            class="progress__bar"
            :style="{ width: `${Math.round(uploadOverallProgress * 100)}%` }"
          />
        </div>
      </div>

      <div class="upload__actions">
        <button
          class="btn btn--small"
          type="button"
          :disabled="uploadState.running"
          @click="handleAddFiles"
        >
          添加文件
        </button>
        <button
          v-if="hasFinished"
          class="btn btn--small"
          type="button"
          :disabled="uploadState.running"
          @click="clearFinishedTasks"
        >
          清除已结束
        </button>
        <button
          v-if="uploadState.running"
          class="btn btn--small"
          type="button"
          :disabled="pausing"
          @click="handlePause"
        >
          暂停
        </button>
        <button
          v-if="uploadState.running || hasDestructible"
          class="btn btn--danger btn--small"
          type="button"
          :disabled="cancelling"
          @click="handleCancel"
        >
          取消上传
        </button>
        <button
          class="btn btn--primary btn--small"
          type="button"
          :disabled="!canUpload"
          @click="handleUpload"
        >
          {{ primaryLabel }}
        </button>
      </div>
    </footer>

    <DirectoryPicker
      :open="pickerOpen"
      :current="uploadState.target"
      @close="pickerOpen = false"
      @select="handleSelectTarget"
    />
  </div>
</template>

<style scoped>
.upload {
  display: flex;
  height: 100%;
  flex-direction: column;
}

.upload__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.upload__target {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.upload__label {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.upload__alert {
  margin: 8px 12px 0;
}

.upload__body {
  flex: 1;
  overflow: auto;
  padding: 10px 12px;
}

.upload__empty {
  margin: 40px 0 0;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.8;
  text-align: center;
}

.upload__items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.upload__footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 12px 11px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.upload__overall-text {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: var(--text-muted);
  font-size: 11px;
}

.upload__overall-bytes {
  color: var(--text-faint);
}

.progress {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-muted);
}

.progress__bar {
  height: 100%;
  border-radius: 999px;
  background: var(--primary);
  transition: width 160ms ease;
}

.upload__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
</style>
