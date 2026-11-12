import type { PositionBatch } from '@indoorkit/rtls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveProvider } from '../src/index';
import { FakeSocket } from './fake-socket';

const tag = (id: string, x = 0) => ({ id, levelId: 'L1', coord: [x, 0] as [number, number] });

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const make = () => {
  const p = createLiveProvider({
    url: 'ws://x/ws',
    site: 'hospital',
    WebSocket: FakeSocket,
    random: () => 1,
  });
  const batches: PositionBatch[] = [];
  p.subscribe((b) => batches.push(b));
  return { p, batches };
};

describe('R2-08 connect and subscribe', () => {
  it('subscribes to its site once the socket opens', async () => {
    const { p } = make();
    await p.start();
    expect(p.status().state).toBe('connecting');
    FakeSocket.last().open();
    expect(FakeSocket.last().sent).toEqual([{ type: 'subscribe', site: 'hospital' }]);
    p.dispose();
  });
});

describe('R2-09 frames become position batches', () => {
  it('turns the snapshot and the following frames into batches', async () => {
    const { p, batches } = make();
    await p.start();
    const ws = FakeSocket.last();
    ws.open();
    ws.push({ type: 'hello', protocol: 1, serverTime: 0 });
    ws.push({
      type: 'snapshot',
      site: 'hospital',
      seq: '5-0',
      time: 100,
      positions: [tag('a'), tag('b')],
      offline: ['b'],
    });
    expect(p.status()).toMatchObject({ state: 'open', snapshots: 1, offline: 1 });
    ws.push({ type: 'positions', site: 'hospital', seq: '6-0', time: 200, positions: [tag('a', 1)] });
    expect(batches).toEqual([
      { time: 100, positions: [tag('a'), tag('b')] },
      { time: 200, positions: [tag('a', 1)] },
    ]);
    ws.push({ type: 'device', site: 'hospital', seq: '7-0', time: 300, online: ['b'], offline: ['a'] });
    expect(p.status().offline).toBe(1);
    ws.push({ type: 'source', site: 'hospital', seq: '8-0', time: 400, online: false });
    expect(p.status().sourceOnline).toBe(false);
    p.dispose();
  });

  it('answers pings and reports the latency the server measured', async () => {
    const { p } = make();
    await p.start();
    const ws = FakeSocket.last();
    ws.open();
    ws.push({ type: 'ping', t: 42, rttMs: 17 });
    expect(ws.sent.at(-1)).toEqual({ type: 'pong', t: 42 });
    expect(p.status().latencyMs).toBe(17);
    p.dispose();
  });

  it('ignores frames it cannot parse and counts them', async () => {
    const { p, batches } = make();
    await p.start();
    FakeSocket.last().open();
    FakeSocket.last().pushRaw('{"type":"positions"}');
    expect(batches).toEqual([]);
    expect(p.status().invalid).toBe(1);
    p.dispose();
  });
});

describe('R2-10 dispose', () => {
  it('closes the socket, clears every timer and emits nothing afterwards', async () => {
    const { p, batches } = make();
    await p.start();
    const ws = FakeSocket.last();
    ws.open();
    p.dispose();
    expect(ws.readyState).toBe(3);
    ws.push({ type: 'snapshot', site: 'hospital', seq: '1-0', time: 1, positions: [tag('a')], offline: [] });
    expect(batches).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('stop() closes without reconnecting; start() connects again', async () => {
    const { p } = make();
    await p.start();
    FakeSocket.last().open();
    await p.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(p.status().state).toBe('idle');
    await p.start();
    expect(FakeSocket.all).toHaveLength(2);
    p.dispose();
  });
});

describe('R4-07, R4-13 alarms', () => {
  it('passes on the open alarms of the snapshot, new alarms and state changes', async () => {
    const { p } = make();
    const events: unknown[] = [];
    p.onAlarm((e) => events.push(e));
    await p.start();
    const ws = FakeSocket.last();
    ws.open();
    const a1 = { id: 'a1', time: 1, level: 'high', state: 'open' as const, subjectId: 'P0001' };
    const a2 = { id: 'a2', time: 2, level: 'low', state: 'open' as const };
    ws.push({
      type: 'snapshot',
      site: 'hospital',
      seq: '1-0',
      time: 1,
      positions: [],
      offline: [],
      alarms: [a1],
    });
    ws.push({ type: 'alarm', site: 'hospital', seq: '2-0', time: 2, alarm: a2 });
    ws.push({ type: 'alarm-state', site: 'hospital', seq: '3-0', time: 3, id: 'a1', state: 'acknowledged' });
    ws.push({ type: 'alarm', site: 'hospital', seq: '2-0', time: 2, alarm: a2 });
    expect(events).toEqual([
      { type: 'reset', alarms: [a1] },
      { type: 'raise', alarm: a2 },
      { type: 'state', id: 'a1', state: 'acknowledged' },
    ]);
    p.dispose();
  });
});

describe('status listeners', () => {
  it('notifies on every state change and can be unsubscribed', async () => {
    const { p } = make();
    const states: string[] = [];
    // 计数变化也会通知；这里只看状态的先后
    const off = p.onStatus((s) => {
      if (states.at(-1) !== s.state) states.push(s.state);
    });
    await p.start();
    FakeSocket.last().open();
    FakeSocket.last().push({
      type: 'snapshot',
      site: 'hospital',
      seq: '1-0',
      time: 1,
      positions: [],
      offline: [],
    });
    off();
    FakeSocket.last().drop();
    expect(states).toEqual(['connecting', 'open']);
    p.dispose();
  });

  it('R5-04 passes on the day of the snapshot and the site events after it', async () => {
    const { p } = make();
    const got: unknown[] = [];
    p.onSite((e) => got.push(e));
    await p.start();
    const ws = FakeSocket.last();
    ws.open();
    ws.push({
      type: 'snapshot',
      site: 'parking',
      seq: '1-0',
      time: 1,
      positions: [],
      offline: [],
      day: { dayStart: 0 },
    });
    ws.push({ type: 'site-event', site: 'parking', seq: '2-0', time: 2, event: { kind: 'park' } });
    ws.push({ type: 'site-event', site: 'parking', seq: '2-0', time: 2, event: { kind: 'park' } });
    expect(got).toEqual([
      { type: 'day', time: 1, day: { dayStart: 0 } },
      { type: 'event', time: 2, event: { kind: 'park' } },
    ]);
    p.dispose();
  });
});
