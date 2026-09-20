<script setup lang="ts">
/**
 * 认证门：负责"启动时恢复登录 / 未登录显示登录页 / 断网可重试"。
 * 通过后再渲染具体视图（首页或上传窗口）。
 */
import { onMounted, onUnmounted } from 'vue'

import { CONFIG_ERROR_MESSAGE } from '../config'
import {
  authState,
  disposeAuth,
  initAuth,
  listenAuthChanged,
  listenLogout,
  logout,
  retryAutoLogin
} from '../services/auth'
import { createListenerRegistry } from '../utils/listeners'
import LoginView from '../views/LoginView.vue'

const listeners = createListenerRegistry()

/** 组件卸载后不再发起新的认证动作。 */
let disposed = false

onMounted(async () => {
  // 跨窗口同步：另一个 WebView 登录 / 退出 / 令牌失效时本窗口立即跟上。
  //
  // 必须先**等两个 listener 都注册完成**，再调用 initAuth()：
  // 否则启动瞬间发生的登录/退出事件会因为监听还没就绪而丢失，
  // 本窗口就会停留在旧的认证状态。
  // 注册是异步的，交给 registry 统一处理"卸载早于注册完成"的情况。
  await listeners.track(listenAuthChanged())
  await listeners.track(listenLogout())

  if (disposed) return

  await initAuth()
})

onUnmounted(() => {
  disposed = true
  listeners.dispose()
  disposeAuth()
})
</script>

<template>
  <div v-if="CONFIG_ERROR_MESSAGE" class="gate">
    <div class="gate__card">
      <h1 class="gate__title">缺少后端配置</h1>
      <p class="gate__text">{{ CONFIG_ERROR_MESSAGE }}</p>
    </div>
  </div>

  <div v-else-if="authState.status === 'initializing'" class="gate">
    <div class="gate__card">
      <div class="spinner" />
      <p class="gate__text">正在恢复登录状态…</p>
    </div>
  </div>

  <LoginView v-else-if="authState.status === 'anonymous'" />

  <div v-else-if="authState.status === 'unreachable'" class="gate">
    <div class="gate__card">
      <h1 class="gate__title">无法连接后端</h1>
      <p class="gate__text">{{ authState.message }}</p>
      <p class="gate__hint">
        已保留本地登录信息。可以重试；如果是想换账号，也可以直接重新登录。
      </p>
      <div class="gate__actions">
        <button class="btn btn--primary" type="button" @click="retryAutoLogin()">
          重试
        </button>
        <button class="btn" type="button" @click="logout()">重新登录</button>
      </div>
    </div>
  </div>

  <slot v-else />
</template>

<style scoped>
.gate {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.gate__card {
  width: 100%;
  max-width: 420px;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow);
  text-align: center;
}

.gate__title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 600;
}

.gate__text {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  word-break: break-word;
}

.gate__hint {
  margin: 10px 0 0;
  color: var(--text-faint);
  font-size: 12px;
}

.gate__actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 18px;
}

.spinner {
  width: 22px;
  height: 22px;
  margin: 0 auto 12px;
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
