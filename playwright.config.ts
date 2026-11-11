import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
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
    { name: 'e2e', testDir: 'apps/playground/e2e' },
    { name: 'leak-bench', testDir: 'tools/leak-bench', workers: 1 },
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
