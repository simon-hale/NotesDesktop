/**
 * Rust 侧本地文件 / 队列 / 窗口命令的薄封装。
 *
 * 这里不做任何"读整个文件"的操作：
 *   - statLocalFile 只拿元信息；
 *   - readFileChunk 每次只取一个分片的原始字节（ArrayBuffer）。
 */

import { invoke } from '@tauri-apps/api/core'

import type {
  Breadcrumb,
  LocalFileInfo,
  QueueUploadResult,
  ShellIntegrationStatus,
  UploadTargetHint
} from '../types'

/** 读取本地文件元信息（存在性 + 普通文件校验 + 文件名/大小/绝对路径）。 */
export const statLocalFile = (path: string): Promise<LocalFileInfo> =>
  invoke<LocalFileInfo>('stat_local_file', { path })

/**
 * 读取一个分片。
 *
 * Rust 侧以 `tauri::ipc::Response::new(bytes)` 返回原始二进制，
 * 前端拿到的就是 ArrayBuffer —— 没有 base64，也没有 JSON 序列化。
 */
export const readFileChunk = (
  path: string,
  offset: number,
  length: number
): Promise<ArrayBuffer> =>
  invoke<ArrayBuffer>('read_file_chunk', { path, offset, length })

/** 把本地绝对路径放进 Rust 侧待上传队列（首页选择文件后调用）。 */
export const queueUploadPaths = (paths: string[]): Promise<QueueUploadResult> =>
  invoke<QueueUploadResult>('queue_upload_paths', { paths })

/**
 * 取走待上传队列。
 *
 * 上传窗口 mount 时主动调用一次，因此不存在"listener 未就绪导致路径丢失"的问题：
 * 事件只是通知，真正的数据一直放在 Rust 侧。
 */
export const takePendingUploadPaths = (): Promise<string[]> =>
  invoke<string[]>('take_pending_upload_paths')

/**
 * 显示并聚焦上传窗口。
 *
 * `breadcrumbs` 是**完整**目标目录路径（root 到当前目录），
 * 上传窗口用它推导 string_of_path；不传时上传窗口保留自己已有的目标目录。
 */
export const openUploadWindow = (breadcrumbs?: Breadcrumb[]): Promise<void> =>
  invoke<void>('open_upload_window', {
    target:
      breadcrumbs && breadcrumbs.length > 0
        ? breadcrumbs.map((item) => ({ id: item.id, name: item.name }))
        : null
  })

/** 取走目标目录建议（取走即清空，避免用到过期建议）。 */
export const takeUploadTargetHint = (): Promise<UploadTargetHint | null> =>
  invoke<UploadTargetHint | null>('take_upload_target_hint')

/**
 * 显式上报"是否有上传在跑"。
 *
 * 两种语义不同：
 *   - `setUploadActive(true)` 是 **fail-closed** 的：它是退出逻辑的依据，
 *     属于关机正确性的一部分，**必须成功**才允许开始上传。
 *     调用方（startUpload）在失败时会直接放弃本次上传并复位运行态。
 *   - `setUploadActive(false)` 是 **best-effort** 的：在整轮上传的最终清理路径
 *     （成功 / 失败 / 取消都会走到）里调用，失败只做一次轻量重试后放弃，
 *     Rust 侧的退出等待仍有硬超时兜底。
 */
export const setUploadActive = (active: boolean): Promise<void> =>
  invoke<void>('set_upload_active', { active })

/** 查询 Rust 侧记录的上传活动状态（首页关闭确认等场景使用）。 */
export const uploadActive = (): Promise<boolean> => invoke<boolean>('upload_active')

/**
 * 上报"上传窗口里这一批是否已被占用"。
 *
 * 与 `setUploadActive` 是两件事，勿混淆：
 *   - `setUploadActive` 只表示"此刻有上传在跑"，服务退出逻辑；
 *   - 这个状态表示"已经有一批任务占着全局唯一的目标目录"，
 *     用于阻止首页在前一批没处理完时再开一批。
 *
 * 由**上传窗口**在任务列表变化时写入；首页只读。
 */
export const setUploadBatchBusy = (busy: boolean): Promise<void> =>
  invoke<void>('set_upload_batch_busy', { busy })

/** 查询"这一批是否已被占用"（首页开新批次前检查）。 */
export const uploadBatchBusy = (): Promise<boolean> =>
  invoke<boolean>('upload_batch_busy')

/** 退出整个应用（Rust 侧会先通知上传窗口清理，再带超时退出）。 */
export const quitApp = (): Promise<void> => invoke<void>('quit_app')

/**
 * 上传窗口完成清理后调用，通知 Rust 侧可以真正退出了。
 * Rust 自己也有超时兜底，所以这个调用失败不会卡住退出。
 */
export const confirmExitReady = (): Promise<void> =>
  invoke<void>('confirm_exit_ready')

/** 查询资源管理器右键集成状态。 */
export const getShellIntegrationStatus = (): Promise<ShellIntegrationStatus> =>
  invoke<ShellIntegrationStatus>('shell_integration_status')

/** 注册资源管理器右键集成（幂等）。 */
export const installShellIntegration = (): Promise<ShellIntegrationStatus> =>
  invoke<ShellIntegrationStatus>('install_shell_integration')

/** 卸载资源管理器右键集成。 */
export const uninstallShellIntegration = (): Promise<ShellIntegrationStatus> =>
  invoke<ShellIntegrationStatus>('uninstall_shell_integration')
