<script setup lang="ts">
/**
 * 主窗口首页：云端目录浏览 + 创建/重命名/删除 + 触发上传窗口。
 *
 * 竞态保护：每次目录请求都会 ++generation 并 abort 上一次请求，
 * 响应回来时若 generation 已经不是最新的，直接丢弃，绝不让旧响应覆盖当前目录。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  confirm as confirmDialog,
  open as openDialog
} from '@tauri-apps/plugin-dialog'

import Breadcrumbs from '../components/Breadcrumbs.vue'
import FileList from '../components/FileList.vue'
import {
  createDirectory,
  deleteDirectory,
  deleteFile,
  fetchDirectory,
  fetchRoot,
  isAbortedError,
  isAuthFailure,
  renameDirectory,
  renameFile
} from '../services/api'
import { authState, getAccessToken, logout, onSessionChanged } from '../services/auth'
import {
  getShellIntegrationStatus,
  installShellIntegration,
  openUploadWindow,
  queueUploadPaths,
  quitApp,
  uninstallShellIntegration,
  uploadActive,
  uploadBatchBusy
} from '../services/filesystem'
import { getShellIntegrationEnabled, setShellIntegrationEnabled } from '../services/settings'
import { notifyUploadPending } from '../services/events'
import type {
  Breadcrumb,
  DirectoryItem,
  FileItem,
  ShellIntegrationStatus
} from '../types'
import type { EntryRef } from '../types/entry'
import { createListenerRegistry } from '../utils/listeners'

type NoticeKind = 'info' | 'warning'
type PromptKind = 'create-directory' | 'rename-directory' | 'rename-file'

const breadcrumbs = ref<Breadcrumb[]>([])
const directories = ref<DirectoryItem[]>([])
const files = ref<FileItem[]>([])
const loading = ref(false)
const mutating = ref(false)
const errorMessage = ref('')
const notice = reactive<{ message: string; kind: NoticeKind }>({
  message: '',
  kind: 'info'
})
const shellStatus = ref<ShellIntegrationStatus | null>(null)
const shellIntegrationEnabled = ref(true)
const quitting = ref(false)

const prompt = reactive({
  visible: false,
  kind: 'create-directory' as PromptKind,
  id: 0,
  value: '',
  busy: false,
  error: '',
  /** 打开这个弹窗时的会话令牌：账号变了就不能再提交。 */
  token: ''
})

const listeners = createListenerRegistry()

let requestGeneration = 0
let activeController: AbortController | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeSession: (() => void) | null = null
/** 组件卸载后：不再写状态，也不再让旧响应落地。 */
let disposed = false

const currentBreadcrumb = computed<Breadcrumb | undefined>(
  () => breadcrumbs.value[breadcrumbs.value.length - 1]
)

const currentId = computed<number>(() => currentBreadcrumb.value?.id ?? 0)

const promptTitle = computed<string>(() => {
  switch (prompt.kind) {
    case 'create-directory':
      return '新建文件夹'
    case 'rename-directory':
      return '重命名文件夹'
    default:
      return '重命名文件'
  }
})

const showNotice = (message: string, kind: NoticeKind = 'info'): void => {
  notice.message = message
  notice.kind = kind

  if (noticeTimer !== null) {
    clearTimeout(noticeTimer)
  }

  noticeTimer = setTimeout(() => {
    notice.message = ''
    noticeTimer = null
  }, 5000)
}

const beginRequest = (): { generation: number; signal: AbortSignal } => {
  activeController?.abort()

  const controller = new AbortController()
  activeController = controller
  requestGeneration += 1

  return { generation: requestGeneration, signal: controller.signal }
}

const isCurrentGeneration = (generation: number): boolean =>
  !disposed && generation === requestGeneration

/**
 * 请求是否仍属于"当前账号会话"。
 *
 * 用于 create / rename / delete 这类异步变更：发起时捕获令牌，
 * await 之后必须再确认令牌没变、组件还在，才允许写 UI、刷新或登出。
 */
const isCurrentSession = (token: string): boolean =>
  !disposed && getAccessToken() === token

