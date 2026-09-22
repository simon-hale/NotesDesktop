/**
 * 登录状态管理。
 *
 * 持久化使用 Tauri Store（auth.json），**不使用 WebView localStorage**。
 * Store 只承担"持久化"，它不是系统密钥链，也不是强加密保险箱。
 *
 * 认证失败的清理策略：
 *   - 只有**明确的认证失败**（HTTP 401 / 403）才清理持久化登录信息；
 *   - 普通断网 / 超时 / 5xx 一律保留令牌，只提示用户重试。
 *
 * 跨窗口同步：
 *   main 与 upload 是两个独立 WebView，各自持有内存中的 JWT。
 *   登录成功 / 退出登录 / 令牌失效都会广播 notes:auth-changed 或 notes:logout，
 *   其它窗口收到后**从 Store 重新读取**（事件里绝不携带 JWT）。
 */

import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { reactive } from 'vue'
import { load, type Store } from '@tauri-apps/plugin-store'

import { AUTH_STORE_FILE } from '../config'
import { EVENT_AUTH_CHANGED, EVENT_LOGOUT } from './events'
import {
  isAbortedError,
  isAuthFailure,
  requestAutoLogin,
  requestToken
} from './api'

export type AuthStatus =
  | 'initializing'
  | 'anonymous'
  | 'authenticated'
  | 'unreachable'

export interface AuthState {
  status: AuthStatus
  username: string
  message: string
}

export const authState = reactive<AuthState>({
  status: 'initializing',
  username: '',
  message: ''
})

const STORE_KEY_USERNAME = 'username'
const STORE_KEY_ACCESS = 'access'

let accessToken = ''
let storePromise: Promise<Store> | null = null
let activeController: AbortController | null = null

/**
 * 认证请求的代际号（session epoch）。
 *
 * 登录、退出、远端登录态变化、重试、初始化都会 `++authGeneration` 并 abort 上一个请求，
 * 所有在途请求在写状态前必须同时满足：
 *
 * ```ts
 * generation === authGeneration && verifiedToken === accessToken
 * ```
 *
 * 这样"为旧令牌发出的延迟 401"就永远不可能清掉一个更新的有效登录。
 */
let authGeneration = 0

const getStore = (): Promise<Store> => {
  if (!storePromise) {
    storePromise = load(AUTH_STORE_FILE, { autoSave: false }).catch((error) => {
      // 读取失败时不要缓存这个 Promise，允许下次重试。
      storePromise = null
      throw error
    })
  }

  return storePromise
}

/** 当前内存中的 JWT。只交给 api.ts 拼 Authorization 头，绝不外传。 */
export const getAccessToken = (): string => accessToken

/**
 * 作废所有在途认证请求：代际号 +1 并 abort 当前请求。
 * 不发起新请求（远端状态同步等场景用它）。
 */
const invalidateAuthRequests = (): void => {
  authGeneration += 1
  activeController?.abort()
  activeController = null
}

/** 开始一个新的认证请求：先作废旧的，再登记自己的代际号与 AbortController。 */
const beginAuthRequest = (): { generation: number; controller: AbortController } => {
  invalidateAuthRequests()

  const controller = new AbortController()
  activeController = controller

  return { generation: authGeneration, controller }
}

/** 这个请求是否仍然"既是最新一次认证动作、又对应当前令牌"。 */
const isCurrentAuthRequest = (generation: number, verifiedToken: string): boolean =>
  generation === authGeneration && verifiedToken === accessToken

const persist = async (username: string, token: string): Promise<void> => {
  const store = await getStore()
  await store.set(STORE_KEY_USERNAME, username)
  await store.set(STORE_KEY_ACCESS, token)
  await store.save()
}

const clearPersisted = async (): Promise<void> => {
  const store = await getStore()
  await store.delete(STORE_KEY_USERNAME)
  await store.delete(STORE_KEY_ACCESS)
  await store.save()
}

