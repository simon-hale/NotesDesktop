<script setup lang="ts">
/** 上传窗口中的单条任务：文件名 / 大小 / 进度 / 状态 / 失败原因 / 重试 / 移除。 */
import { computed } from 'vue'

import type { UploadTask } from '../types'
import { isMetadataPendingTask } from '../services/upload'
import { formatBytes, formatPercent } from '../utils/format'

const props = defineProps<{
  task: UploadTask
}>()

const emit = defineEmits<{
  retry: [taskId: string]
  remove: [taskId: string]
}>()

const STATUS_LABELS: Record<UploadTask['status'], string> = {
  pending: '等待上传',
  uploading: '上传中',
  success: '已完成',
  error: '失败',
  canceled: '已取消'
}

const statusLabel = computed(() => STATUS_LABELS[props.task.status])

const canRetry = computed(
  () => props.task.status === 'error' || props.task.status === 'canceled'
)

/**
 * "OSS 已成功但元数据待补写"的任务不允许移除：
 * 丢掉它等于永久遗留一个 OSS 上存在、files 表里却没有记录的对象。
 * 这类任务只能重试（补写数据库）。
 */
const canRemove = computed(
  () =>
    props.task.status !== 'uploading' &&
    props.task.status !== 'pending' &&
    !isMetadataPendingTask(props.task)
)
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
        :class="{
          'progress__bar--error': task.status === 'error',
          'progress__bar--success': task.status === 'success'
        }"
        :style="{ width: `${Math.round(Math.min(1, Math.max(0, task.progress)) * 100)}%` }"
      />
    </div>

    <p v-if="task.message" class="item__message" :class="{ 'item__message--error': task.status === 'error' }">
      {{ task.message }}
    </p>

    <div class="item__actions">
      <button
        v-if="canRetry"
        class="btn btn--small"
        type="button"
        @click="emit('retry', task.id)"
      >
        重试
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