/**
 * 处理目录加载失败。
 *
 * `token` 是发起请求时用的令牌：只有当它仍然是当前令牌时才允许登出，
 * 否则账号 A 的延迟 401 会把刚登录的账号 B 踢出去。
 */
const handleLoadError = async (error: unknown, token: string): Promise<void> => {
  if (disposed || getAccessToken() !== token) return

  if (isAuthFailure(error)) {
    await logout()
    return
  }

  errorMessage.value = error instanceof Error ? error.message : '加载失败'
}

const loadRoot = async (): Promise<void> => {
  const { generation, signal } = beginRequest()

  loading.value = true
  errorMessage.value = ''

  const token = getAccessToken()

  if (!token) {
    await logout()
    return
  }

  try {
    const snapshot = await fetchRoot(token, signal)

    if (!isCurrentGeneration(generation)) return

    breadcrumbs.value = [{ id: snapshot.rootId, name: 'root' }]
    directories.value = snapshot.directories
    files.value = snapshot.files
  } catch (error) {
    if (!isCurrentGeneration(generation) || isAbortedError(error)) return
    await handleLoadError(error, token)
  } finally {
    if (isCurrentGeneration(generation)) {
      loading.value = false
    }
  }
}

/**
 * 加载某个目录。
 *
 * `clearListing` 用于**导航到别的目录**：先把旧内容清空，
 * 这样即便新请求失败，也不会出现"新面包屑 + 旧目录内容"的错配。
 * 同目录刷新不要传它，避免无谓的内容闪烁。
 */
const loadDirectory = async (
  directoryId: number,
  options?: { clearListing?: boolean }
): Promise<void> => {
  if (options?.clearListing) {
    directories.value = []
    files.value = []
  }

  const { generation, signal } = beginRequest()

  loading.value = true
  errorMessage.value = ''

  const token = getAccessToken()

  if (!token) {
    await logout()
    return
  }

  try {
    const snapshot = await fetchDirectory(token, directoryId, signal)

    if (!isCurrentGeneration(generation)) return

    directories.value = snapshot.directories
    files.value = snapshot.files
  } catch (error) {
    if (!isCurrentGeneration(generation) || isAbortedError(error)) return
    await handleLoadError(error, token)
  } finally {
    if (isCurrentGeneration(generation)) {
      loading.value = false
    }
  }
}

const refresh = (): void => {
  const target = currentBreadcrumb.value

  if (!target) {
    void loadRoot()
    return
  }

  void loadDirectory(target.id)
}

const navigateTo = (index: number): void => {
  const target = breadcrumbs.value[index]

  if (!target) return

  // 导航到别的目录：先清空旧内容，避免失败时"新面包屑 + 旧内容"并存。
  directories.value = []
  files.value = []

  if (index === 0) {
    breadcrumbs.value = [target]
    void loadRoot()
    return
  }

  breadcrumbs.value = breadcrumbs.value.slice(0, index + 1)
  void loadDirectory(target.id, { clearListing: true })
}

const openDirectory = (directory: DirectoryItem): void => {
  // 进入子目录同样是导航：先清空上一个目录的内容。
  directories.value = []
  files.value = []

  breadcrumbs.value = [...breadcrumbs.value, { id: directory.id, name: directory.name }]
  void loadDirectory(directory.id, { clearListing: true })
}

/**
 * 是否允许开一个新的上传批次。
 *
 * `UploadBatchBusy` 与 `UploadActivity` 是**互补**的两个状态，任一为真都要挡住：
 *   - `uploadBatchBusy`：这一批还有没成功的任务，占着全局唯一的目标目录；
 *   - `uploadActive`：此刻有上传在跑（覆盖"列表恰好为空、但上一轮还在收尾"的窗口）。
 *
 * 两个查询**任一失败都 fail closed**：宁可暂时不让开新批次，
 * 也不能放过"两批共用同一个目标目录"的情况。
 */
const canStartNewUploadBatch = async (): Promise<boolean> => {
  try {
    const [batchBusy, active] = await Promise.all([
      uploadBatchBusy(),
      uploadActive()
    ])

    return !batchBusy && !active
  } catch {
    return false
  }
}

