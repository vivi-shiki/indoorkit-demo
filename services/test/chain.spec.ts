import { createLiveProvider, type LiveState } from '@indoorkit/live-client';
import type { PositionBatch } from '@indoorkit/rtls';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { compose, GATEWAY, inside, rawClient, WS_URL, waitFor } from './helpers';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  inside('device-sim', 8081, '/faults', { drop: 0, duplicate: 0, reorder: 0, silent: 0 });
});
afterAll(() => {
  compose('up', '-d', '--wait');
});

describe('R2 hospital positions through the whole chain', () => {
  it('delivers a snapshot of every tag and then a frame per second', async () => {
    const c = rawClient();
    cleanup.push(c.close);
    await waitFor(
      'snapshot and 3 frames',
      () => c.frames.filter((f) => f.type === 'positions').length >= 3,
      6000,
    );
    const snap = c.frames.find((f) => f.type === 'snapshot');
    expect(snap?.type === 'snapshot' && snap.positions.length).toBe(2000);
    expect(c.frames[0]?.type).toBe('hello');
  });
});

describe('R3 reliability against the real services', () => {
  it('R3-05, R3-10: a gateway restart is bridged by resuming, without a new snapshot', async () => {
    const p = createLiveProvider({ url: WS_URL, site: 'hospital' });
    cleanup.push(() => p.dispose());
    const states: LiveState[] = [];
    p.onStatus((s) => {
      if (states.at(-1) !== s.state) states.push(s.state);
    });
    const batches: PositionBatch[] = [];
    p.subscribe((b) => batches.push(b));
    p.start();
    await waitFor('open', () => p.status().state === 'open');
    compose('restart', 'gateway');
    await waitFor('reopened', () => states.filter((s) => s === 'open').length >= 2, 30_000);
    const count = batches.length;
    await waitFor('batches after the restart', () => batches.length > count + 1);
    expect(states).toContain('reconnecting');
    expect(p.status().snapshots).toBe(1);
    expect(p.status().replayed).toBeGreaterThan(0);
    // 时间不倒退：续上之后的每一批都比前一批新
    for (let i = 1; i < batches.length; i++)
      expect(batches[i]!.time).toBeGreaterThanOrEqual(batches[i - 1]!.time);
  });

  it('R3-02, R3-04: tags that stop reporting are announced offline, and online again', async () => {
    const c = rawClient();
    cleanup.push(c.close);
    await waitFor('snapshot', () => c.frames.some((f) => f.type === 'snapshot'));
    inside('device-sim', 8081, '/faults', { silent: 0.1 });
    const off = await waitFor(
      'offline frame',
      () => c.frames.find((f) => f.type === 'device' && f.offline.length > 0),
      16_000,
    );
    const offline = off.type === 'device' ? off.offline : [];
    expect(offline.length).toBeGreaterThan(120);
    expect(offline.length).toBeLessThan(280);
    inside('device-sim', 8081, '/faults', { silent: 0 });
    const on = await waitFor(
      'online frame',
      () => c.frames.find((f) => f.type === 'device' && f.online.length > 0),
      6000,
    );
    expect(on.type === 'device' && [...on.online].sort()).toEqual([...offline].sort());
  });

  it('R3-01, R3-04: duplicated and reordered reports are dropped by ingest', async () => {
    const before = metric(inside('ingest', 8082, '/metrics').text, 'ik_ingest_stale_total');
    inside('device-sim', 8081, '/faults', { duplicate: 0.2, reorder: 0.2 });
    await waitFor(
      'stale reports',
      () => metric(inside('ingest', 8082, '/metrics').text, 'ik_ingest_stale_total') > before + 500,
    );
  });

  it('R3-03: the simulator dropping off is announced through its last will', async () => {
    const c = rawClient();
    cleanup.push(c.close);
    await waitFor('snapshot', () => c.frames.some((f) => f.type === 'snapshot'));
    inside('device-sim', 8081, '/faults', { disconnectMs: 3000 });
    await waitFor('source offline', () => c.frames.some((f) => f.type === 'source' && !f.online), 10_000);
    await waitFor('source online', () => c.frames.some((f) => f.type === 'source' && f.online), 10_000);
  });

  it('R3-11: every service exposes its metrics', async () => {
    const gateway = await (await fetch(`${GATEWAY}/metrics`)).text();
    expect(gateway).toMatch(/ik_gateway_connections \d+/);
    expect(gateway).toMatch(/ik_gateway_frames_replayed_total \d+/);
    expect(gateway).toMatch(/ik_gateway_frames_skipped_total \d+/);
    expect(inside('ingest', 8082, '/metrics').text).toMatch(/ik_ingest_frames_total \d+/);
    expect(inside('device-sim', 8081, '/metrics').text).toMatch(/ik_device_sim_published_total \d+/);
  });
});

function metric(text: string, name: string): number {
  const m = new RegExp(`^${name} (\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
}
