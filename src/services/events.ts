/**
 * 事件名常量。
 *
 * - `notes:upload-*` 与 `notes:prepare-exit` 是 Rust <-> 前端共用的，
 *   必须与 src-tauri/src/config.rs 中的常量保持一致；
 * - `notes:auth-*` 只在两个 WebView 之间广播，Rust 侧不参与。
 */

import { emitTo } from '@tauri-apps/api/event'

/** 待上传队列有新内容（数据本身在 Rust 侧队列里）。 */
export const EVENT_UPLOAD_PENDING = 'notes:upload-pending'

/** 上传窗口的目标目录建议发生变化。 */
export const EVENT_UPLOAD_TARGET = 'notes:upload-target'

/**
 * 跨窗口同步登录状态。
 *
 * main 与 upload 是两个独立 WebView，各自持有内存中的 JWT，
 * 必须通过事件互相通知，避免一边已登录、另一边还是旧状态。
 *
 * ⚠️ payload 只允许携带 username 这类非敏感信息：
 * **绝不把 JWT 放进事件里**，接收方始终从 Tauri Store 重新读取。
 */
export const EVENT_AUTH_CHANGED = 'notes:auth-changed'

/** 退出登录 / 令牌失效：所有窗口立即清空内存认证状态。 */
export const EVENT_LOGOUT = 'notes:logout'

/** Rust -> 上传窗口：主窗口要退出了，请取消上传并完成清理。 */
export const EVENT_PREPARE_EXIT = 'notes:prepare-exit'

/** 上传窗口的 label（定向发送通知时使用）。 */
export const UPLOAD_WINDOW_LABEL = 'upload'

/**
 * 通知上传窗口"Rust 队列里又有了待上传路径"。
 *
 * 典型场景：上传窗口已经挂载并隐藏着，用户又在首页选了文件。
 * Rust 的 `queue_upload_paths` 只入队不广播，所以这里补一次通知。
 *
 * 严格按照既有设计：**事件只是通知**，payload 里不放任何路径，
 * 上传窗口收到后会自己调用 `take_pending_upload_paths()` 取走真实数据。
 */
export const notifyUploadPending = async (): Promise<void> => {
  try {
    await emitTo(UPLOAD_WINDOW_LABEL, EVENT_UPLOAD_PENDING)
  } catch {
    // 上传窗口不存在 / 非 Tauri 环境：忽略。
    // 路径仍留在 Rust 队列里，上传窗口 mount 时会主动取走，不会丢。
  }
}