/**
 * 已有批次或上传在跑时不再接受新批次。
 *
 * 本客户端不支持"多批次各自目标目录"：新批次的目标目录提示会被
 * `setUploadTarget()`（上传中拒绝切换）丢掉，用户可能以为文件会进 /B，
 * 实际却跟着当前批次进了 /A。所以直接拒绝并聚焦已有上传窗口。
 */
const refuseNewBatchWhileUploading = async (): Promise<void> => {
  showNotice('已有上传正在进行，请等它结束后再添加新文件', 'warning')

  try {
    // 不带参数：只显示并聚焦，不覆盖已有的目标目录提示。
    await openUploadWindow()
  } catch {
    // 聚焦失败（例如窗口不存在）时忽略。
  }
}

/**
 * 开新批次前的守卫：状态查询失败时 fail closed。
 *
 * 返回 false 表示调用方必须直接结束（要么不能开新批次，要么会话已经变了）。
 */
const ensureCanStartNewBatch = async (token: string): Promise<boolean> => {
  const allowed = await canStartNewUploadBatch()

  if (!isCurrentSession(token)) return false

  if (allowed) return true

  await refuseNewBatchWhileUploading()

  return false
}

/** 上传：走 Rust 队列 + 打开上传窗口，真正的上传逻辑在 UploadService。 */
const handleUpload = async (): Promise<void> => {
  // 打开系统文件对话框之前先捕获会话令牌：对话框可能停留很久，
  // 期间账号可能被换掉，那时这次选择必须整批丢弃。
  const token = getAccessToken()

  if (!token) {
    await logout()
    return
  }

  if (!(await ensureCanStartNewBatch(token))) return

  let selected: string | string[] | null = null

  try {
    selected = await openDialog({
      multiple: true,
      directory: false,
      title: '选择要上传的文件'
    })
  } catch (error) {
    if (!isCurrentSession(token)) return

    errorMessage.value = error instanceof Error ? error.message : '无法打开文件选择器'
    return
  }

  // 对话框期间换了账号：这次选择属于上一个会话，丢弃。
  if (!isCurrentSession(token)) return

  if (!selected) return

  // 对话框期间这一批可能已经开始了：同样不再接受新批次。
  if (!(await ensureCanStartNewBatch(token))) return

  const paths = Array.isArray(selected) ? selected : [selected]

  if (paths.length === 0) return

  try {
    const result = await queueUploadPaths(paths)

    if (!isCurrentSession(token)) return

    if (result.rejected.length > 0) {
      showNotice(`${result.rejected.length} 个路径不是有效文件，已跳过`, 'warning')
    }

    // 先应用/广播目标目录建议，再通知上传窗口"队列里有新数据"，
    // 这样它 take 到路径时目标目录已经就位。
    await openUploadWindow(breadcrumbs.value)
    await notifyUploadPending()
  } catch (error) {
    if (!isCurrentSession(token)) return

    errorMessage.value = error instanceof Error ? error.message : '无法加入上传队列'
  }
}

const openCreateDirectory = (): void => {
  prompt.kind = 'create-directory'
  prompt.id = 0
  prompt.value = ''
  prompt.error = ''
  // 记住打开时的会话令牌：账号变了就不能把这个弹窗提交出去。
  prompt.token = getAccessToken()
  prompt.visible = true
}

const openRename = (entry: EntryRef): void => {
  prompt.kind = entry.kind === 'directory' ? 'rename-directory' : 'rename-file'
  prompt.id = entry.id
  prompt.value = entry.name
  prompt.error = ''
  prompt.token = getAccessToken()
  prompt.visible = true
}

const closePrompt = (): void => {
  if (prompt.busy) return

  prompt.visible = false
  prompt.token = ''
}

/**
 * 变更失败后刷新当前目录，让 UI 与后端重新对齐。
 *
 * 之所以不直接调用 `refresh()`：`loadDirectory` / `loadRoot` 会在**同步阶段**
 * 就把 `errorMessage` 清空，若等下一次渲染再恢复错误提示，中间会有一帧空白，
 * 刷新失败时更会把用户刚看到的错误**永久**抹掉。
 * 所以这里先记下错误文本，发起刷新后立刻写回，保证错误提示与刷新**同时**生效。
 */
