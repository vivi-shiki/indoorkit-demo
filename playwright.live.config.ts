import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** 连真实后端的浏览器测试：先 pnpm build 和 pnpm backend:up（docs/backend/README.md） */
export default defineConfig({
  ...base,
  projects: [{ name: 'live', testDir: 'apps/playground/e2e-live' }],
  workers: 1,
});
