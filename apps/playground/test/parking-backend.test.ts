import type { AlarmEvent, LiveProvider, LiveStatus, SiteEvent } from '@indoorkit/live-client';
import { createParkingDay } from '@indoorkit/parking-simulator';
import {
  type AlarmRecord,
  dayStartOf,
  parseBookingReport,
  parseDeviceReport,
  parseParkingEvent,
  parseTopic,
} from '@indoorkit/protocol';
import type { PositionBatch } from '@indoorkit/rtls';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 整条链路：设备端的补传经 ingest 写成快照和帧，浏览器由它们回答的应当和浏览器模拟相同
import { createParkingDevices, PARKING } from '../../../services/device-sim/src/parking';
import { createParkingSite } from '../../../services/ingest/src/parking/site';
import { connectParking } from '../src/parking/adapters/backend';
import { createLiveAlarmStore } from '../src/parking/adapters/live-alarms';
import { createLiveParkingDay, type ParkingDayView } from '../src/parking/adapters/live-day';

const TZ = 'Asia/Tokyo';
const H = 3600_000;
const DAY0 = dayStartOf(Date.UTC(2026, 10, 12, 3), TZ);

/** device-sim 在 hour 点补传、ingest 处理完之后，快照里的 day 和全部事件 */
function backend(hour: number) {
  const now = DAY0 + hour * H;
  const devices = createParkingDevices(PARKING, { seed: 'minato', timeZone: TZ, now: () => now });
  const site = createParkingSite(PARKING, { origin: DAY0, timeZone: TZ, idPrefix: 'x' });
  const events: Record<string, unknown>[] = [];
  for (const m of devices.backfill()) {
    const t = parseTopic(m.topic);
    if (!t.ok) throw new Error(t.error);
    if (t.value.kind === 'event') {
      const r = parseParkingEvent(m.payload);
      if (r.ok && site.event(r.value)) events.push(r.value);
    } else if (t.value.kind === 'dev') {
      const r = parseDeviceReport(m.payload);
      if (r.ok) site.device(t.value.deviceId, r.value);
    } else if (t.value.kind === 'booking') {
      const r = parseBookingReport(m.payload);
      if (r.ok) site.booking(r.value);
    }
  }
  const { day } = site.drain();
  return { now, day: { ...day!, events } as Record<string, unknown>, events };
}

const sim = createParkingDay(PARKING, { seed: 'minato' });
const ms = (t: number) => Math.round(t);
const plain = (id: string) => id.replace(/^\d{8}-/, '');

/** 两边可比的答案：去掉 id 里的日期，时刻取整到毫秒 */
function answers(day: ParkingDayView, t: number) {
  return {
    parked: day
      .parkedAt(t)
      .map((p) => `${p.bayId}|${p.vehicle.plate}|${ms(p.enteredAt)}|${ms(p.parkedAt)}|${p.chargedAt ?? ''}`)
      .sort(),
    events: day
      .events(-Infinity, t)
      .map((e) => `${e.kind}|${ms(e.time)}|${plain(e.visitId)}|${e.bayId}|${e.paid ?? ''}`),
    // 还没出场的车付没付款要到出场才知道：模拟的计划里已经有，后端还没有
    sessions: day
      .sessions(t)
      .map(
        (s) =>
          `${s.plate}|${s.bayId}|${ms(s.enteredAt)}|${s.exitedAt === null ? '' : ms(s.exitedAt)}|${s.fee}|${s.exitedAt === null ? '' : s.paid}`,
      )
      .sort(),
    reservations: day.reservations
      .map((r) => `${plain(r.id)}|${r.bayId}|${ms(r.from)}|${ms(r.to)}|${r.plate}`)
      .sort(),
    arrived: day.reservations
      .filter((r) => r.arrivedAt !== null && r.arrivedAt <= t)
      .map((r) => `${plain(r.id)}|${ms(r.arrivedAt!)}`)
      .sort(),
    contracts: day.monthlyContracts.map((c) => `${c.id}|${c.bayId}`).sort(),
  };
}

