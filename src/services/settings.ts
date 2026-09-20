/**
 * 应用偏好设置（与登录信息分开存放）。
 *
 * 使用官方 Tauri Store（settings.json），与 auth.json 一样只做持久化。
 * Rust 侧启动时会读取同一个文件里的 shellIntegrationEnabled 决定是否写注册表，
 * 因此这里的文件名与 key 必须与 src-tauri/src/config.rs 保持一致。
 */

import { load, type Store } from '@tauri-apps/plugin-store'

import { SETTINGS_STORE_FILE, SHELL_INTEGRATION_ENABLED_KEY } from '../config'

let storePromise: Promise<Store> | null = null

const getStore = (): Promise<Store> => {
  if (!storePromise) {
    storePromise = load(SETTINGS_STORE_FILE, { autoSave: false }).catch((error) => {
      // 读取失败时不要缓存这个 Promise，允许下次重试。
      storePromise = null
      throw error
    })
  }

  return storePromise
}

/**
 * 是否允许应用管理 Explorer 右键菜单。
 *
 * 默认 true：保留"装好即注册"的既有行为；
 * 用户在界面上关掉之后写入 false，以后启动不再触碰注册表。
 */
export async function getShellIntegrationEnabled(): Promise<boolean> {
  try {
    const store = await getStore()
    const value = await store.get<boolean>(SHELL_INTEGRATION_ENABLED_KEY)
    return value !== false
  } catch {
    return true
  }
}

export async function setShellIntegrationEnabled(enabled: boolean): Promise<void> {
  const store = await getStore()
  await store.set(SHELL_INTEGRATION_ENABLED_KEY, enabled)
  await store.save()
}
