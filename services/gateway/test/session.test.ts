import { describe, expect, it } from 'vitest';
import { createSession } from '../src/session';
import type { SeqFrame } from '../src/store';
import { fakeSocket, fakeStore, tag } from './fakes';

const setup = () => {
  const store = fakeStore(5);
  const socket = fakeSocket();
  let now = 1000;
  const session = createSession({ socket, store, now: () => now, limits: { high: 1000, low: 100 } });
  return { store, socket, session, tick: (ms: number) => (now += ms) };
};
const subscribe = (after?: string) =>
  JSON.stringify(
    after ? { type: 'subscribe', site: 'hospital', after } : { type: 'subscribe', site: 'hospital' },
  );

describe('R2-06 subscribe', () => {
  it('says hello, then sends a snapshot followed by newer frames only', async () => {
    const { store, socket, session } = setup();
    expect(socket.sent[0]).toMatchObject({ type: 'hello', protocol: 1 });
    store.push({ type: 'positions', site: 'hospital', time: 1, positions: [tag('a', 1), tag('b', 1)] });
    store.offline.add('c');
    await session.receive(subscribe());
    expect(socket.sent[1]).toEqual({
      type: 'snapshot',
      site: 'hospital',
      seq: '1-0',
      time: 1000,
      positions: [tag('a', 1), tag('b', 1)],
      offline: ['c'],
    });
    const old: SeqFrame = { type: 'positions', site: 'hospital', seq: '1-0', time: 1, positions: [] };
    session.deliver(old);
    const next = store.push({ type: 'positions', site: 'hospital', time: 2, positions: [tag('a', 2)] });
    session.deliver(next);
    session.deliver({ ...next, site: 'parking' });
    expect(socket.sent.slice(2)).toEqual([next]);
  });

  it('queues frames that arrive while the snapshot is being read', async () => {
    const { store, socket, session } = setup();
    store.push({ type: 'positions', site: 'hospital', time: 1, positions: [tag('a')] });
    const pending = session.receive(subscribe());
    const during = store.push({ type: 'positions', site: 'hospital', time: 2, positions: [tag('a', 2)] });
    session.deliver(during);
    await pending;
    // 快照读到的 lastSeq 已经包含 during 时它不再重复发送；否则排在快照后面
    const types = socket.sent.map((f) => f.type);
    expect(types[1]).toBe('snapshot');
    expect(socket.sent.filter((f) => 'seq' in f && f.seq === during.seq).length).toBeLessThanOrEqual(2);
    expect(socket.sent.at(-1)).toMatchObject({ seq: '2-0' });
  });

  it('ignores invalid client frames and counts them', async () => {
    const { socket, session } = setup();
    await session.receive('{"type":"subscribe","site":"school"}');
    await session.receive('nonsense');
    expect(socket.sent).toHaveLength(1);
    expect(session.stats().invalid).toBe(2);
  });
});

describe('R3-05 resume after a reconnect', () => {
  it('replays the frames after the last one the client saw', async () => {
    const { store, socket, session } = setup();
    const a = store.push({ type: 'positions', site: 'hospital', time: 1, positions: [tag('a')] });
    const b = store.push({ type: 'device', site: 'hospital', time: 2, online: [], offline: ['a'] });
    const c = store.push({ type: 'positions', site: 'hospital', time: 3, positions: [tag('b')] });
    await session.receive(subscribe(a.seq));
    expect(socket.sent.slice(1)).toEqual([
      { ...b, replay: true },
      { ...c, replay: true },
      { type: 'synced', site: 'hospital', seq: c.seq, replayed: 2 },
    ]);
    expect(session.stats().replayed).toBe(2);
  });

  it('falls back to a snapshot when those frames were already trimmed', async () => {
    const { store, socket, session } = setup();
    for (let i = 0; i < 10; i++)
      store.push({ type: 'positions', site: 'hospital', time: i, positions: [tag('a', i)] });
    await session.receive(subscribe('1-0'));
    expect(socket.sent[1]).toMatchObject({ type: 'snapshot', seq: '10-0' });
    expect(session.stats().snapshots).toBe(1);
  });
});

describe('R3-06 heartbeat', () => {
  it('measures the round trip and closes a connection that stops answering', async () => {
    const { socket, session, tick } = setup();
    session.ping();
    const ping = socket.sent.at(-1)!;
    expect(ping).toEqual({ type: 'ping', t: 1000 });
    tick(40);
    await session.receive(JSON.stringify({ type: 'pong', t: 1000 }));
    session.ping();
    expect(socket.sent.at(-1)).toEqual({ type: 'ping', t: 1040, rttMs: 40 });
    expect(session.stats().rttMs).toBe(40);
    session.ping();
    expect(socket.closed).toBeNull();
    session.ping();
    expect(socket.closed).toEqual({ code: 4000, reason: 'heartbeat timeout' });
  });
});

describe('R3-10 shutdown', () => {
  it('says goodbye before closing so the client reconnects at once', () => {
    const { socket, session } = setup();
    session.shutdown();
    expect(socket.sent.at(-1)).toEqual({ type: 'bye', reason: 'restart' });
    expect(socket.closed).toEqual({ code: 1001, reason: 'restart' });
  });
});

describe('R4 alarms', () => {
  const alarm = (id: string, time: number) => ({ id, time, level: 'high' as const, state: 'open' as const });

  it('R4-07 the snapshot carries the open alarms', async () => {
    const { store, socket, session } = setup();
    store.alarms.push(alarm('x-1', 5));
    await session.receive(subscribe());
    expect(socket.sent[1]).toMatchObject({ type: 'snapshot', alarms: [alarm('x-1', 5)] });
  });

  it('R4-07 leaves alarms out of the snapshot when there are none', async () => {
    const { socket, session } = setup();
    await session.receive(subscribe());
    expect(socket.sent[1]).not.toHaveProperty('alarms');
  });

  it('R4-06 alarm frames are sent even while position frames are being skipped', async () => {
    const { store, socket, session } = setup();
    await session.receive(subscribe());
    socket.setBuffered(5000);
    session.deliver(store.push({ type: 'positions', site: 'hospital', time: 1, positions: [tag('a')] }));
    const a = store.push({ type: 'alarm', site: 'hospital', time: 1, alarm: alarm('x-2', 1) });
    session.deliver(a);
    expect(socket.sent.at(-1)).toEqual(a);
    expect(session.stats().skipped).toBe(1);
  });
});

describe('R5-04 site days', () => {
  it('puts the day of the site into the snapshot and passes site events on', async () => {
    const { store, socket, session } = setup();
    store.day = { timeZone: 'Asia/Tokyo', events: [{ kind: 'entry' }] };
    await session.receive(subscribe());
    expect(socket.sent[1]).toMatchObject({ type: 'snapshot', day: store.day });
    const e = store.push({ type: 'site-event', site: 'hospital', time: 2, event: { kind: 'park' } });
    session.deliver(e);
    expect(socket.sent.at(-1)).toEqual(e);
  });
});
