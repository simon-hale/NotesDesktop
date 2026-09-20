<script setup lang="ts">
/** 登录页：用户名 + 密码，成功后由 auth.ts 持久化 username/access。 */
import { computed, ref } from 'vue'

import { CONFIG_ERROR_MESSAGE } from '../config'
import { authState, login } from '../services/auth'

const username = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')

const canSubmit = computed(
  () =>
    !submitting.value &&
    !CONFIG_ERROR_MESSAGE &&
    username.value.trim().length > 0 &&
    password.value.length > 0
)

const handleSubmit = async (): Promise<void> => {
  if (!canSubmit.value) return

  submitting.value = true
  errorMessage.value = ''

  try {
    await login(username.value.trim(), password.value)
    password.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="login__card" @submit.prevent="handleSubmit">
      <header class="login__header">
        <div class="login__logo">N</div>
        <div>
          <h1 class="login__title">Notes</h1>
          <p class="login__subtitle">登录以访问你的云端目录</p>
        </div>
      </header>

      <label class="field">
        <span class="field__label">用户名</span>
        <input
          v-model="username"
          class="field__input"
          type="text"
          autocomplete="username"
          :disabled="submitting"
          placeholder="请输入用户名"
        />
      </label>

      <label class="field">
        <span class="field__label">密码</span>
        <input
          v-model="password"
          class="field__input"
          type="password"
          autocomplete="current-password"
          :disabled="submitting"
          placeholder="请输入密码"
        />
      </label>

      <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>
      <p v-else-if="authState.message" class="alert alert--warning">
        {{ authState.message }}
      </p>

      <button class="btn btn--primary login__submit" type="submit" :disabled="!canSubmit">
        {{ submitting ? '登录中…' : '登录' }}
      </button>

      <p class="login__note">
        登录信息通过 Tauri Store 保存在本机，用于下次启动时自动登录。
      </p>
    </form>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
}

.login__card {
  display: flex;
  width: 100%;
  max-width: 340px;
  flex-direction: column;
  gap: 14px;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.login__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.login__logo {
  display: flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
}

.login__title {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}

.login__subtitle {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field__label {
  color: var(--text-muted);
  font-size: 12px;
}

.field__input {
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  outline: none;
  transition: border-color var(--transition), box-shadow var(--transition);
}

.field__input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.login__submit {
  justify-content: center;
  padding: 9px 12px;
}

.login__note {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
  text-align: center;
}
</style>
