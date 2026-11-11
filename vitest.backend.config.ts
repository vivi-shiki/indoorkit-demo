import { defineConfig } from 'vitest/config';

/** 后端集成测试：先 pnpm backend:up（docs/backend/README.md） */
export default defineConfig({
  test: {
    include: ['services/test/**/*.spec.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
