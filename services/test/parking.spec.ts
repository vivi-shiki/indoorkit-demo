import { type AlarmRecord, dayStartOf, type ServerFrame, SITE_TIME_ZONE } from '@indoorkit/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { compose, GATEWAY, rawClient, waitFor } from './helpers';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});
afterAll(() => {
  compose('up', '-d', '--wait');
});

interface DayEvent {
  id: string;
  ts: number;
  kind: string;
  visitId: string;
  vehicle?: unknown;
}
interface Day {
  timeZone: string;
  devices: { deviceId: string; status: string }[];
  reservations: { id: string }[];
  events: DayEvent[];
}

const list = async (state: 'open' | 'all', limit = 500) => {
  const res = await fetch(`${GATEWAY}/api/parking/alarms?state=${state}&limit=${limit}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { alarms: AlarmRecord[] }).alarms;
};

const snapshot = async () => {
  const c = rawClient({ type: 'subscribe', site: 'parking' });
  cleanup.push(c.close);
  const snap = await waitFor('parking snapshot', () => c.frames.find((f) => f.type === 'snapshot'));
  if (snap.type !== 'snapshot') throw new Error('not a snapshot');
  return { snap, day: snap.day as unknown as Day | undefined, frames: c.frames };
};

/** 同一条告警：规则、车位、设备、车牌和时刻都相同 */
const key = (a: AlarmRecord) =>
  [a.rule, a.time, (a as { bayId?: string }).bayId, a.deviceId, (a as { plate?: string }).plate].join('|');

describe('R5-04, R5-05 parking day in the snapshot', () => {
  it('carries the devices, the bookings and every event since yesterday 0:00', async () => {
    const { day } = await snapshot();
    expect(day).toBeDefined();
    expect(day!.timeZone).toBe(SITE_TIME_ZONE);
    expect(day!.devices.length).toBeGreaterThan(10);
    expect(day!.reservations.length).toBeGreaterThan(0);
    const today = dayStartOf(Date.now(), SITE_TIME_ZONE);
    const events = day!.events;
    // 补传从昨天 0 点开始
    expect(events.some((e) => e.ts < today)).toBe(true);
    expect(Math.min(...events.map((e) => e.ts))).toBeGreaterThanOrEqual(today - 86_400_000);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const e of events.filter((x) => x.kind === 'entry')) expect(e.vehicle).toBeDefined();
    // 现在场内有车：入场了、还没离开车位的
    const left = new Set(events.filter((e) => e.kind === 'leave').map((e) => e.visitId));
    const parked = events.filter((e) => e.kind === 'park' && !left.has(e.visitId));
    expect(parked.length).toBeGreaterThan(0);
  });
});

describe('R5-06 parking alarms', () => {
  it('lists open alarms from the minute check, each raised once', async () => {
    const open = await waitFor('parking alarms', async () => {
      const a = await list('open');
      return a.length > 0 ? a : null;
    });
    expect(open[0]!.id).toMatch(/-PA-\d+$/);
    const all = await list('all');
    expect(new Set(all.map(key)).size).toBe(all.length);
  });
});

describe('R5-07 restarts', () => {
  it('a device-sim restart backfills again without duplicate events or alarms, and pushes the booking', async () => {
    const before = (await snapshot()).day!.events;
    const c = rawClient({ type: 'subscribe', site: 'parking' });
    cleanup.push(c.close);
    await waitFor('snapshot', () => c.frames.find((f) => f.type === 'snapshot'));
    compose('restart', 'device-sim');
    // 重新连上时预约系统再发一次预约
    await waitFor(
      'booking site-event',
      () =>
        c.frames.find(
          (f: ServerFrame) =>
            f.type === 'site-event' &&
            (f.event as { type?: string }).type === 'booking' &&
            f.time > Date.now() - 60_000,
        ),
      60_000,
    );
    // 留时间给补传处理完
    await new Promise((r) => setTimeout(r, 5000));
    const after = (await snapshot()).day!.events;
    expect(new Set(after.map((e) => e.id)).size).toBe(after.length);
    // 补传的事件之前都有了；之后只多了重启期间真实发生的
    const ids = new Set(before.map((e) => e.id));
    const added = after.filter((e) => !ids.has(e.id));
    expect(added.every((e) => e.ts > Math.max(...before.map((x) => x.ts)))).toBe(true);
    const all = await list('all');
    expect(new Set(all.map(key)).size).toBe(all.length);
  });

  it('an ingest restart rebuilds the day silently: no alarm is raised twice', async () => {
    const before = await list('all');
    compose('restart', 'ingest');
    compose('up', '-d', '--wait');
    await new Promise((r) => setTimeout(r, 5000));
    const all = await list('all');
    expect(new Set(all.map(key)).size).toBe(all.length);
    // 重启后新出的告警只能是重启之后的时刻
    const known = new Set(before.map((a) => a.id));
    const restartedAt = Date.now() - 70_000;
    for (const a of all.filter((x) => !known.has(x.id))) expect(a.time).toBeGreaterThan(restartedAt);
  });

  it('a Redis restart loses nothing: ingest writes the day and the open alarms back', async () => {
    const before = (await snapshot()).day!.events.length;
    const open = (await list('open')).length;
    expect(open).toBeGreaterThan(0);
    compose('stop', 'redis');
    compose('start', 'redis');
    compose('up', '-d', '--wait');
    const after = await waitFor(
      'parking day back in Redis',
      async () => {
        const { day } = await snapshot();
        return day && day.events.length >= before ? day : null;
      },
      30_000,
    );
    expect(new Set(after.events.map((e) => e.id)).size).toBe(after.events.length);
    await waitFor('open alarms back', async () => (await list('open')).length >= open, 30_000);
  });

  it('Redis and ingest restarted together: ingest reads the day back from MongoDB', async () => {
    const before = (await snapshot()).day!.events.length;
    compose('stop', 'ingest', 'redis');
    compose('up', '-d', '--wait');
    const after = await waitFor(
      'parking day back from MongoDB',
      async () => {
        const { day } = await snapshot();
        return day && day.events.length >= before ? day : null;
      },
      30_000,
    );
    expect(new Set(after.events.map((e) => e.id)).size).toBe(after.events.length);
  });
});
