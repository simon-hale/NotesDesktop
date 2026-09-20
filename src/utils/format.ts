/** 展示用的格式化工具。 */

/** 文件大小：B / KB / MB / GB / TB。 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`
}

/** 0 ~ 1 -> 百分比整数。 */
export const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) return '0%'

  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
}
