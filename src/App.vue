<script setup lang="ts">
/**
 * 根组件。
 *
 * 两个窗口加载同一个 SPA，用 `getCurrentWindow().label` 决定渲染哪个视图，
 * 不引入 Router。
 *
 * 这里还挂了一个"上传窗口关闭守卫"：App 在任何认证状态下都存在，
 * 因此登录页 / 初始化 / 断网重试期间关闭上传窗口也能被拦下来（只隐藏不销毁）。
 * 进入登录态之后，取消/清理那套关闭逻辑仍然由 UploadView 自己处理。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'

import AuthGate from './components/AuthGate.vue'
import HomeView from './views/HomeView.vue'
import UploadView from './views/UploadView.vue'
import { authState } from './services/auth'
import { createListenerRegistry } from './utils/listeners'

type WindowKind = 'main' | 'upload'

const windowKind = ref<WindowKind | null>(null)

const listeners = createListenerRegistry()

/**
 * 上传窗口的关闭守卫（**只在未登录完成前生效**）。
 *
 * 上传窗口必须保持可复用：即使此刻显示的是登录页 / 加载中 / 断网重试，
 * 也不能让它被销毁——一旦销毁，`open_upload_window` 就再也找不到它了。
 */
const handleUploadWindowCloseRequested = async (event: {
  preventDefault: () => void
}): Promise<void> => {
  // 任何情况下都不销毁上传窗口。
  event.preventDefault()

  if (authState.status === 'authenticated') {
    // 已进入主界面：交给 UploadView 的关闭处理（确认 -> 取消 -> 清理 -> 隐藏）。
    return
  }

  try {
    await getCurrentWindow().hide()
  } catch {
    // 非 Tauri 环境：忽略。
  }
}

onMounted(() => {
  let isUploadWindow = false

  try {
    isUploadWindow = getCurrentWindow().label === 'upload'
  } catch {
    // 非 Tauri 环境（例如直接用浏览器打开 vite dev）退化成主窗口视图。
    isUploadWindow = false
  }

  windowKind.value = isUploadWindow ? 'upload' : 'main'

  if (!isUploadWindow) return

  try {
    void listeners.track(
      getCurrentWindow().onCloseRequested(handleUploadWindowCloseRequested)
    )
  } catch {
    // 非 Tauri 环境：忽略。
  }
})

onUnmounted(() => {
  listeners.dispose()
})
</script>

<template>
  <AuthGate v-if="windowKind">
    <UploadView v-if="windowKind === 'upload'" />
    <HomeView v-else />
  </AuthGate>
  <div v-else class="boot">正在启动…</div>
</template>

<style scoped>
.boot {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
</style>