describe('R5-09 the parking day kept from the backend', () => {
  it('answers like the browser simulation at the same moment', () => {
    const { now, day } = backend(14);
    const live = createLiveParkingDay({ now: () => now });
    live.reset(day, now);
    expect(live.origin()).toBe(DAY0);
    for (const t of [-12 * H, 6 * H, 10 * H, 14 * H - 60_000]) {
      const got = answers(live, t);
      const want = answers(sim, t);
      expect(got.parked.length).toBeGreaterThan(0);
      expect(got.parked).toEqual(want.parked);
      expect(got.events).toEqual(want.events);
      expect(got.sessions).toEqual(want.sessions);
      expect(got.arrived).toEqual(want.arrived);
    }
    expect(answers(live, 0).reservations).toEqual(answers(sim, 0).reservations);
    expect(answers(live, 0).contracts).toEqual(answers(sim, 0).contracts);
    // 设备：故障中的和 CO 浓度
    const down = (d: ParkingDayView) =>
      d
        .deviceReadings(14 * H)
        .filter((r) => r.status !== 'online' || r.value !== undefined)
        .map((r) => `${r.deviceId}|${r.status}|${r.value ?? ''}`)
        .sort();
    expect(down(live)).toEqual(down(sim));
  });

  it('gives the same answers when the later events arrive as frames after the snapshot', () => {
    const { now, day, events } = backend(14);
    const cut = DAY0 + 9 * H;
    const live = createLiveParkingDay({ now: () => now });
    live.reset({ ...day, events: events.filter((e) => (e.ts as number) < cut) }, now);
    let changes = 0;
    live.subscribe(() => changes++);
    for (const e of events.filter((x) => (x.ts as number) >= cut)) live.apply({ type: 'parking', ...e });
    expect(changes).toBeGreaterThan(0);
    expect(answers(live, 14 * H - 60_000)).toEqual(answers(sim, 14 * H - 60_000));
    // 重复的帧不改变答案
    for (const e of events) live.apply({ type: 'parking', ...e });
    expect(answers(live, 14 * H - 60_000)).toEqual(answers(sim, 14 * H - 60_000));
  });

  it('keeps moving vehicles until their track ends, and takes them from the snapshot', () => {
    const { now, day } = backend(10);
    const live = createLiveParkingDay({ now: () => now });
    const pos = (id: string, status?: string) => ({
      id,
      levelId: 'L',
      coord: [1, 2] as [number, number],
      ...(status ? { status } : {}),
    });
    live.positions({ time: now, positions: [pos('a')] });
    live.reset(day, now);
    expect(live.movingAt(10 * H).map((m) => m.id)).toEqual(['a']);
    live.positions({ time: now + 1000, positions: [pos('b'), pos('a', 'gone')] });
    expect(live.movingAt(10 * H).map((m) => m.id)).toEqual(['b']);
    // 时刻对不上的批次不是快照的一部分
    live.reset(day, now + 5000);
    expect(live.movingAt(10 * H)).toEqual([]);
  });

  it('keeps the first day start across reconnects', () => {
    const { now, day } = backend(10);
    let clock = now;
    const live = createLiveParkingDay({ now: () => clock });
    live.reset(day, clock);
    clock += 20 * H;
    live.reset(day, clock);
    expect(live.origin()).toBe(DAY0);
  });
});

const record = (id: string, time: number, state: AlarmRecord['state'] = 'open'): AlarmRecord =>
  ({
    id,
    time,
    state,
    level: 'medium',
    rule: 'long-stay',
    tier: 'time',
    levelId: 'L1',
    bayId: 'b1',
    deviceId: null,
    plate: 'p',
  }) as AlarmRecord;

