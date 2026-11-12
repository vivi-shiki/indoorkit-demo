import { expect, type Page, test } from '@playwright/test';
import { openParking, type ParkingPage, pollParking } from '../e2e/parking-helpers';

/**
 * 停车场 5 个页面和 3D 页连真实后端（docs/backend/R5-10）。
 * 先 pnpm build、pnpm backend:up，再 pnpm e2e:live。
 */
const LIVE = process.env.INDOORKIT_LIVE_URL ?? 'ws://localhost:8080/ws';
const API = LIVE.replace(/^ws/, 'http').replace(/\/ws$/, '/api');
const query = `source=live&live=${encodeURIComponent(LIVE)}`;

/** 东京现在几点几分（分钟数） */
const tokyoMinutes = () => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(Date.now())
    .split(':')
    .map(Number);
  return h! * 60 + m!;
};

const openLive = async (page: Page, name: ParkingPage) => {
  await openParking(page, name, query);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-source', 'live');
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-state', 'open');
  // 真实时间：没有倍速，时刻是东京的现在
  await expect(page.getByTestId('speed-chip')).toHaveCount(0);
  const minutes = await page.evaluate(() => Math.floor(window.__parking!.time() / 60_000));
  expect(Math.abs(minutes - tokyoMinutes())).toBeLessThanOrEqual(1);
};

test('R5-10 the availability page shows the cars parked in the backend', async ({ page }) => {
  await openLive(page, 'availability');
  await pollParking(page, () => window.__parking!.stateCounts().occupied ?? 0).toBeGreaterThan(0);
  await pollParking(page, () => window.__parking!.stateCounts().free ?? 0).toBeGreaterThan(0);
});

test('R5-10 the vehicles page lists today’s entries from the backend', async ({ page }) => {
  await openLive(page, 'vehicles');
  await expect(page.getByTestId('event-list').locator('li').first()).toBeVisible();
  // 后端的停车 id 带日期
  const plate = await page.evaluate(() => window.__parking!.parkedPlate());
  expect(plate).toMatch(/\S/);
});

test('R5-10 the alerts page lists server alarms and acknowledges them through the backend', async ({
  page,
}) => {
  await openLive(page, 'alerts');
  await pollParking(page, () => window.__parking!.alarms().length).toBeGreaterThan(0);
  const ids = await page.evaluate(() => window.__parking!.alarms().map((a) => a.id));
  // 浏览器模拟的告警是 PA-00001；后端的带每次启动不同的前缀
  expect(ids.every((id) => /^[a-z0-9]+-PA-\d+$/.test(id))).toBe(true);

  const item = page
    .locator('[data-testid="alarm-item"]')
    .filter({ has: page.getByRole('button', { name: 'Mark as acknowledged' }) })
    .first();
  const id = (await item.getAttribute('data-alarm'))!;
  await item.getByRole('button', { name: 'Mark as acknowledged' }).click();
  expect(await page.evaluate((i) => window.__parking!.alarmState(i), id)).toBe('acknowledged');
  await expect
    .poll(async () => {
      const res = await fetch(`${API}/parking/alarms?state=open&limit=500`);
      const { alarms } = (await res.json()) as { alarms: { id: string; state: string }[] };
      return alarms.find((a) => a.id === id)?.state;
    })
    .toBe('acknowledged');
  // 刷新后状态来自后端
  await page.reload();
  await pollParking(page, () => window.__parking?.ready === true && window.__parking.page === 'alerts').toBe(
    true,
  );
  await expect
    .poll(() => page.evaluate((i) => window.__parking!.alarmState(i), id), { timeout: 20_000 })
    .toBe('acknowledged');
});

test('R5-10 the analytics page compares today with yesterday from the backend', async ({ page }) => {
  await openLive(page, 'analytics');
  await pollParking(page, () =>
    Object.values(window.__parking!.stateCounts()).reduce((a, b) => a + b, 0),
  ).toBeGreaterThan(0);
});

test('R5-10 the reserve page opens on the backend', async ({ page }) => {
  await openLive(page, 'reserve');
});

test('R5-10 the parking twin opens at the current hour', async ({ page }) => {
  await page.goto(`./#/parking/twin?${query}`);
  await expect(page.getByTestId('twin-status')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.locator('.clock')).toHaveText(
    `${String(Math.floor(tokyoMinutes() / 60)).padStart(2, '0')}:00`,
  );
});