const refreshAfterMutationFailure = (): void => {
  const message = errorMessage.value

  refresh()

  if (message) {
    errorMessage.value = message
  }
}

const submitPrompt = async (): Promise<void> => {
  const value = prompt.value.trim()

  if (!value) {
    prompt.error = '名称不能为空'
    return
  }

  if (value.length > 100) {
    prompt.error = '名称不能超过 100 个字符'
    return
  }

  if (value.includes('/') || value.includes('\\')) {
    prompt.error = '名称不能包含路径分隔符'
    return
  }

  const token = getAccessToken()

  // 弹窗是在另一个账号会话下打开的：直接关掉，绝不发出
  // "B 的令牌 + A 的目录/文件 ID" 这种错配请求。
  if (!token || token !== prompt.token) {
    prompt.visible = false
    prompt.token = ''

    if (!token) {
      await logout()
    }

    return
  }

  prompt.busy = true
  prompt.error = ''

  try {
    let noticeText = ''
    let noticeKind: NoticeKind = 'info'

    if (prompt.kind === 'create-directory') {
      await createDirectory(token, value, currentId.value)
      noticeText = '文件夹已创建'
    } else if (prompt.kind === 'rename-directory') {
      await renameDirectory(token, prompt.id, value)
      noticeText = '文件夹已重命名'
    } else {
      const result = await renameFile(token, currentId.value, prompt.id, value)
      // success_oss_error：数据库已改成功，只是 OSS 有警告 —— 提示后照常刷新。
      noticeText = result.warning || '文件已重命名'
      noticeKind = result.warning ? 'warning' : 'info'
    }

    // 期间换了账号 / 组件已销毁：结果不属于当前会话，丢弃。
    if (!isCurrentSession(token)) return

    showNotice(noticeText, noticeKind)
    prompt.visible = false
    refresh()
  } catch (error) {
    if (!isCurrentSession(token)) return

    if (isAuthFailure(error)) {
      prompt.visible = false
      await logout()
      return
    }

    prompt.error = error instanceof Error ? error.message : '操作失败'

    // 后端可能已经改了一半（例如重命名与并发变更相撞）：刷新一次，
    // 避免界面继续显示后端已经不存在的旧条目。失败提示在 prompt 里，
    // 不受刷新影响；成功失败判定只依据是否抛错，不匹配具体错误文案。
    refreshAfterMutationFailure()
  } finally {
    if (!disposed) {
      prompt.busy = false
    }
  }
}

const handleRemove = async (entry: EntryRef): Promise<void> => {
  const label = entry.kind === 'directory' ? '文件夹' : '文件'

  // 在**打开确认框之前**捕获会话令牌：确认框可能停留很久，
  // 期间账号可能被换掉，那时不能拿新令牌去删旧账号的 entry。
  const token = getAccessToken()

  if (!token) {
    await logout()
    return
  }

  let confirmed = false

  try {
    confirmed = await confirmDialog(
      `确定要删除${label}“${entry.name}”吗？该操作不可撤销。`,
      {
        title: '删除确认',
        kind: 'warning',
        okLabel: '删除',
        cancelLabel: '取消'
      }
    )
  } catch (error) {
    if (!isCurrentSession(token)) return

    errorMessage.value = error instanceof Error ? error.message : '无法打开确认框'
    return
  }

  if (!confirmed) return

  // 确认期间换了账号：这个 entry 属于上一个会话，丢弃。
  if (!isCurrentSession(token)) return

  mutating.value = true

  try {
    if (entry.kind === 'directory') {
      await deleteDirectory(token, entry.id)
    } else {
      await deleteFile(token, entry.id)
    }

    // 期间换了账号 / 组件已销毁：结果不属于当前会话，丢弃。
    if (!isCurrentSession(token)) return

    showNotice(`${label}已删除`)
    refresh()
  } catch (error) {
    if (!isCurrentSession(token)) return

    if (isAuthFailure(error)) {
      await logout()
      return
    }

    errorMessage.value = error instanceof Error ? error.message : '删除失败'

    // 删除失败也可能意味着后端状态已变（条目其实已被删掉等）：
    // 刷新当前目录，并在刷新时保留上面的错误提示。
    refreshAfterMutationFailure()
  } finally {
    if (!disposed) {
      mutating.value = false
    }
  }
}

