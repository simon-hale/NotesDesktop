<script setup lang="ts">
/** 面包屑：root > Documents > ...，最后一段是当前目录，不可点击。 */
import type { Breadcrumb } from '../types'

defineProps<{
  items: Breadcrumb[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  navigate: [index: number]
}>()

const handleClick = (index: number): void => {
  emit('navigate', index)
}
</script>

<template>
  <nav class="crumbs" aria-label="目录路径">
    <template v-for="(item, index) in items" :key="item.id">
      <span v-if="index > 0" class="crumbs__separator" aria-hidden="true">›</span>
      <button
        v-if="index < items.length - 1"
        class="crumbs__item"
        type="button"
        :disabled="disabled"
        @click="handleClick(index)"
      >
        {{ item.name }}
      </button>
      <span v-else class="crumbs__item crumbs__item--current">{{ item.name }}</span>
    </template>
  </nav>
</template>

<style scoped>
.crumbs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
  overflow: hidden;
}

.crumbs__separator {
  color: var(--text-faint);
}

.crumbs__item {
  max-width: 220px;
  overflow: hidden;
  padding: 3px 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumbs__item:hover:not(:disabled) {
  background: var(--primary-soft);
}

.crumbs__item--current {
  color: var(--text);
  font-weight: 600;
  cursor: default;
}
</style>
