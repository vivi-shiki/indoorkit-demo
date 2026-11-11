import { describe, expect, it } from 'vitest';
import { createSession } from '../src/session';
import { fakeSocket, fakeStore, tag } from './fakes';

describe('R3-09 backpressure', () => {
  it('skips position frames for a slow client, never device frames, then catches up with a snapshot', async () => {
    const store = fakeStore();
    const socket = fakeSocket();
    const session = createSession({ socket, store, now: () => 0, limits: { high: 1000, low: 100 } });
    await session.receive(JSON.stringify({ type: 'subscribe', site: 'hospital' }));
    const before = socket.sent.length;

    socket.setBuffered(5000);
    session.deliver(store.push({ type: 'positions', site: 'hospital', time: 1, positions: [tag('a', 1)] }));
    const device = store.push({ type: 'device', site: 'hospital', time: 2, online: [], offline: ['b'] });
    session.deliver(device);
    socket.setBuffered(500);
    session.deliver(store.push({ type: 'positions', site: 'hospital', time: 3, positions: [tag('a', 3)] }));
    expect(socket.sent.slice(before)).toEqual([device]);
    expect(session.stats().skipped).toBe(2);

    socket.setBuffered(50);
    session.deliver(store.push({ type: 'positions', site: 'hospital', time: 4, positions: [tag('a', 4)] }));
    await session.idle();
    const after = socket.sent.slice(before + 1);
    expect(after[0]).toMatchObject({ type: 'snapshot', positions: [tag('a', 4)] });
    expect(session.stats().snapshots).toBe(2);
  });
});
