<script setup lang="ts">
/**
 * 上传窗口里的云目录选择浏览器：只能浏览文件夹，并选中"当前所在目录"。
 *
 * 同样带 generation 竞态保护，避免快速点击时旧响应覆盖新目录。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import Breadcrumbs from './Breadcrumbs.vue'
import { fetchDirectory, fetchRoot, isAbortedError, isAuthFailure } from '../services/api'
import { getAccessToken, logout, onSessionChanged } from '../services/auth'
import type { Breadcrumb, DirectoryItem } from '../types'

const props = defineProps<{
  open: boolean
  current: Breadcrumb[]
}>()

const emit = defineEmits<{
  close: []
  select: [breadcrumbs: Breadcrumb[]]
}>()

const breadcrumbs = ref<Breadcrumb[]>([])
const directories = ref<DirectoryItem[]>([])
const loading = ref(false)
const errorMessage = ref('')

let generation = 0
let controller: AbortController | null = null
/** 组件卸载后：不再发起请求，也不再写任何响应式状态。 */
let disposed = false

const currentDirectory = computed<Breadcrumb | undefined>(
  () => breadcrumbs.value[breadcrumbs.value.length - 1]
)

const beginRequest = (): { generation: number; signal: AbortSignal } => {
  controller?.abort()

  const next = new AbortController()
  controller = next
  generation += 1

  return { generation, signal: next.signal }
}

// disposed 之后一律视为"过期"，所有守卫与 loading 收尾都会直接跳过，
// 避免异步响应回来时更新已经销毁的组件。
//
// 除了 generation，还必须确认**发起请求时用的令牌仍是当前令牌**：
// 否则账号 A 的迟到响应会写进账号 B 的 picker，
// 一条迟到的 401 甚至会把刚登录的账号 B 登出。
const isCurrentRequest = (value: number, token: string): boolean =>
  !disposed && value === generation && getAccessToken() === token

const loadRoot = async (): Promise<void> => {
  const token = getAccessToken()

  if (!token) {
    await logout()
    return
  }

  const { generation: requestId, signal } = beginRequest()
  loading.value = true
  errorMessage.value = ''

  try {
    const snapshot = await fetchRoot(token, signal)

    if (!isCurrentRequest(requestId, token)) return

    breadcrumbs.value = [{ id: snapshot.rootId, name: 'root' }]
    directories.value = snapshot.directories
  } catch (error) {
    if (!isCurrentRequest(requestId, token) || isAbortedError(error)) return

    if (isAuthFailure(error)) {
      await logout()
      return
    }

    errorMessage.value = error instanceof Error ? error.message : '加载失败'
  } finally {
    if (isCurrentRequest(requestId, token)) {
      loading.value = false
    }
  }
}

const loadDirectory = async (directoryId: number): Promise<void> => {
  const token = getAccessToken()

  if (!token) {
    await logout()
    return
  }

  const { generation: requestId, signal } = beginRequest()
  loading.value = true
  errorMessage.value = ''

  try {
    const snapshot = await fetchDirectory(token, directoryId, signal)

    if (!isCurrentRequest(requestId, token)) return

    directories.value = snapshot.directories
  } catch (error) {
    if (!isCurrentRequest(requestId, token) || isAbortedError(error)) return

    if (isAuthFailure(error)) {
      await logout()
      return
    }

    errorMessage.value = error instanceof Error ? error.message : '加载失败'
  } finally {
    if (isCurrentRequest(requestId, token)) {
      loading.value = false
    }
  }
}

const initialize = async (): Promise<void> => {
  // 每次打开都从干净状态开始：否则可能出现"新面包屑 + 上一次打开的旧目录内容"。
  directories.value = []
  errorMessage.value = ''

  if (props.current.length > 0) {
    breadcrumbs.value = props.current.map((item) => ({ id: item.id, name: item.name }))
    await loadDirectory(breadcrumbs.value[breadcrumbs.value.length - 1].id)
    return
  }

  breadcrumbs.value = []
  await loadRoot()
}

const enterDirectory = (directory: DirectoryItem): void => {
  // 进入子目录：先清空上一个目录的条目。
  directories.value = []

  breadcrumbs.value = [...breadcrumbs.value, { id: directory.id, name: directory.name }]
  void loadDirectory(directory.id)
}

