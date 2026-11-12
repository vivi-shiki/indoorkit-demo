import { describe, expect, it } from 'vitest';
import {
  compareSeq,
  dateKeyOf,
  dayStartOf,
  GONE,
  parseBookingReport,
  parseClientFrame,
  parseDeviceReport,
  parseEventReport,
  parseParkingEvent,
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

describe('R4-03 device events', () => {
  it('accepts an event with an id and rejects one without', () => {
    expect(parsePositionReport('{}').ok).toBe(false);
    const ok = parseEventReport(
      JSON.stringify({ id: 'A0001:offline:5', ts: 5, type: 'status', status: 'offline' }),
    );
    expect(ok.ok).toBe(true);
    const bad = parseEventReport(JSON.stringify({ ts: 5, type: 'status', status: 'offline' }));
    expect(!bad.ok && bad.error).toMatch(/id/);
  });

  it('builds event topics', () => {
    expect(topic('hospital', 'event', 'A0001')).toBe('ik/v1/hospital/event/A0001');
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
      {
        type: 'alarm',
        site: 'hospital',
        seq: '13-1',
        time: 8,
        alarm: { id: 'alarm-1', time: 8, level: 'high', state: 'open', subjectId: 'P0001', layer: 'fence' },
      },
      { type: 'alarm-state', site: 'hospital', seq: '13-2', time: 9, id: 'alarm-1', state: 'acknowledged' },
      { type: 'synced', site: 'hospital', seq: '13-0', replayed: 2 },
      {
        type: 'site-event',
        site: 'parking',
        seq: '13-3',
        time: 9,
        event: { kind: 'park', visitId: 'v', bayId: 'b' },
      },
      {
        type: 'snapshot',
        site: 'parking',
        seq: '13-4',
        time: 9,
        positions: [],
        offline: [],
        day: { dayStart: 0, timeZone: 'Asia/Tokyo', parked: [] },
      },
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

describe('R5-01..03 parking reports', () => {
  const vehicle = {
    plate: '品川 300 あ 12-34',
    vehicleClass: 'standard',
    permit: false,
    contract: { kind: 'hourly' },
  };
  const base = {
    id: '20261112:V00001:entry',
    ts: 1,
    visitId: '20261112-V00001',
    plate: vehicle.plate,
    bayId: 'b',
    deviceId: 'd',
  };

  it('accepts the five parking events and keeps the vehicle on entry', () => {
    expect(parseParkingEvent(JSON.stringify({ ...base, kind: 'entry', vehicle }))).toEqual({
      ok: true,
      value: { ...base, kind: 'entry', vehicle },
    });
    for (const kind of ['park', 'leave', 'charged'])
      expect(parseParkingEvent(JSON.stringify({ ...base, kind })).ok).toBe(true);
    expect(parseParkingEvent(JSON.stringify({ ...base, kind: 'exit', paid: true, gateId: 'g' })).ok).toBe(
      true,
    );
  });

  it('names what is missing', () => {
    expect(parseParkingEvent(JSON.stringify({ ...base, kind: 'entry' }))).toEqual({
      ok: false,
      error: 'vehicle: an entry carries the vehicle',
    });
    expect(parseParkingEvent(JSON.stringify({ ...base, kind: 'exit' }))).toMatchObject({ ok: false });
    expect(parseParkingEvent(JSON.stringify({ ...base, kind: 'teleport' }))).toMatchObject({ ok: false });
  });

  it('accepts device readings and the booking list', () => {
    expect(parseDeviceReport('{"seq":1,"ts":2,"status":"online","value":12}')).toEqual({
      ok: true,
      value: { seq: 1, ts: 2, status: 'online', value: 12 },
    });
    expect(parseDeviceReport('{"seq":1,"ts":2,"status":"broken"}').ok).toBe(false);
    const booking = {
      ts: 1,
      reservations: [{ id: 'R-T001', bayId: 'b', from: 10, to: 20, plate: 'p' }],
      contracts: [{ id: 'M-001', bayId: 'b' }],
    };
    expect(parseBookingReport(JSON.stringify(booking))).toEqual({ ok: true, value: booking });
  });

  it('builds the new topics and marks the end of a track', () => {
    expect(topic('parking', 'dev', 'd1')).toBe('ik/v1/parking/dev/d1');
    expect(topic('parking', 'booking', 'sim')).toBe('ik/v1/parking/booking/sim');
    expect(
      parsePositionReport(JSON.stringify({ seq: 1, ts: 1, levelId: 'L', coord: [0, 0], status: GONE })).ok,
    ).toBe(true);
  });
});

describe('R5 site days', () => {
  it('finds local midnight and the date in the site time zone', () => {
    // 2026-11-12 01:30 JST = 2026-11-11 16:30 UTC
    const t = Date.UTC(2026, 10, 11, 16, 30);
    expect(dayStartOf(t, 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 11, 15, 0));
    expect(dateKeyOf(t, 'Asia/Tokyo')).toBe('20261112');
    expect(dayStartOf(t, 'UTC')).toBe(Date.UTC(2026, 10, 11));
    expect(dayStartOf(Date.UTC(2026, 10, 11, 15, 0), 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 11, 15, 0));
  });
});
