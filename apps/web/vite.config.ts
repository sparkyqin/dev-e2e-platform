import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ai-platform/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 本机 Windows 文件事件不可靠（styles.css 两次漏编辑事件 → 浏览器旧 CSS + 新 DOM 混搭）
    // 改用轮询监听，以微小 CPU 开销换确定性热更新
    watch: { usePolling: true, interval: 400 },
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
})
