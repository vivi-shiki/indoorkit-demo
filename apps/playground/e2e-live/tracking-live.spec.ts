import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openDemo, pollHook } from '../e2e/helpers';

/**
 * 人员定位页连真实后端（docs/backend/R2-12..14、R3-12）。
 * 先 pnpm build、pnpm backend:up，再 pnpm e2e:live。
 */
const LIVE = process.env.INDOORKIT_LIVE_URL ?? 'ws://localhost:8080/ws';
const COMPOSE = join(import.meta.dirname, '../../../deploy/compose.yaml');
const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', COMPOSE, ...args], { encoding: 'utf8' });

test.afterAll(() => {
  compose('up', '-d', '--wait');
});

test('R2-12..14 tracking shows backend positions, falls back to the simulator and comes back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDemo(page, 'tracking', `source=auto&live=${encodeURIComponent(LIVE)}`);
  await pollHook(page, () => window.__vivi!.liveStatus()).toMatchObject({ source: 'live', state: 'open' });
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-source', 'live');
  await expect(page.getByTestId('fixed-tags')).toBeVisible();
  // 标签确实在动，而且数量是后端的 2000
  await pollHook(page, () => window.__vivi!.perf().tags).toBe(2000);
  const before = await page.evaluate(() => window.__vivi!.tagScreenPoint());
  expect(before).not.toBeNull();

  compose('stop', 'gateway');
  await pollHook(page, () => window.__vivi!.liveStatus().source).toBe('sim');
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-source', 'sim');
  await pollHook(page, () => window.__viviStats!.activeWorkers).toBe(1);

  compose('start', 'gateway');
  await expect
    .poll(() => page.evaluate(() => window.__vivi!.liveStatus()), { timeout: 60_000 })
    .toMatchObject({ source: 'live', state: 'open' });
  // 切回后端时模拟器的 Worker 已释放
  await pollHook(page, () => window.__viviStats!.activeWorkers).toBe(0);
});

test('R3-05, R3-12 a gateway restart is bridged by resending, not by falling back', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page, 'tracking', `source=live&live=${encodeURIComponent(LIVE)}`);
  await pollHook(page, () => window.__vivi!.liveStatus().state).toBe('open');
  compose('restart', 'gateway');
  await expect
    .poll(() => page.evaluate(() => window.__vivi!.liveStatus()), { timeout: 60_000 })
    .toMatchObject({ source: 'live', state: 'open', replayed: expect.any(Number) });
  const status = await page.evaluate(() => window.__vivi!.liveStatus());
  expect(status.replayed).toBeGreaterThan(0);
  await expect(page.getByTestId('live-status')).toContainText(/Resent|补发|再送/);
  expect(await page.evaluate(() => window.__viviStats!.activeWorkers)).toBe(0);
});

test('the default simulated page never opens a socket', async ({ page }) => {
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await openDemo(page, 'tracking');
  expect(await page.evaluate(() => window.__vivi!.liveStatus())).toMatchObject({
    mode: 'sim',
    source: 'sim',
  });
  await expect(page.getByTestId('live-status')).toHaveCount(0);
  expect(sockets).toEqual([]);
});
