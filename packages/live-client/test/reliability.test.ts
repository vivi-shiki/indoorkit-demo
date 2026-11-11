import type { PositionBatch } from '@indoorkit/rtls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, createLiveProvider } from '../src/index';
import { FakeSocket } from './fake-socket';

const tag = (id: string, x = 0) => ({ id, levelId: 'L1', coord: [x, 0] as [number, number] });

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const connected = async (random = () => 1) => {
  const p = createLiveProvider({ url: 'ws://x/ws', site: 'hospital', WebSocket: FakeSocket, random });
  const batches: PositionBatch[] = [];
  p.subscribe((b) => batches.push(b));
  await p.start();
  const ws = FakeSocket.last();
  ws.open();
  ws.push({ type: 'snapshot', site: 'hospital', seq: '10-0', time: 1, positions: [tag('a')], offline: [] });
  return { p, batches, ws };
};

describe('R3-07 reconnect with exponential backoff and jitter', () => {
  it('doubles the delay up to 30 seconds and keeps between half and all of it', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(backoffDelay(2, () => 0)).toBe(2000);
  });

  it('retries after a dropped connection and resets the delay once synced again', async () => {
    const { p, ws } = await connected();
    ws.drop();
    expect(p.status().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(2);
    // 第二次也失败：等 2 秒
    FakeSocket.last().drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const third = FakeSocket.last();
    third.open();
    third.push({ type: 'synced', site: 'hospital', seq: '10-0', replayed: 0 });
    expect(p.status()).toMatchObject({ state: 'open', reconnects: 2 });
    third.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(4);
    p.dispose();
  });
});

describe('R3-05 resume from the last frame', () => {
  it('asks for the frames after the last sequence number it saw and counts the replay', async () => {
    const { p, ws, batches } = await connected();
    ws.push({ type: 'positions', site: 'hospital', seq: '11-0', time: 2, positions: [tag('a', 1)] });
    ws.drop();
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.last();
    next.open();
    expect(next.sent[0]).toEqual({ type: 'subscribe', site: 'hospital', after: '11-0' });
    next.push({
      type: 'positions',
      site: 'hospital',
      seq: '12-0',
      time: 3,
      positions: [tag('a', 2)],
      replay: true,
    });
    next.push({ type: 'synced', site: 'hospital', seq: '12-0', replayed: 1 });
    expect(batches.at(-1)).toEqual({ time: 3, positions: [tag('a', 2)] });
    expect(p.status()).toMatchObject({ state: 'open', replayed: 1 });
    p.dispose();
  });
});

describe('R3-08 duplicate and old frames', () => {
  it('drops frames whose sequence number is not newer', async () => {
    const { p, ws, batches } = await connected();
    ws.push({ type: 'positions', site: 'hospital', seq: '9-0', time: 2, positions: [tag('a', 9)] });
    ws.push({ type: 'positions', site: 'hospital', seq: '10-0', time: 2, positions: [tag('a', 9)] });
    ws.push({ type: 'positions', site: 'hospital', seq: '10-1', time: 2, positions: [tag('a', 1)] });
    expect(batches).toHaveLength(2);
    expect(p.status().dropped).toBe(2);
    p.dispose();
  });
});

describe('R3-06 silent connection', () => {
  it('reconnects when nothing arrives for 35 seconds', async () => {
    const { p } = await connected();
    await vi.advanceTimersByTimeAsync(34_999);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all[0]!.readyState).toBe(3);
    expect(p.status().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    p.dispose();
  });
});

describe('R3-06 stuck handshake', () => {
  it('gives up on a connection that never opens and retries with backoff', async () => {
    const p = createLiveProvider({
      url: 'ws://x/ws',
      site: 'hospital',
      WebSocket: FakeSocket,
      random: () => 1,
    });
    await p.start();
    await vi.advanceTimersByTimeAsync(9999);
    expect(FakeSocket.all[0]!.readyState).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all[0]!.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    p.dispose();
  });
});

describe('R3-07 refused handshake', () => {
  it('retries when only an error event arrives', async () => {
    const p = createLiveProvider({
      url: 'ws://x/ws',
      site: 'hospital',
      WebSocket: FakeSocket,
      random: () => 1,
    });
    await p.start();
    FakeSocket.last().refuse();
    expect(p.status().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    p.dispose();
  });
});

describe('R3-10 server restart', () => {
  it('reconnects at once, without backoff, after a goodbye', async () => {
    const { p, ws } = await connected();
    ws.push({ type: 'bye', reason: 'restart' });
    expect(ws.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(2);
    p.dispose();
  });
});
