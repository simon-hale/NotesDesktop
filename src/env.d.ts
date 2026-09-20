/// <reference types="vite/client" />

/**
 * 环境变量只允许在 src/config.ts 里读取。
 * VITE_* 会被打进客户端产物，所以这里只放"地址"类配置，绝不放任何 secret。
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