const navigateTo = (index: number): void => {
  const target = breadcrumbs.value[index]

  if (!target) return

  // 导航到别的目录：先清空旧内容，失败时不会出现"新面包屑 + 旧目录内容"。
  directories.value = []

  if (index === 0) {
    void loadRoot()
    return
  }

  breadcrumbs.value = breadcrumbs.value.slice(0, index + 1)
  void loadDirectory(target.id)
}

const confirmSelection = (): void => {
  if (breadcrumbs.value.length === 0) return

  emit('select', breadcrumbs.value.map((item) => ({ id: item.id, name: item.name })))
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      controller?.abort()
      controller = null
      return
    }

    void initialize()
  }
)

/**
 * 退出登录 / 换账号：作废在途请求并清空上一个账号的浏览状态；
 * 如果 picker 还开着、且新账号已经有令牌，就用新会话重新初始化。
 */
const handleSessionChanged = (): void => {
  if (disposed) return

  controller?.abort()
  controller = null
  generation += 1

  breadcrumbs.value = []
  directories.value = []
  errorMessage.value = ''
  loading.value = false

  if (props.open && getAccessToken()) {
    void initialize()
  }
}

let unsubscribeSession: (() => void) | null = null

onMounted(() => {
  unsubscribeSession = onSessionChanged(handleSessionChanged)
})

onUnmounted(() => {
  // 关键：卸载时必须终止仍在进行中的目录请求，否则响应回来会更新已销毁的组件。
  disposed = true

  unsubscribeSession?.()
  unsubscribeSession = null

  controller?.abort()
  controller = null
})
</script>

<template>
  <div v-if="open" class="picker" @click.self="emit('close')">
    <div class="picker__card">
      <header class="picker__header">
        <h2 class="picker__title">选择目标云目录</h2>
        <button class="btn btn--ghost btn--small" type="button" @click="emit('close')">
          关闭
        </button>
      </header>

      <div class="picker__crumbs">
        <Breadcrumbs :items="breadcrumbs" :disabled="loading" @navigate="navigateTo" />
      </div>

      <p v-if="errorMessage" class="alert alert--error picker__alert">{{ errorMessage }}</p>

      <div class="picker__list">
        <p v-if="loading" class="picker__state">加载中…</p>
        <p v-else-if="directories.length === 0" class="picker__state">没有子文件夹</p>
        <ul v-else class="picker__items">
          <li v-for="directory in directories" :key="directory.id">
            <button
              class="picker__item"
              type="button"
              @click="enterDirectory(directory)"
            >
              <span class="picker__icon" aria-hidden="true">
                <svg viewBox="0 0 20 20" width="16" height="16">
                  <path
                    fill="currentColor"
                    d="M2.5 5.2c0-.7.6-1.2 1.2-1.2h3.1c.4 0 .7.2.9.5l.7 1h7c.7 0 1.2.5 1.2 1.2v8.1c0 .7-.6 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2V5.2Z"
                  />
                </svg>
              </span>
              <span class="picker__name">{{ directory.name }}</span>
            </button>
          </li>
        </ul>
      </div>

      <footer class="picker__footer">
        <span class="picker__current">
          当前：{{ currentDirectory ? currentDirectory.name : '-' }}
        </span>
        <div class="picker__actions">
          <button class="btn" type="button" @click="emit('close')">取消</button>
          <button
            class="btn btn--primary"
            type="button"
            :disabled="loading || breadcrumbs.length === 0"
            @click="confirmSelection"
          >
            选择此目录
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 18, 24, 0.45);
}

.picker__card {
  display: flex;
  width: 100%;
  max-width: 420px;
  max-height: 100%;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.picker__header,
.picker__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
}

.picker__header {
  border-bottom: 1px solid var(--border);
}

.picker__footer {
  border-top: 1px solid var(--border);
}

.picker__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.picker__crumbs {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.picker__alert {
  margin: 8px 12px 0;
}

.picker__list {
  flex: 1;
  overflow: auto;
  padding: 6px;
}

.picker__state {
  padding: 24px 0;
  color: var(--text-faint);
  text-align: center;
}

.picker__items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.picker__item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
}

.picker__item:hover {
  background: var(--surface-hover);
}

.picker__icon {
  display: flex;
  color: #e0a33a;
}

.picker__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__current {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__actions {
  display: flex;
  gap: 8px;
}
</style>