describe('R5-09 server alarms', () => {
  it('converts the time to the time of day, keeps states and acknowledges through REST', () => {
    const calls: string[] = [];
    const store = createLiveAlarmStore({
      origin: () => DAY0,
      api: 'http://h/api',
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method} ${url}`);
        return new Response('{}');
      }) as typeof fetch,
    });
    store.apply({
      type: 'reset',
      alarms: [record('x-PA-2', DAY0 + 2 * H), record('x-PA-1', DAY0 + H, 'acknowledged')],
    });
    store.apply({ type: 'raise', alarm: record('x-PA-3', DAY0 + 3 * H) });
    expect(store.all().map((a) => [a.id, a.time])).toEqual([
      ['x-PA-1', H],
      ['x-PA-2', 2 * H],
      ['x-PA-3', 3 * H],
    ]);
    expect(store.state('x-PA-1')).toBe('acknowledged');
    expect(store.update(5 * H)).toEqual([]);

    store.setState('x-PA-2', 'resolved');
    expect(store.state('x-PA-2')).toBe('resolved');
    expect(calls).toEqual(['POST http://h/api/parking/alarms/x-PA-2/resolve']);
    store.apply({ type: 'state', id: 'x-PA-3', state: 'acknowledged' });
    expect(store.state('x-PA-3')).toBe('acknowledged');

    // 快照只带最新的未解决告警：不在里面的保持原样；历史合并时不覆盖已知的
    store.apply({ type: 'reset', alarms: [record('x-PA-3', DAY0 + 3 * H, 'acknowledged')] });
    expect(store.all()).toHaveLength(3);
    store.merge([record('x-PA-0', DAY0 - H, 'resolved'), record('x-PA-2', DAY0 + 2 * H, 'open')]);
    expect(store.all().map((a) => a.id)).toEqual(['x-PA-0', 'x-PA-1', 'x-PA-2', 'x-PA-3']);
    expect(store.state('x-PA-2')).toBe('resolved');
  });
});

/** 手动推快照和帧的后端连接 */
function fakeLive() {
  const site = new Set<(e: SiteEvent) => void>();
  const alarms = new Set<(e: AlarmEvent) => void>();
  const positions = new Set<(b: PositionBatch) => void>();
  const status = { state: 'open', replayed: 0, dropped: 0, offline: 0 } as LiveStatus;
  const on =
    <T>(set: Set<T>) =>
    (l: T) => {
      set.add(l);
      return () => set.delete(l);
    };
  const live = {
    disposed: false,
    start() {},
    stop() {},
    subscribe: on(positions),
    status: () => status,
    onStatus: () => () => {},
    onAlarm: on(alarms),
    onSite: on(site),
    dispose() {
      live.disposed = true;
    },
    site: (e: SiteEvent) => {
      for (const l of site) l(e);
    },
    alarm: (e: AlarmEvent) => {
      for (const l of alarms) l(e);
    },
    batch: (b: PositionBatch) => {
      for (const l of positions) l(b);
    },
  };
  return live as LiveProvider & typeof live;
}

describe('R5-09 opening the parking pages on the backend', () => {
  afterEach(() => vi.useRealTimers());
  const noFetch = (async () => new Response('{"alarms":[]}')) as unknown as typeof fetch;

  it('waits for the first snapshot, then answers from the backend at the wall clock', async () => {
    const { now, day } = backend(14);
    const live = fakeLive();
    const opening = connectParking({ mode: 'live', url: 'ws://h/ws', live, fetch: noFetch, now: () => now });
    // 快照前到的告警等 0 点定下后再收
    live.alarm({ type: 'reset', alarms: [record('x-PA-1', DAY0 + H)] });
    live.batch({ time: now, positions: [{ id: 'v', levelId: 'L', coord: [0, 0] }] });
    live.site({ type: 'day', time: now, day });
    const ctx = (await opening)!;
    expect(ctx.clock.time()).toBe(14 * H);
    expect(ctx.clock.speed()).toBe(1);
    ctx.clock.setSpeed(60);
    expect(ctx.clock.speed()).toBe(1);
    expect(ctx.alarms.all().map((a) => a.time)).toEqual([H]);
    expect(ctx.day.parkedAt(14 * H).length).toBeGreaterThan(0);
    expect(ctx.source.status()).toMatchObject({ mode: 'live', source: 'live', state: 'open' });

    // 行驶中的车给每个页面一个独立的数据源，gone 不画
    const feed = ctx.source.movingFeed()!;
    const got: PositionBatch[] = [];
    feed.subscribe((b) => got.push(b));
    live.batch({ time: now + 1, positions: [{ id: 'v', levelId: 'L', coord: [0, 0], status: 'gone' }] });
    expect(got).toEqual([{ time: now + 1, positions: [] }]);
    feed.dispose();
    expect(live.disposed).toBe(false);
  });

  it('gives up after the fallback delay in auto mode, so the page uses the browser simulation', async () => {
    vi.useFakeTimers();
    const live = fakeLive();
    const opening = connectParking({ mode: 'auto', url: 'ws://h/ws', live, fetch: noFetch });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await opening).toBeNull();
    expect(live.disposed).toBe(true);
  });
});