const readPersisted = async (reload: boolean): Promise<{ username: string; token: string }> => {
  const store = await getStore()

  if (reload) {
    // 另一个 WebView 可能刚写过同一个 Store，先与磁盘对齐再读。
    try {
      await store.reload()
    } catch {
      // reload 失败就按当前缓存读取。
    }
  }

  const username = (await store.get<string>(STORE_KEY_USERNAME)) ?? ''
  const token = (await store.get<string>(STORE_KEY_ACCESS)) ?? ''

  return { username, token }
}

const resetInMemory = (): void => {
  accessToken = ''
  authState.username = ''
}

/**
 * 会话变化事件的载荷。
 *
 * 只带**用户名**（账号标识），绝不携带 JWT：上传任务只按账号名归属，
 * 重试时一律使用"当时最新的"访问令牌。
 */
export interface SessionChange {
  /** 变化之前登录的账号（原本就未登录时为空串）。 */
  previousUsername: string
  /** 变化之后的账号：登出为空串，登录/换账号为新账号名。 */
  currentUsername: string
}

/** 会话被清空 / 账号发生变化时的订阅者。 */
type SessionChangeListener = (change: SessionChange) => void

const sessionChangeListeners = new Set<SessionChangeListener>()

/**
 * 订阅"会话被清空 / 登录账号发生变化"。
 *
 * 用于清理与账号绑定的模块级状态（上传任务、目标目录、当前浏览的目录等），
 * 避免上一个账号的状态泄漏到下一个账号。返回取消订阅函数。
 *
 * 这里用订阅而不是直接 import，是为了避免 auth <-> upload 的循环依赖。
 */
export const onSessionChanged = (listener: SessionChangeListener): (() => void) => {
  sessionChangeListeners.add(listener)

  return () => {
    sessionChangeListeners.delete(listener)
  }
}

const notifySessionChanged = (change: SessionChange): void => {
  // 复制一份再遍历：订阅者在回调里取消订阅也不会影响本次派发。
  for (const listener of [...sessionChangeListeners]) {
    try {
      listener(change)
    } catch {
      // 单个订阅者出错不影响其它订阅者。
    }
  }
}

/** 当前登录的用户名（未登录为空串）。只用于给上传任务打账号标记。 */
export const getCurrentUsername = (): string => authState.username

/** 另一个窗口的 label：登录态广播只发给它。 */
const otherWindowLabel = (): string => {
  try {
    return getCurrentWindow().label === 'upload' ? 'main' : 'upload'
  } catch {
    // 非 Tauri 环境（直接用浏览器跑 vite dev）：随便给一个标签，发送会被忽略。
    return 'main'
  }
}

/**
 * 广播登录态变化（**只由本地动作调用**），并且**只发给另一个窗口**。
 *
 * 用 `emitTo` 而不是全局 `emit`：发送方自己不会收到这条事件，
 * 因此不存在"处理自己发出的事件"的可能；配合"远端路径从不广播"的约定，
 * 事件不会形成回环，也就不需要任何全局抑制开关。
 */
const broadcast = async (event: string, payload?: unknown): Promise<void> => {
  try {
    await emitTo(otherWindowLabel(), event, payload)
  } catch {
    // 另一个窗口不存在或不在 Tauri 环境：忽略。
  }
}

/**
 * 清理内存认证状态 + 删除 Store 中的 username/access，回到登录界面。
 * 默认会广播给其它窗口；处理远端广播时不要再回播。
 *
 * 同时作废所有在途认证请求：退出登录之后，任何"旧令牌的延迟响应"都不得再写状态。
 * 并通知订阅者清理与账号绑定的状态（上传任务、目标目录、已浏览目录……）。
 */
async function clearSession(broadcastChange: boolean): Promise<void> {
  // 先记下"离开的是哪个账号"：订阅者需要它来判断哪些恢复任务还能留。
  const previousUsername = authState.username

  invalidateAuthRequests()

  resetInMemory()
  authState.status = 'anonymous'
  authState.message = ''

  // 先把"会话已清空"这一事实派发出去（订阅者的清理是异步的，不阻塞这里），
  // 再落盘删除持久化信息。
  notifySessionChanged({ previousUsername, currentUsername: '' })

  try {
    await clearPersisted()
  } catch {
    // 内存状态已经清理，Store 删除失败不影响退出登录。
  }

  if (broadcastChange) {
    await broadcast(EVENT_LOGOUT)
  }
}

