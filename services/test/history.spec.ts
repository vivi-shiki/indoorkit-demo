import { describe, expect, it } from 'vitest';
import { GATEWAY, waitFor } from './helpers';

interface Point {
  ts: number;
  levelId: string;
  coord: [number, number];
  status?: string;
}

const history = async (deviceId: string, from: number, to: number) => {
  const res = await fetch(`${GATEWAY}/api/hospital/history?deviceId=${deviceId}&from=${from}&to=${to}`);
  return { status: res.status, body: (await res.json()) as { points?: Point[]; error?: string } };
};

describe('R4-02, R4-08 history from MongoDB', () => {
  it('returns a track for a person, in order and inside the range', async () => {
    const to = Date.now() + 1000;
    const from = to - 120_000;
    const points = await waitFor('a few points', async () => {
      const r = await history('P0001', from, Date.now());
      return (r.body.points?.length ?? 0) >= 3 ? r.body.points : null;
    });
    for (const p of points) {
      expect(p.ts).toBeGreaterThanOrEqual(from);
      expect(p.levelId).toBeTypeOf('string');
      expect(p.coord).toHaveLength(2);
    }
    for (let i = 1; i < points.length; i++) expect(points[i]!.ts).toBeGreaterThan(points[i - 1]!.ts);
  });

  it('returns a track for an asset as well', async () => {
    const points = await waitFor('asset points', async () => {
      const r = await history('A0001', Date.now() - 60_000, Date.now());
      return (r.body.points?.length ?? 0) > 0 ? r.body.points : null;
    });
    expect(points[0]).toHaveProperty('coord');
  });

  it('R4-11 rejects a range longer than an hour and names the field', async () => {
    const r = await history('P0001', 0, 3_600_001);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^to:/);
  });

  it('returns an empty track for an unknown device', async () => {
    const r = await history('NOPE', Date.now() - 60_000, Date.now());
    expect(r).toEqual({ status: 200, body: { points: [] } });
  });
});
