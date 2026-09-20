<script setup lang="ts">
/**
 * 首页主体：以文件管理器列表形式展示文件夹与文件。
 * 双击目录进入；每一项提供 Rename / Delete。
 */
import { computed } from 'vue'

import type { EntryRef } from '../types/entry'
import type { DirectoryItem, FileItem } from '../types'

const props = defineProps<{
  directories: DirectoryItem[]
  files: FileItem[]
  busy: boolean
}>()

const emit = defineEmits<{
  open: [directory: DirectoryItem]
  rename: [entry: EntryRef]
  remove: [entry: EntryRef]
}>()

const isEmpty = computed(
  () => props.directories.length === 0 && props.files.length === 0
)

const handleOpen = (directory: DirectoryItem): void => {
  emit('open', directory)
}

const handleRename = (entry: EntryRef): void => {
  emit('rename', entry)
}

const handleRemove = (entry: EntryRef): void => {
  emit('remove', entry)
}

const fileMeta = (file: FileItem): string => {
  const type = file.type && file.type !== 'null' ? file.type.toUpperCase() : '文件'
  const modified = file.last_modified_time ? ` · ${file.last_modified_time}` : ''

  return `${type}${modified}`
}
</script>

<template>
  <div class="list">
    <p v-if="isEmpty" class="list__empty">此目录为空</p>

    <template v-else>
      <section v-if="directories.length > 0" class="list__section">
        <h2 class="list__heading">文件夹 · {{ directories.length }}</h2>
        <ul class="list__items">
          <li
            v-for="directory in directories"
            :key="`dir-${directory.id}`"
            class="row"
            @dblclick="handleOpen(directory)"
          >
            <span class="row__icon row__icon--folder" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="18" height="18">
                <path
                  fill="currentColor"
                  d="M2.5 5.2c0-.7.6-1.2 1.2-1.2h3.1c.4 0 .7.2.9.5l.7 1h7c.7 0 1.2.5 1.2 1.2v8.1c0 .7-.6 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2V5.2Z"
                />
              </svg>
            </span>
            <button
              class="row__name row__name--button"
              type="button"
              :disabled="busy"
              :title="directory.name"
              @click="handleOpen(directory)"
            >
              {{ directory.name }}
            </button>
            <span class="row__meta">文件夹</span>
            <span class="row__actions">
              <button
                class="btn btn--ghost btn--small"
                type="button"
                :disabled="busy"
                @click="handleRename({ kind: 'directory', id: directory.id, name: directory.name })"
              >
                重命名
              </button>
              <button
                class="btn btn--danger btn--small"
                type="button"
                :disabled="busy"
                @click="handleRemove({ kind: 'directory', id: directory.id, name: directory.name })"
              >
                删除
              </button>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="files.length > 0" class="list__section">
        <h2 class="list__heading">文件 · {{ files.length }}</h2>
        <ul class="list__items">
          <li v-for="file in files" :key="`file-${file.id}`" class="row">
            <span class="row__icon row__icon--file" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="18" height="18">
                <path
                  fill="currentColor"
                  d="M5.2 2.5h5.4l4.2 4.2v10.1c0 .7-.6 1.2-1.2 1.2H5.2c-.7 0-1.2-.5-1.2-1.2V3.7c0-.7.5-1.2 1.2-1.2Zm5 1.5v3.2h3.2L10.2 4Z"
                />
              </svg>
            </span>
            <span class="row__name" :title="file.name">{{ file.name }}</span>
            <span class="row__meta">{{ fileMeta(file) }}</span>
            <span class="row__actions">
              <button
                class="btn btn--ghost btn--small"
                type="button"
                :disabled="busy"
                @click="handleRename({ kind: 'file', id: file.id, name: file.name })"
              >
                重命名
              </button>
              <button
                class="btn btn--danger btn--small"
                type="button"
                :disabled="busy"
                @click="handleRemove({ kind: 'file', id: file.id, name: file.name })"
              >
                删除
              </button>
            </span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.list {
  padding: 6px 0;
}

.list__empty {
  padding: 40px 0;
  color: var(--text-faint);
  text-align: center;
}

.list__section + .list__section {
  margin-top: 8px;
}

.list__heading {
  margin: 6px 12px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.list__items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  transition: background-color var(--transition);
}

.row:hover {
  background: var(--surface-hover);
}

.row__icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.row__icon--folder {
  color: #e0a33a;
}

.row__icon--file {
  color: var(--text-faint);
}

.row__name {
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__name--button {
  padding: 2px 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
}

.row__name--button:hover:not(:disabled) {
  color: var(--primary);
}

.row__meta {
  color: var(--text-faint);
  font-size: 12px;
  white-space: nowrap;
}

.row__actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--transition);
}

.row:hover .row__actions,
.row:focus-within .row__actions {
  opacity: 1;
}
</style>