/** 退出登录：清理内存 + Store，并通知所有窗口。 */
export async function logout(): Promise<void> {
  await clearSession(true)
}

/** 用户名 + 密码登录。 */
export async function login(username: string, password: string): Promise<void> {
  // 登录前后的账号名：订阅者据此决定上一个账号遗留的恢复任务要不要丢掉。
  const previousUsername = authState.username

  const { generation, controller } = beginAuthRequest()
  authState.message = ''

  try {
    const token = await requestToken(username, password, controller.signal)

    // 期间发生了 logout / 远端登录态变化 / 新的一次登录：丢弃这次结果。
    if (generation !== authGeneration) return

    accessToken = token
    authState.username = username
    authState.status = 'authenticated'

    // 账号变了（含"从未登录 -> 登录"）：通知订阅者按新账号清理/保留状态。
    if (previousUsername !== username) {
      notifySessionChanged({ previousUsername, currentUsername: username })
    }

    let persisted = true

    try {
      await persist(username, token)
    } catch {
      persisted = false
      authState.message = '登录成功，但本地登录信息保存失败，下次启动需要重新登录。'
    }

    if (persisted && generation === authGeneration) {
      // 只广播 username，JWT 不进事件；其它窗口自己去 Store 取。
      await broadcast(EVENT_AUTH_CHANGED, { username })
    }
  } finally {
    if (activeController === controller) {
      activeController = null
    }
  }
}

/**
 * 用持久化的令牌调用 /api/user/auto-login/ 恢复登录。
 *
 * 只有在"仍然是最新一次认证动作，且验证的就是当前令牌"时才允许写状态或清理凭证，
 * 因此旧令牌的延迟 401 不可能清掉一个更新的有效登录。
 */
async function verifyStoredLogin(token: string): Promise<void> {
  const { generation, controller } = beginAuthRequest()

  try {
    await requestAutoLogin(token, controller.signal)

    if (!isCurrentAuthRequest(generation, token)) return

    authState.status = 'authenticated'
    authState.message = ''
  } catch (error) {
    // 旧请求（已被登录/退出/远端变化作废）：什么都不要做，尤其是不能清凭证。
    if (!isCurrentAuthRequest(generation, token)) return

    if (isAbortedError(error)) {
      return
    }

    if (isAuthFailure(error)) {
      // 清凭证之前再核对一次 Store：如果里面已经是一个**更新的**令牌，
      // 说明这次 401 属于已经被取代的旧令牌（例如另一个窗口刚登录完，
      // 而这条响应抢在 auth-changed 事件之前返回）——绝不能清掉新凭据。
      let persisted: { username: string; token: string } | null = null

      try {
        persisted = await readPersisted(true)
      } catch {
        persisted = null
      }

      // 等待期间又发生了登录 / 退出 / 远端变化：本次结果一律作废。
      if (generation !== authGeneration) return

      if (persisted && persisted.token && persisted.token !== token) {
        // 采纳更新的令牌，而不是把界面踢回登录页。
        accessToken = persisted.token
        authState.username = persisted.username
        authState.status = 'authenticated'
        authState.message = ''
        return
      }

      // 令牌确实已经失效：清理持久化登录信息，并让其它窗口一起回到登录页。
      await clearSession(true)
      authState.message = '登录状态已失效，请重新登录。'
      return
    }

    // 断网 / 超时 / 5xx：保留令牌，让用户重试或主动退出登录。
    authState.status = 'unreachable'
    authState.message =
      error instanceof Error ? error.message : '无法连接后端，请检查网络'
  } finally {
    if (activeController === controller) {
      activeController = null
    }
  }
}

/**
 * 应用启动后调用一次：
 * 存在 username/access 就调用 auto-login，否则进入登录界面。
 */