const refreshShellStatus = async (): Promise<void> => {
  try {
    shellStatus.value = await getShellIntegrationStatus()
  } catch {
    shellStatus.value = null
  }
}

/**
 * 切换"由应用管理 Explorer 右键菜单"的偏好。
 *
 * 必须保证偏好与**注册表实际状态**一致：
 *   1. 偏好先落盘（失败则注册表根本没动，直接提示）；
 *   2. 注册表操作成功后才认为偏好生效；
 *   3. 注册表操作失败则**回滚偏好**，并刷新显示真实状态。
 */
const handleToggleShellIntegration = async (): Promise<void> => {
  const previous = shellIntegrationEnabled.value
  const next = !previous

  try {
    await setShellIntegrationEnabled(next)
  } catch (error) {
    // 偏好没写成功，注册表也没动：保持原状并刷新真实状态。
    shellIntegrationEnabled.value = previous
    await refreshShellStatus()
    errorMessage.value = error instanceof Error ? error.message : '无法保存设置'
    return
  }

  try {
    const status = next ? await installShellIntegration() : await uninstallShellIntegration()

    shellIntegrationEnabled.value = next
    shellStatus.value = status

    showNotice(next ? '已启用 Explorer 右键菜单' : '已关闭，之后启动不会再改动注册表')
  } catch (error) {
    // 注册表操作失败：回滚偏好，避免 shellIntegrationEnabled 与实际状态不一致。
    try {
      await setShellIntegrationEnabled(previous)
    } catch {
      // 回滚写失败也要继续刷新界面，至少显示注册表的真实状态。
    }

    shellIntegrationEnabled.value = previous
    await refreshShellStatus()
    errorMessage.value = error instanceof Error ? error.message : '操作失败'
  }
}

/**
 * 关闭主窗口 = 退出应用。
 *
 * 这里先 preventDefault，再按需确认：**有上传在跑**时提醒用户会先取消并清理，
 * 避免误点关闭把正在进行的上传打断。
 *
 * 真正的退出由 Rust 侧编排：先广播 notes:prepare-exit 让上传窗口请求取消、
 * best-effort abort multipart，等它回报清理完成（或超时）后再 exit。
 * 判断"有没有上传"用的是显式的 UploadActivity 状态，不是窗口可见性。
 */
const handleCloseRequested = async (event: { preventDefault: () => void }): Promise<void> => {
  event.preventDefault()

  let active = false

  try {
    active = await uploadActive()
  } catch {
    active = false
  }

  if (active) {
    let confirmed = false

    try {
      confirmed = await confirmDialog(
        '有上传正在进行，退出会先取消上传并清理未完成的分片。确定退出吗？',
        {
          title: '退出 Notes Desktop',
          kind: 'warning',
          okLabel: '退出',
          cancelLabel: '取消'
        }
      )
    } catch {
      confirmed = false
    }

    if (!confirmed) return
  }

  quitting.value = true

  try {
    await quitApp()
  } catch (error) {
    quitting.value = false
    errorMessage.value = error instanceof Error ? error.message : '退出失败'
  }
}

onMounted(() => {
  void loadRoot()
  void refreshShellStatus()

  void getShellIntegrationEnabled().then((enabled) => {
    // 组件已经卸载：不要再写 Vue 状态。
    if (disposed) return

    shellIntegrationEnabled.value = enabled
  })

  // 会话被清空 / 换成另一个账号：丢弃上一个账号的目录状态并重新加载自己的 root，
  // 绝不复用上一个账号的目录 ID；同时关掉上一个账号遗留的弹窗/确认态。
  unsubscribeSession = onSessionChanged(() => {
    if (disposed) return

    // 账号 A 打开的 Rename / New Folder 弹窗绝不能留到账号 B。
    prompt.visible = false
    prompt.busy = false
    prompt.error = ''
    prompt.token = ''
    mutating.value = false

    breadcrumbs.value = []
    directories.value = []
    files.value = []
    errorMessage.value = ''

    if (authState.status === 'authenticated') {
      void loadRoot()
    }
  })

  try {
    void listeners.track(getCurrentWindow().onCloseRequested(handleCloseRequested))
  } catch {
    // 非 Tauri 环境（直接用浏览器跑 vite dev）：忽略。
  }
})

