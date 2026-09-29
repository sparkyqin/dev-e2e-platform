import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Platform 持有 setInterval / 文件锁：forks 池隔离更稳；文件间串行避免磁盘争抢
    pool: 'forks',
    fileParallelism: false,
  },
})
