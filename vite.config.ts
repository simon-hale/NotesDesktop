import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Notes Desktop 前端使用固定端口，Tauri 的 devUrl 与此保持一致。
const DEV_SERVER_PORT = 1420

// Tauri CLI 会在调用 beforeDevCommand / beforeBuildCommand 时注入
// TAURI_ENV_PLATFORM（windows / darwin / linux / android / ios）。
const TAURI_ENV_PLATFORM = process.env.TAURI_ENV_PLATFORM

export default defineConfig({
  plugins: [vue()],

  // Tauri CLI 会接管控制台输出，不要让 Vite 清屏。
  clearScreen: false,

  server: {
    port: DEV_SERVER_PORT,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // src-tauri 由 cargo 自己监听，Vite 不必重复扫描。
      ignored: ['**/src-tauri/**']
    }
  },

  // VITE_* 会被打进产物；TAURI_ENV_* 由 Tauri CLI 注入，供前端读取平台等构建期信息。
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  build: {
    // 按平台选择目标：Windows 用 WebView2（Chromium 内核），
    // macOS / Linux 用 WebKit，必须回落到 safari13 才能正常构建与运行。
    target: TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500
  }
})