export async function initAuth(): Promise<void> {
  // 初始化同样作废旧请求，保证后面写入的状态一定来自最新一次初始化。
  invalidateAuthRequests()
  const generation = authGeneration

  authState.status = 'initializing'
  authState.message = ''

  let persisted: { username: string; token: string }

  try {
    persisted = await readPersisted(false)
  } catch {
    if (generation !== authGeneration) return

    resetInMemory()
    authState.status = 'anonymous'
    authState.message = '本地登录信息读取失败，请重新登录。'
    return
  }

  // 读取期间发生了登录 / 退出 / 远端登录态变化：这次初始化已经过期，直接放弃，
  // 否则会把过期的令牌写回内存。
  if (generation !== authGeneration) return

  if (!persisted.username.trim() || !persisted.token.trim()) {
    resetInMemory()
    authState.status = 'anonymous'
    return
  }

  authState.username = persisted.username
  accessToken = persisted.token

  await verifyStoredLogin(persisted.token)
}

/** 断网等场景下的"重试自动登录"。 */
export async function retryAutoLogin(): Promise<void> {
  if (!accessToken) {
    authState.status = 'anonymous'
    return
  }

  authState.status = 'initializing'
  authState.message = ''

  await verifyStoredLogin(accessToken)
}

/**
 * 其它窗口登录成功后：采纳新令牌并切换为已登录。
 *
 * 顺序很重要：**必须在第一个 await 之前作废在途请求**。
 * 否则本窗口为旧令牌发出的 auto-login 若在"读 Store"期间返回 401，
 * 就会走 `clearSession` 把刚写入的新凭据清掉。
 *
 * 本函数**从不广播**：广播只属于本地登录/退出动作。
 */
async function applyRemoteAuthChange(): Promise<void> {
  // 作废旧请求与捕获代际号之间没有 await，
  // 所以这里拿到的就是"本次远端变化"对应的代际。
  invalidateAuthRequests()
  const generation = authGeneration

  let persisted: { username: string; token: string }

  try {
    persisted = await readPersisted(true)
  } catch {
    // 读取失败时保持当前状态，等下一次事件或用户手动重试。
    return
  }

  // 读取期间又发生了登录 / 退出 / 另一次远端变化：
  // 这次远端变化的结果已经过期，绝不能覆盖更新的认证状态。
  if (generation !== authGeneration) return

  if (!persisted.username.trim() || !persisted.token.trim()) {
    return
  }

  if (persisted.token === accessToken) {
    // 令牌没变。上面的作废可能刚好打断了本窗口对同一个令牌的验证，
    // 这时需要重新发起一次，避免停在 initializing。
    if (authState.status !== 'authenticated') {
      await verifyStoredLogin(persisted.token)
    }

    return
  }

  const previousUsername = authState.username

  accessToken = persisted.token
  authState.username = persisted.username
  authState.status = 'authenticated'
  authState.message = ''

  // 账号变了（含"本窗口原本未登录 -> 采纳其它窗口的登录"）：
  // 通知订阅者按新账号清理/保留状态。
  // 注意这里也要覆盖 previousUsername 为空串的情况——否则上一个账号遗留的
  // 恢复任务会在新账号登录后继续留在列表里。
  if (previousUsername !== persisted.username) {
    notifySessionChanged({ previousUsername, currentUsername: persisted.username })
  }
}

/**
 * 其它窗口退出登录 / 令牌失效：本地清理但**不回播**。
 * `clearSession(false)` 内部同样会先作废在途请求。
 */
async function applyRemoteLogout(): Promise<void> {
  await clearSession(false)
}

/** 监听"其它窗口登录成功"。返回值交给 createListenerRegistry 统一释放。 */
export const listenAuthChanged = (): Promise<UnlistenFn> =>
  listen(EVENT_AUTH_CHANGED, () => {
    void applyRemoteAuthChange()
  })

/** 监听"其它窗口退出登录 / 令牌失效"。 */
export const listenLogout = (): Promise<UnlistenFn> =>
  listen(EVENT_LOGOUT, () => {
    void applyRemoteLogout()
  })

/** 窗口卸载时取消进行中的认证请求，并让它们的结果失效。 */
export function disposeAuth(): void {
  invalidateAuthRequests()
}
