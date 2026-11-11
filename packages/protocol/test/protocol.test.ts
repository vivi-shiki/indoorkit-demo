import { describe, expect, it } from 'vitest';
import {
  compareSeq,
  parseClientFrame,
  parsePositionReport,
  parseServerFrame,
  parseTopic,
  redisKeys,
  type ServerFrame,
  topic,
} from '../src/index';

describe('R1-02 topics', () => {
  it('builds and parses a topic', () => {
    const t = topic('hospital', 'pos', 'P-0001');
    expect(t).toBe('ik/v1/hospital/pos/P-0001');
    expect(parseTopic(t)).toEqual({ ok: true, value: { site: 'hospital', kind: 'pos', deviceId: 'P-0001' } });
  });

  it('names the bad field when building a topic', () => {
    expect(() => topic('school' as never, 'pos', 'a')).toThrow(/site/);
    expect(() => topic('hospital', 'pos', 'a/b')).toThrow(/deviceId/);
    expect(() => topic('hospital', 'pos', '')).toThrow(/deviceId/);
    expect(() => topic('hospital', 'what' as never, 'a')).toThrow(/kind/);
  });

  it('returns a failure for a topic received from outside', () => {
    for (const bad of [
      'ik/v2/hospital/pos/a',
      'ik/v1/school/pos/a',
      'ik/v1/hospital/pos',
      'ik/v1/hospital/pos/a/b',
      'ik/v1/hospital/pos/a+b',
    ]) {
      const r = parseTopic(bad);
      expect(r.ok, bad).toBe(false);
    }
    const r = parseTopic('ik/v1/school/pos/a');
    expect(!r.ok && r.error).toMatch(/site/);
  });
});

describe('R1-03 device reports', () => {
  it('accepts a position report', () => {
    const r = parsePositionReport(
      JSON.stringify({ seq: 3, ts: 1000, levelId: 'L1', coord: [139.7, 35.6], status: 'ok' }),
    );
    expect(r).toEqual({
      ok: true,
      value: { seq: 3, ts: 1000, levelId: 'L1', coord: [139.7, 35.6], status: 'ok' },
    });
  });

  it('accepts bytes as MQTT delivers them', () => {
    const r = parsePositionReport(
      new TextEncoder().encode(JSON.stringify({ seq: 0, ts: 1, levelId: 'L', coord: [0, 0] })),
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    ['not json', '{', /JSON/],
    ['negative seq', JSON.stringify({ seq: -1, ts: 1, levelId: 'L', coord: [0, 0] }), /seq/],
    ['missing level', JSON.stringify({ seq: 1, ts: 1, coord: [0, 0] }), /levelId/],
    ['bad coord', JSON.stringify({ seq: 1, ts: 1, levelId: 'L', coord: [0] }), /coord/],
    ['infinite coord', '{"seq":1,"ts":1,"levelId":"L","coord":[1e999,0]}', /coord/],
  ])('rejects %s without throwing', (_name, text, why) => {
    const r = parsePositionReport(text);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(why);
  });
});

describe('R1-03 WebSocket frames', () => {
  it('round-trips every server frame type', () => {
    const frames: ServerFrame[] = [
      { type: 'hello', protocol: 1, serverTime: 5 },
      {
        type: 'snapshot',
        site: 'hospital',
        seq: '10-0',
        time: 5,
        positions: [{ id: 'a', levelId: 'L', coord: [1, 2] }],
        offline: ['b'],
      },
      {
        type: 'positions',
        site: 'hospital',
        seq: '11-0',
        time: 6,
        positions: [{ id: 'a', levelId: 'L', coord: [1, 2], status: 'sos' }],
      },
      { type: 'device', site: 'hospital', seq: '12-0', time: 7, online: ['b'], offline: [] },
      { type: 'source', site: 'hospital', seq: '13-0', time: 8, online: false },
      { type: 'synced', site: 'hospital', seq: '13-0', replayed: 2 },
      { type: 'positions', site: 'hospital', seq: '14-0', time: 9, positions: [], replay: true },
      { type: 'ping', t: 9, rttMs: 12 },
      { type: 'bye', reason: 'restart' },
    ];
    for (const f of frames) expect(parseServerFrame(JSON.stringify(f))).toEqual({ ok: true, value: f });
  });

  it('round-trips client frames', () => {
    for (const f of [
      { type: 'subscribe', site: 'hospital' },
      { type: 'subscribe', site: 'parking', after: '1-0' },
      { type: 'pong', t: 3 },
    ]) {
      expect(parseClientFrame(JSON.stringify(f))).toEqual({ ok: true, value: f });
    }
  });

  it('rejects unknown frames with a reason', () => {
    const r = parseClientFrame(JSON.stringify({ type: 'subscribe', site: 'school' }));
    expect(r.ok).toBe(false);
    expect(parseServerFrame('{"type":"nope"}').ok).toBe(false);
    expect(parseClientFrame('[]').ok).toBe(false);
  });
});

describe('R2-07 sequence numbers', () => {
  it('orders Redis stream ids numerically, not as text', () => {
    expect(compareSeq('9-0', '10-0')).toBeLessThan(0);
    expect(compareSeq('10-2', '10-10')).toBeLessThan(0);
    expect(compareSeq('10-1', '10-1')).toBe(0);
    expect(compareSeq('11-0', '10-99')).toBeGreaterThan(0);
  });

  it('keeps every Redis key in one place', () => {
    expect(redisKeys.state('hospital')).toBe('ik:hospital:state');
    expect(redisKeys.frames('hospital')).toBe('ik:hospital:frames');
  });
});
