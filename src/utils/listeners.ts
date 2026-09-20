import type { UnlistenFn } from '@tauri-apps/api/event'

/**
 * 统一的 Tauri 事件监听管理器。
 *
 * Tauri 的 `listen()` / `onCloseRequested()` 都是**异步注册**：
 * 如果组件在 Promise resolve 之前就卸载了，注册仍会完成，
 * 此时必须立刻 unlisten，否则会留下一个永远没人释放的监听。
 *
 * 用法：
 * ```ts
 * const listeners = createListenerRegistry()
 * onMounted(() => {
 *   void listeners.track(listen('evt', handler))
 *   void listeners.track(getCurrentWindow().onCloseRequested(handler))
 * })
 * onUnmounted(() => listeners.dispose())
 * ```
 */
export interface ListenerRegistry {
  /** 登记一个"正在注册中"的监听；若已经 dispose，则注册完成后立即释放。 */
  track: (registration: Promise<UnlistenFn>) => Promise<void>
  /** 释放全部已登记的监听（幂等，可重复调用）。 */
  dispose: () => void
}

export const createListenerRegistry = (): ListenerRegistry => {
  const unlisteners: UnlistenFn[] = []
  let disposed = false

  return {
    async track(registration: Promise<UnlistenFn>): Promise<void> {
      let unlisten: UnlistenFn

      try {
        unlisten = await registration
      } catch {
        // 注册失败（例如非 Tauri 环境下直接跑 vite dev）——没有需要释放的东西。
        return
      }

      if (disposed) {
        // 组件已经卸载：注册结果不能再留着。
        unlisten()
        return
      }

      unlisteners.push(unlisten)
    },

    dispose(): void {
      disposed = true

      while (unlisteners.length > 0) {
        unlisteners.pop()?.()
      }
    }
  }
}
