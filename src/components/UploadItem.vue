<script setup lang="ts">
/**
 * 上传窗口中的单条任务。
 *
 * 按钮语义（**暂停与取消必须一眼分清**）：
 *   - 上传中       → 暂停             （保留 uploadId 与已完成分片，绝不 abort）
 *   - 已暂停       → 继续 | 取消上传   （取消上传才是破坏性操作）
 *   - 登记元数据中 → 重试             （只补写 /api/file/insert/，绝不重传对象）
 *   - 已中断       → 继续 | 移除       （移除会对残留的 multipart 做破坏性清理）
 *   - 其它         → 移除 / 重试
 */
import { computed } from 'vue'

import type { UploadTask } from '../types'
import { isMetadataPendingTask } from '../services/upload'
import { formatBytes, formatPercent } from '../utils/format'

const props = defineProps<{
  task: UploadTask
}>()

const emit = defineEmits<{
  resume: [taskId: string]
  pause: [taskId: string]
  cancel: [taskId: string]
  remove: [taskId: string]
}>()

const STATUS_LABELS: Record<UploadTask['status'], string> = {
  pending: '等待上传',
  uploading: '上传中',
  pausing: '正在暂停…',
  paused: '已暂停',
  metadata_pending: '正在登记文件信息…',
  success: '已完成',
  error: '已中断（可继续）',
  canceled: '已取消'
}

const statusLabel = computed(() => STATUS_LABELS[props.task.status])

/** 只有真正在传的时候才谈得上暂停。 */
const canPause = computed(() => props.task.status === 'uploading')

/**
 * 可以"继续"的状态：暂停 / 可恢复错误 / 已取消 / 元数据待补写。
 * 元数据待补写时"继续"等价于只重试 /api/file/insert/。
 */
const canResume = computed(
  () =>
    props.task.status === 'paused' ||
    props.task.status === 'error' ||
    props.task.status === 'canceled' ||
    props.task.status === 'metadata_pending'
)

/** 暂停 / 中断的任务里可能还留着远端 multipart，"取消上传"才是清掉它的路径。 */
const canCancel = computed(() => props.task.status === 'paused')

/**
 * "OSS 已成功但元数据待补写"的任务不允许移除：
 * 丢掉它等于永久遗留一个 OSS 上存在、files 表里却没有记录的对象。
 * 这类任务只能重试（补写数据库）。
 */
const canRemove = computed(
  () =>
    props.task.status !== 'uploading' &&
    props.task.status !== 'pausing' &&
    !isMetadataPendingTask(props.task)
)

const progressBarClass = computed(() => ({
  'progress__bar--error': props.task.status === 'error',
  'progress__bar--success': props.task.status === 'success',
  'progress__bar--paused':
    props.task.status === 'paused' ||
    props.task.status === 'pausing' ||
    props.task.status === 'pending'
}))
</script>

<template>
  <li class="item" :class="`item--${task.status}`">
    <div class="item__head">
      <span class="item__name" :title="task.path">{{ task.name }}</span>
      <span class="item__status">{{ statusLabel }}</span>
    </div>

    <div class="item__meta">
      <span>{{ formatBytes(task.size) }}</span>
      <span class="item__percent">{{ formatPercent(task.progress) }}</span>
    </div>

    <div class="progress">
      <div
        class="progress__bar"
        :class="progressBarClass"
        :style="{ width: `${Math.round(Math.min(1, Math.max(0, task.progress)) * 100)}%` }"
      />
    </div>

    <p v-if="task.message" class="item__message" :class="{ 'item__message--error': task.status === 'error' }">
      {{ task.message }}
    </p>

    <div class="item__actions">
      <button
        v-if="canPause"
        class="btn btn--small"
        type="button"
        @click="emit('pause', task.id)"
      >
        暂停
      </button>
      <button
        v-if="canResume"
        class="btn btn--small"
        type="button"
        @click="emit('resume', task.id)"
      >
        {{ task.status === 'metadata_pending' ? '重试' : '继续' }}
      </button>
      <button
        v-if="canCancel"
        class="btn btn--danger btn--small"
        type="button"
        @click="emit('cancel', task.id)"
      >
        取消上传
      </button>
      <button
        v-if="canRemove"
        class="btn btn--ghost btn--small"
        type="button"
        @click="emit('remove', task.id)"
      >
        移除
      </button>
    </div>
  </li>
</template>

<style scoped>
.item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.item--success {
  border-color: rgba(31, 146, 84, 0.35);
}

.item--error {
  border-color: rgba(214, 69, 69, 0.35);
}

.item--paused,
.item--pausing {
  border-color: rgba(183, 121, 31, 0.35);
}

.item--metadata_pending {
  border-color: var(--primary);
}

.item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.item__name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item__status {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.item--success .item__status {
  color: var(--success);
}

.item--error .item__status {
  color: var(--danger);
}

.item--paused .item__status,
.item--pausing .item__status {
  color: var(--warning);
}

.item--metadata_pending .item__status {
  color: var(--primary);
}

.item__meta {
  display: flex;
  justify-content: space-between;
  color: var(--text-faint);
  font-size: 11px;
}

.progress {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-muted);
}

.progress__bar {
  height: 100%;
  border-radius: 999px;
  background: var(--primary);
  transition: width 160ms ease;
}

.progress__bar--success {
  background: var(--success);
}

.progress__bar--error {
  background: var(--danger);
}

.progress__bar--paused {
  background: var(--warning);
}

.item__message {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  word-break: break-word;
}

.item__message--error {
  color: var(--danger);
}

.item__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.item__actions:empty {
  display: none;
}
</style>
