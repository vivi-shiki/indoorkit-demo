import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const TWIN = /(apps\/playground\/e2e|tools\/leak-bench)\/twin[^/]*\.spec\.ts$/;
const externalURL = process.env.INDOORKIT_TEST_BASE_URL;

export default defineConfig({
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  use: {
    baseURL: externalURL ?? `http://localhost:${PORT}/indoorkit-demo/`,
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    { name: 'e2e', testDir: 'apps/playground/e2e', testIgnore: TWIN },
    { name: 'leak-bench', testDir: 'tools/leak-bench', testIgnore: TWIN, workers: 1 },
    // 3D 孪生页在 SwiftShader 上用 CPU 渲染，两个同时跑会互相拖慢到超时（CI 只有 4 核）：
    // 单独一个项目、一次一个；超时放在项目上，连建 context 的时间也算进去
    { name: 'twin', testDir: '.', testMatch: TWIN, workers: 1, timeout: 150_000 },
    // 连真实后端的测试只在 pnpm e2e:live 时运行（docs/backend/README.md）
    ...(process.env.INDOORKIT_LIVE_URL
      ? [{ name: 'live', testDir: 'apps/playground/e2e-live', workers: 1 }]
      : []),
  ],
  webServer: externalURL
    ? undefined
    : {
        command: 'pnpm --filter playground run preview',
        url: `http://localhost:${PORT}/indoorkit-demo/`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
