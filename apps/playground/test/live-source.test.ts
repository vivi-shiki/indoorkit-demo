import type { AlarmEvent, LiveProvider, LiveState, LiveStatus } from '@indoorkit/live-client';
import type { PositionBatch } from '@indoorkit/rtls';
import { createManualProvider } from '@indoorkit/rtls/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiBase, createSwitchingProvider, resolveSource } from '../src/adapters/live-source';

/** 可以手动改状态、手动推批次的后端数据源 */
function fakeLive() {
  const manual = createManualProvider();
  const listeners = new Set<(s: LiveStatus) => void>();
  const alarmListeners = new Set<(e: AlarmEvent) => void>();
  let status: LiveStatus = {
    state: 'idle',
    latencyMs: undefined,
    reconnects: 0,
    snapshots: 0,
    replayed: 0,
    dropped: 0,
    invalid: 0,
    offline: 0,
    sourceOnline: undefined,
  };
  const live: LiveProvider & {
    set(state: LiveState): void;
    emit(b: PositionBatch): void;
    alarm(e: AlarmEvent): void;
    readonly disposed: boolean;
    readonly started: boolean;
  } = {
    ...manual,
    get disposed() {
      return manual.disposed;
    },
    get started() {
      return manual.started;
    },
    emit: manual.emit,
    start() {
      manual.start();
      live.set('connecting');
    },
    status: () => status,
    onStatus(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onAlarm(l) {
      alarmListeners.add(l);
      return () => alarmListeners.delete(l);
    },
    alarm(e) {
      for (const l of [...alarmListeners]) l(e);
    },
    set(state) {
      status = { ...status, state };
      for (const l of [...listeners]) l(status);
    },
  };
  return live;
}

const batch = (x: number): PositionBatch => ({
  time: x,
  positions: [{ id: 'a', levelId: 'L', coord: [x, 0] }],
});

describe('R2-11 choosing the data source', () => {
  it('reads ?source and ?live, falling back to the build-time address', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(resolveSource(q(''), undefined)).toEqual({ mode: 'sim', url: null });
    expect(resolveSource(q('source=live'), undefined)).toEqual({ mode: 'sim', url: null });
    expect(resolveSource(q(''), 'wss://api/ws')).toEqual({ mode: 'auto', url: 'wss://api/ws' });
    expect(resolveSource(q('source=sim'), 'wss://api/ws')).toEqual({ mode: 'sim', url: 'wss://api/ws' });
    expect(resolveSource(q('source=live&live=ws://localhost:8080/ws'), undefined)).toEqual({
      mode: 'live',
      url: 'ws://localhost:8080/ws',
    });
    expect(resolveSource(q('source=nonsense'), 'wss://api/ws').mode).toBe('auto');
  });
});

describe('R2-12 automatic fallback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (mode: 'auto' | 'live' | 'sim') => {
    const live = fakeLive();
    const sims: ReturnType<typeof createManualProvider>[] = [];
    const p = createSwitchingProvider({
      mode,
      live,
      createSim: () => {
        const s = createManualProvider();
        sims.push(s);
        return s;
      },
    });
    const got: number[] = [];
    p.subscribe((b) => got.push(b.time));
    return { live, sims, p, got };
  };

  it('uses the simulator when the backend does not connect within 4 seconds', async () => {
    const { live, sims, p, got } = setup('auto');
    await p.start();
    expect(sims).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3999);
    expect(p.status().source).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(sims).toHaveLength(1);
    expect(sims[0]!.started).toBe(true);
    expect(p.status()).toMatchObject({ source: 'sim', state: 'connecting' });
    sims[0]!.emit(batch(1));
    live.emit(batch(2));
    expect(got).toEqual([1]);
    p.dispose();
  });

  it('switches back to the backend once it is synced, and away again after 4 seconds without it', async () => {
    const { live, sims, p, got } = setup('auto');
    await p.start();
    await vi.advanceTimersByTimeAsync(4000);
    live.set('open');
    expect(sims[0]!.disposed).toBe(true);
    expect(p.status().source).toBe('live');
    live.emit(batch(3));
    expect(got).toEqual([3]);
    live.set('reconnecting');
    await vi.advanceTimersByTimeAsync(3999);
    expect(sims).toHaveLength(1);
    live.set('open');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sims).toHaveLength(1);
    live.set('reconnecting');
    await vi.advanceTimersByTimeAsync(4000);
    expect(sims).toHaveLength(2);
    expect(p.status().source).toBe('sim');
    p.dispose();
  });

  it('never falls back in live mode', async () => {
    const { sims, p } = setup('live');
    await p.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sims).toHaveLength(0);
    expect(p.status()).toMatchObject({ mode: 'live', source: 'live' });
    p.dispose();
  });

  it('never touches the backend in sim mode', async () => {
    const { live, sims, p } = setup('sim');
    await p.start();
    expect(live.started).toBe(false);
    expect(sims[0]!.started).toBe(true);
    expect(p.status()).toMatchObject({ mode: 'sim', source: 'sim', state: 'sim' });
    p.dispose();
  });

  it('disposes both sources and leaves no timer behind', async () => {
    const { live, sims, p } = setup('auto');
    await p.start();
    await vi.advanceTimersByTimeAsync(4000);
    p.dispose();
    expect(live.disposed).toBe(true);
    expect(sims[0]!.disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('R4-12 objects of the page', () => {
  it('passes only the backend positions the page asks for', async () => {
    const live = fakeLive();
    const p = createSwitchingProvider({
      mode: 'live',
      live,
      createSim: () => createManualProvider(),
      keep: (id) => id.startsWith('A'),
    });
    const got: PositionBatch[] = [];
    p.subscribe((b) => got.push(b));
    await p.start();
    live.set('open');
    live.emit({
      time: 1,
      positions: [
        { id: 'P0001', levelId: 'L', coord: [0, 0] },
        { id: 'A0001', levelId: 'L', coord: [0, 0] },
      ],
    });
    expect(got).toEqual([{ time: 1, positions: [{ id: 'A0001', levelId: 'L', coord: [0, 0] }] }]);
    p.dispose();
  });
});

describe('R4-13 server alarms', () => {
  it('forwards alarm events while the backend is shown', async () => {
    const live = fakeLive();
    const p = createSwitchingProvider({ mode: 'live', live, createSim: () => createManualProvider() });
    const got: AlarmEvent[] = [];
    p.onAlarm((e) => got.push(e));
    await p.start();
    live.set('open');
    const e: AlarmEvent = { type: 'state', id: 'x', state: 'resolved' };
    live.alarm(e);
    expect(got).toEqual([e]);
    p.dispose();
    live.alarm(e);
    expect(got).toHaveLength(1);
  });

  it('derives the REST address from the WebSocket address', () => {
    expect(apiBase('ws://localhost:8080/ws')).toBe('http://localhost:8080/api');
    expect(apiBase('wss://rtls.example.org/ws')).toBe('https://rtls.example.org/api');
    expect(apiBase(null)).toBeNull();
  });
});
