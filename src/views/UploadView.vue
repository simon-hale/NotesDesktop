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
import { getAccessToken, logout } from '../services/auth'
import {
  confirmExitReady,
  setUploadBatchBusy,
  takePendingUploadPaths,
  takeUploadTargetHint
} from '../services/filesystem'
import {
  addPaths,
  cancelUpload,
  clearAllTasks,
  clearFinishedTasks,
  disposeUpload,
  getUploadSessionGeneration,
  removeTask,
  retryTask,
  setUploadTarget,
  startUpload,
  uploadOverallProgress,
  uploadState,
  waitForUploadIdle,
  waitForUploadIdleBounded
} from '../services/upload'
import {
  EVENT_PREPARE_EXIT,
  EVENT_UPLOAD_PENDING,
  EVENT_UPLOAD_TARGET
} from '../services/events'
import type { Breadcrumb } from '../types'
import { formatBytes, formatPercent } from '../utils/format'
import { createListenerRegistry } from '../utils/listeners'

const pickerOpen = ref(false)
const preparingExit = ref(false)
const errorMessage = ref('')
const hintMessage = ref('')

const tasks = computed(() => uploadState.tasks)

const canUpload = computed(
  () =>
    !uploadState.running &&
    uploadState.tasks.some(
      (task) =>
        task.status === 'pending' ||
        task.status === 'error' ||
        task.status === 'canceled'
    )
)

const hasFinished = computed(() =>
  uploadState.tasks.some(
    (task) =>
      task.status === 'success' ||
      task.status === 'error' ||
      task.status === 'canceled'
  )
)

const cancelLabel = computed(() =>
  uploadState.running ? '取消上传' : '清空列表'
)

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
 * 只要列表里还有**没成功的任务**（待上传 / 上传中 / 失败 / 已取消，含只差补写元数据的），
 * 就算占用中——这样首页不会在前一批还没处理完时再开一批、
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

  if (!errorMessage.value) {
    const failed = uploadState.tasks.filter((task) => task.status === 'error').length

    if (failed === 0 && uploadState.tasks.every((task) => task.status === 'success')) {
      hintMessage.value = '全部文件上传完成'
    } else if (failed > 0) {
      hintMessage.value = `${failed} 个文件上传失败，可单条重试`
    }
  }
}

const handleCancel = (): void => {
  if (uploadState.running) {
    cancelUpload()
    return
  }

  clearAllTasks()
}

const handleSelectTarget = (breadcrumbs: Breadcrumb[]): void => {
  setUploadTarget(breadcrumbs)
  pickerOpen.value = false
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

/** 正在等待上传收尾（窗口保持可见，不允许假装已经停下）。 */
const cancelling = ref(false)

/**
 * 退出前清场：取消上传 -> best-effort abort multipart -> 等待清理完成（有上限），
 * 然后告诉 Rust 侧可以退出了。Rust 自己还有超时兜底，这里失败不会卡住退出。
 */
const handlePrepareExit = async (): Promise<void> => {
  preparingExit.value = true

  // 请求取消 -> 等真正 idle（其中包含 best-effort abort multipart 与 worker 退出）。
  if (uploadState.running) {
    cancelUpload()
  }

  // 只有在**真正**结束之后才回报 ready；如果一直没收尾，
  // Rust 侧的 EXIT_CLEANUP_TIMEOUT_MS 会兜底退出，这里不会无限阻塞。
  await waitForUploadIdle()

  try {
    await confirmExitReady()
  } catch {
    // 通知失败也无妨：Rust 侧超时后会照常退出。
  }
}

/**
 * 关闭上传窗口：只隐藏不销毁，保证上传状态不丢。
 *
 * 顺序严格是：请求取消 -> 等上传真正 idle（含 abort multipart）-> 才隐藏。
 * 如果超过有界超时还没收尾，就**保持窗口可见**并进入"正在取消"状态，
 * 后台继续等它真正结束再隐藏——绝不假装上传已经停了。
 */
const handleCloseRequested = async (event: {
  preventDefault: () => void
}): Promise<void> => {
  event.preventDefault()

  // 已经在收尾：重复点关闭不做任何事，避免重复取消/重复隐藏。
  if (cancelling.value) return

  const hasPendingWork = uploadState.tasks.some((task) => task.status === 'pending')

  if (uploadState.running) {
    const confirmed = await confirmDialog(
      '上传正在进行。关闭窗口会尝试取消当前上传（尽力 abort 未完成的分片），确定吗？',
      {
        title: '取消上传',
        kind: 'warning',
        okLabel: '取消上传并关闭',
        cancelLabel: '继续上传'
      }
    )

    if (!confirmed) return
  }

  if (!uploadState.running && !hasPendingWork) {
    // 没有进行中的上传：直接隐藏。
    await hideUploadWindow()
    return
  }

  cancelUpload()
  cancelling.value = true

  const idle = await waitForIdle(UPLOAD_CLEANUP_TIMEOUT_MS)

  if (!idle) {
    // 超时：窗口保持可见并显示"正在取消"，后台等真正结束再隐藏。
    void waitForUploadIdle().then(() => {
      // 组件已经销毁：不要再写 Vue 状态，也不要操作窗口。
      if (disposed) return

      cancelling.value = false

      // 期间如果用户又发起了新的上传，就不要把窗口藏起来。
      if (!uploadState.running) {
        void hideUploadWindow()
      }
    })

    return
  }

  cancelling.value = false
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

  // 主窗口退出前会广播这个事件：本窗口负责取消上传并回报清理完成。
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

  if (disposed) return

  await initializeTarget()

  if (disposed) return

  await consumeTargetHint()

  if (disposed) return

  await consumePending()
})

onUnmounted(() => {
  disposed = true
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
      应用正在退出：正在取消上传并清理未完成的分片…
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
          @retry="retryTask"
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
          class="btn btn--small"
          type="button"
          :disabled="tasks.length === 0 || (!uploadState.running && !canUpload)"
          @click="handleCancel"
        >
          {{ cancelLabel }}
        </button>
        <button
          class="btn btn--primary btn--small"
          type="button"
          :disabled="!canUpload"
          @click="handleUpload"
        >
          {{ uploadState.running ? '上传中…' : 'Upload' }}
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
