import { type AlarmEvent, createLiveProvider } from '@indoorkit/live-client';
import type { AlarmRecord } from '@indoorkit/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { compose, GATEWAY, rawClient, WS_URL, waitFor } from './helpers';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});
afterAll(() => {
  compose('up', '-d', '--wait');
});

const list = async (state: 'open' | 'all', limit = 500) => {
  const res = await fetch(`${GATEWAY}/api/hospital/alarms?state=${state}&limit=${limit}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { alarms: AlarmRecord[] }).alarms;
};
const post = (id: string, action: string) =>
  fetch(`${GATEWAY}/api/hospital/alarms/${id}/${action}`, { method: 'POST' });

describe('R4-05, R4-07 server alarms', () => {
  it('lists open alarms newest first and puts them in the snapshot', async () => {
    const open = await waitFor('open alarms', async () => {
      const a = await list('open');
      return a.length > 0 ? a : null;
    });
    for (let i = 1; i < open.length; i++) expect(open[i]!.time).toBeLessThanOrEqual(open[i - 1]!.time);
    expect(open[0]).toMatchObject({
      state: expect.stringMatching(/open|acknowledged/),
      subjectId: expect.any(String),
    });

    const c = rawClient();
    cleanup.push(c.close);
    const snap = await waitFor('snapshot', () => c.frames.find((f) => f.type === 'snapshot'));
    const alarms = snap.type === 'snapshot' ? (snap.alarms ?? []) : [];
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms.length).toBeLessThanOrEqual(200);
    const ids = new Set((await list('open')).map((a) => a.id));
    // 快照之后可能刚好有告警被解决，绝大多数应当还在
    expect(alarms.filter((a) => ids.has(a.id)).length).toBeGreaterThan(alarms.length * 0.9);
  });

  it('R4-06: alarms raised around a gateway restart all reach the client, and match MongoDB', async () => {
    const p = createLiveProvider({ url: WS_URL, site: 'hospital' });
    cleanup.push(() => p.dispose());
    const seen = new Set<string>();
    p.onAlarm((e: AlarmEvent) => {
      if (e.type === 'raise') seen.add(e.alarm.id);
      if (e.type === 'reset') for (const a of e.alarms) seen.add(a.id);
    });
    p.start();
    await waitFor('open', () => p.status().state === 'open');
    const before = new Set((await list('all')).map((a) => a.id.split('-')[0]));
    // 重启 ingest：新的引擎第一次看到的访客马上产生一批告警
    compose('restart', 'ingest');
    compose('restart', 'gateway');
    await waitFor('reopened', () => p.status().reconnects > 0 && p.status().state === 'open', 30_000);
    const fresh = await waitFor(
      'alarms from the new ingest in MongoDB',
      async () => {
        const a = (await list('all')).filter((x) => !before.has(x.id.split('-')[0]!));
        return a.length > 0 ? a : null;
      },
      30_000,
    );
    await waitFor('client has every new alarm', () => fresh.every((a) => seen.has(a.id)), 10_000);
    expect(p.status().snapshots).toBe(1);
  });
});

describe('R4-10 acknowledging and resolving', () => {
  it('changes the state, pushes alarm-state frames and drops resolved alarms from the open list', async () => {
    const open = await waitFor('an open alarm', async () =>
      (await list('open')).find((a) => a.state === 'open'),
    );
    const c = rawClient();
    cleanup.push(c.close);
    await waitFor('snapshot', () => c.frames.find((f) => f.type === 'snapshot'));

    const ack = await post(open.id, 'ack');
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { alarm: AlarmRecord }).alarm).toMatchObject({
      id: open.id,
      state: 'acknowledged',
    });
    expect((await list('open')).find((a) => a.id === open.id)?.state).toBe('acknowledged');

    expect((await post(open.id, 'resolve')).status).toBe(200);
    expect((await list('open')).some((a) => a.id === open.id)).toBe(false);
    await waitFor('resolved in MongoDB', async () =>
      (await list('all')).some((a) => a.id === open.id && a.state === 'resolved'),
    );
    const states = c.frames.filter((f) => f.type === 'alarm-state' && f.id === open.id);
    await waitFor(
      'two alarm-state frames',
      () => c.frames.filter((f) => f.type === 'alarm-state' && f.id === open.id).length === 2,
    );
    expect(states.length).toBeLessThanOrEqual(2);
  });

  it('answers 404 for an unknown alarm and allows cross-origin reads', async () => {
    expect((await post('nope-alarm-1', 'ack')).status).toBe(404);
    const res = await fetch(`${GATEWAY}/api/hospital/alarms`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
