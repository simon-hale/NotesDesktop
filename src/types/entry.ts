/** 目录 / 文件通用操作目标。 */
export interface EntryRef {
  kind: 'directory' | 'file'
  id: number
  name: string
}
