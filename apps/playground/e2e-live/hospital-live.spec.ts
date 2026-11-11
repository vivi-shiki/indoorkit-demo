import { expect, test } from '@playwright/test';
import { type Demo, openDemo, pollHook } from '../e2e/helpers';

/**
 * 医院其余四个页面连真实后端（docs/backend/R4-12..15）。
 * 先 pnpm build、pnpm backend:up，再 pnpm e2e:live。
 */
const LIVE = process.env.INDOORKIT_LIVE_URL ?? 'ws://localhost:8080/ws';
const API = LIVE.replace(/^ws/, 'http').replace(/\/ws$/, '/api');
const query = `source=live&live=${encodeURIComponent(LIVE)}`;

const openLive = async (page: import('@playwright/test').Page, demo: Demo) => {
  await openDemo(page, demo, query);
  await pollHook(page, () => window.__vivi!.liveStatus()).toMatchObject({ source: 'live', state: 'open' });
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-source', 'live');
  // 后端模式不起模拟器的 Worker
  expect(await page.evaluate(() => window.__viviStats!.activeWorkers)).toBe(0);
};

test('R4-12 the assets page shows only the backend assets', async ({ page }) => {
  await openLive(page, 'assets');
  await pollHook(page, () => window.__vivi!.clusterCount()).toBeGreaterThan(0);
  await pollHook(page, () => window.__vivi!.groupStatuses().length).toBeGreaterThan(0);
});

test('R4-12 the occupancy page builds its heat map from backend people', async ({ page }) => {
  await openLive(page, 'occupancy');
  await pollHook(page, () => window.__vivi!.heatPointCount()).toBeGreaterThan(2000);
});

test('R4-14 the trail page replays the history stored by the backend', async ({ page }) => {
  await openDemo(page, 'trail', `${query}&tag=P0001`);
  await pollHook(page, () => window.__vivi!.liveStatus().source).toBe('live');
  const [start, end] = await page.evaluate(() => window.__vivi!.trailRange());
  expect(end).toBeGreaterThan(start);
  // 后端轨迹是真实时间
  expect(Math.abs(end - Date.now())).toBeLessThan(5 * 60_000);
  await page.getByTestId('trail-play').click();
  await pollHook(page, () => window.__vivi!.trailTime()).toBeGreaterThan(start);
});

test('R4-13 the alerts page lists server alarms and acknowledges them through the backend', async ({
  page,
}) => {
  await openLive(page, 'alerts');
  await pollHook(page, () => window.__vivi!.alarmIds().length).toBeGreaterThan(0);
  const ids = await page.evaluate(() => window.__vivi!.alarmIds());
  expect(ids.every((id) => !id.startsWith('alarm-'))).toBe(true);

  const item = page.locator('[data-testid="alarm-item"].open').first();
  const id = (await item.getAttribute('data-alarm'))!;
  await item.getByRole('button', { name: /acknowledged|已确认|確認済み/ }).click();
  await expect.poll(() => page.evaluate((i) => window.__vivi!.alarmState(i), id)).toBe('acknowledged');
  await expect
    .poll(async () => {
      const res = await fetch(`${API}/hospital/alarms?state=open&limit=500`);
      const { alarms } = (await res.json()) as { alarms: { id: string; state: string }[] };
      return alarms.find((a) => a.id === id)?.state;
    })
    .toBe('acknowledged');
});