onUnmounted(() => {
  disposed = true

  unsubscribeSession?.()
  unsubscribeSession = null

  activeController?.abort()
  activeController = null

  listeners.dispose()

  if (noticeTimer !== null) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
})
</script>

<template>
  <div class="home">
    <header class="topbar">
      <div class="topbar__brand">
        <div class="topbar__logo">N</div>
        <span class="topbar__name">Notes</span>
      </div>

      <div class="topbar__actions">
        <span class="topbar__account" :title="authState.username">
          {{ authState.username || '未登录' }}
        </span>
        <button class="btn btn--primary" type="button" @click="handleUpload">
          Upload
        </button>
        <button
          class="btn"
          type="button"
          :disabled="loading || !currentBreadcrumb"
          @click="openCreateDirectory"
        >
          New Folder
        </button>
        <button class="btn btn--ghost" type="button" @click="logout()">Logout</button>
      </div>
    </header>

    <div class="toolbar">
      <Breadcrumbs
        :items="breadcrumbs"
        :disabled="loading"
        @navigate="navigateTo"
      />
      <button
        class="btn btn--ghost btn--small"
        type="button"
        :disabled="loading"
        title="刷新当前目录"
        @click="refresh"
      >
        刷新
      </button>
    </div>

    <div class="alerts">
      <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>
      <p
        v-if="notice.message"
        class="alert"
        :class="notice.kind === 'warning' ? 'alert--warning' : 'alert--info'"
      >
        {{ notice.message }}
      </p>
    </div>

    <main class="body">
      <div v-if="loading && directories.length === 0 && files.length === 0" class="body__state">
        <div class="spinner" />
        <p>正在加载…</p>
      </div>
      <FileList
        v-else
        :directories="directories"
        :files="files"
        :busy="loading || mutating"
        @open="openDirectory"
        @rename="openRename"
        @remove="handleRemove"
      />
    </main>

    <footer class="footer">
      <span v-if="quitting" class="footer__text">正在退出…</span>
      <span v-else-if="loading" class="footer__text">加载中…</span>
      <span v-else-if="shellStatus" class="footer__text">{{ shellStatus.message }}</span>
      <button
        v-if="shellStatus && shellStatus.supported && !quitting"
        class="btn btn--small"
        type="button"
        @click="handleToggleShellIntegration"
      >
        {{ shellIntegrationEnabled ? '关闭右键菜单' : '启用右键菜单' }}
      </button>
    </footer>

    <div v-if="prompt.visible" class="modal" @click.self="closePrompt">
      <div class="modal__card">
        <h2 class="modal__title">{{ promptTitle }}</h2>
        <input
          v-model="prompt.value"
          class="modal__input"
          type="text"
          :disabled="prompt.busy"
          placeholder="请输入名称"
          @keydown.enter.prevent="submitPrompt"
          @keydown.esc.prevent="closePrompt"
        />
        <p v-if="prompt.error" class="alert alert--error">{{ prompt.error }}</p>
        <div class="modal__actions">
          <button class="btn" type="button" :disabled="prompt.busy" @click="closePrompt">
            取消
          </button>
          <button
            class="btn btn--primary"
            type="button"
            :disabled="prompt.busy"
            @click="submitPrompt"
          >
            {{ prompt.busy ? '处理中…' : '确定' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  height: 100%;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.topbar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar__logo {
  display: flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: var(--primary);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
}

.topbar__name {
  font-size: 15px;
  font-weight: 650;
}

.topbar__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.topbar__account {
  max-width: 160px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.alerts:empty {
  display: none;
}

.alerts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 14px 0;
}

.body {
  flex: 1;
  overflow: auto;
  padding: 4px 8px 8px;
}

.body__state {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 14px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.footer__text {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 18, 24, 0.45);
}

.modal__card {
  display: flex;
  width: 100%;
  max-width: 340px;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.modal__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.modal__input {
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  outline: none;
}

.modal__input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
