/**
 * 上传流程共用的错误类型。
 *
 * 单独放一个模块是为了避免 upload.ts <-> transfer-credentials.ts 的循环依赖：
 * 凭证管理器也需要在"传输已被取消"时立刻抛出同一个错误类型。
 */

/** 上传被用户显式取消（或窗口/会话清理请求取消）。**这是破坏性路径。** */
export class UploadCanceledError extends Error {
  constructor() {
    super('上传已取消')
    this.name = 'UploadCanceledError'
  }
}

/**
 * 上传被请求**暂停**。
 *
 * 与取消严格区分：暂停不 abort multipart、不删除 checkpoint，
 * uploadId 与已完成分片全部保留，下次 Resume 从断点继续。
 */
export class UploadPausedError extends Error {
  constructor() {
    super('上传已暂停')
    this.name = 'UploadPausedError'
  }
}

/**
 * 无法把"上传活动状态"登记到 Rust 侧。
 *
 * 这个状态是退出逻辑的依据，属于关机正确性的一部分，因此**登记失败就不允许开始上传**，
 * 否则应用可能在有上传在跑时直接退出。
 */
export class UploadRegistrationError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? '未知原因')
    super(`无法登记上传状态，已取消本次上传：${detail}`)
    this.name = 'UploadRegistrationError'
  }
}
