import { createParkingDay } from '@indoorkit/parking-simulator';
import {
  dayStartOf,
  GONE,
  parseBookingReport,
  parseDeviceReport,
  parseParkingEvent,
  parsePositionReport,
  parseTopic,
} from '@indoorkit/protocol';
import { describe, expect, it } from 'vitest';
import type { Outgoing } from '../src/faults';
import { createParkingDevices, PARKING } from '../src/parking';

const TZ = 'Asia/Tokyo';
const H = 3600_000;
// 2026-11-12 14:00 JST
const DAY0 = dayStartOf(Date.UTC(2026, 10, 12, 3), TZ);
const setup = (start = DAY0 + 14 * H) => {
  let t = start;
  const devices = createParkingDevices(PARKING, { seed: 'minato', timeZone: TZ, now: () => t });
  return { devices, at: (ms: number) => (t = ms) };
};
const kindOf = (m: Outgoing) =>
  parseTopic(m.topic).ok && (parseTopic(m.topic) as { value: { kind: string } }).value.kind;
const events = (out: Outgoing[]) =>
  out.flatMap((m) => {
    if (kindOf(m) !== 'event') return [];
    const r = parseParkingEvent(m.payload);
    if (!r.ok) throw new Error(r.error);
    return [r.value];
  });

describe('R5-02 parking events from the plan', () => {
  it('uploads every event since yesterday 0:00 in order, with ids that stay the same', () => {
    const a = setup().devices.backfill();
    const b = setup().devices.backfill();
    const ea = events(a);
    expect(ea.map((e) => e.id)).toEqual(events(b).map((e) => e.id));
    expect(ea[0]!.ts).toBeGreaterThanOrEqual(DAY0 - 24 * H);
    expect(ea.at(-1)!.ts).toBeLessThanOrEqual(DAY0 + 14 * H);
    for (let i = 1; i < ea.length; i++) expect(ea[i]!.ts).toBeGreaterThanOrEqual(ea[i - 1]!.ts);
    expect(new Set(ea.map((e) => e.id)).size).toBe(ea.length);
    // 和浏览器的计划一样多：昨天 0 点到今天 14 点的入场、停车、离开、出场
    const plan = createParkingDay(PARKING, { seed: 'minato' });
    const planned = plan.events(-Infinity, Infinity).filter((e) => e.time > -24 * H && e.time <= 14 * H);
    expect(ea.filter((e) => e.kind !== 'charged')).toHaveLength(planned.length);
    expect(ea.every((e) => e.id === `${e.visitId}:${e.kind}`)).toBe(true);
    expect(ea[0]!.visitId).toMatch(/^20261112-V\d{5}$/);
  });

  it('sends the vehicle on entry and the gate on exit; reservation contracts match the booking ids', () => {
    const out = setup().devices.backfill();
    const ea = events(out);
    expect(ea.filter((e) => e.kind === 'entry').every((e) => e.vehicle?.plate === e.plate)).toBe(true);
    expect(ea.filter((e) => e.kind === 'exit').every((e) => typeof e.paid === 'boolean' && e.gateId)).toBe(
      true,
    );
    const booking = out.find((m) => kindOf(m) === 'booking')!;
    expect(booking.retain).toBe(true);
    const r = parseBookingReport(booking.payload);
    if (!r.ok) throw new Error(r.error);
    const ids = new Set(r.value.reservations.map((x) => x.id));
    const reserved = ea.filter((e) => e.kind === 'entry' && e.vehicle!.contract.kind === 'reservation');
    expect(reserved.length).toBeGreaterThan(0);
    for (const e of reserved) expect(ids.has(String(e.vehicle!.contract.id))).toBe(true);
    expect(r.value.contracts.length).toBeGreaterThan(0);
  });

  it('ends the backfill with the retained state of every device', () => {
    const out = setup().devices.backfill();
    const retained = out.filter((m) => kindOf(m) === 'dev' && m.retain);
    expect(new Set(retained.map((m) => m.deviceId)).size).toBe(PARKING.devices.length);
    expect(retained.every((m) => parseDeviceReport(m.payload).ok)).toBe(true);
  });

  it('then sends only what happens next, and never an event twice', () => {
    const { devices, at } = setup();
    const first = events(devices.backfill());
    at(DAY0 + 14 * H + 10 * 60_000);
    const next = events(devices.tick());
    expect(next.length).toBeGreaterThan(0);
    const seen = new Set(first.map((e) => e.id));
    expect(next.every((e) => !seen.has(e.id) && e.ts > DAY0 + 14 * H)).toBe(true);
    expect(events(devices.tick())).toEqual([]);
  });

  it('plays the plan again the next day with new ids', () => {
    const { devices, at } = setup(DAY0 + 23 * H);
    devices.backfill();
    at(DAY0 + 24 * H + 9 * H);
    const out = devices.tick();
    expect(out.some((m) => kindOf(m) === 'booking')).toBe(true);
    expect(events(out).some((e) => e.visitId.startsWith('20261113-'))).toBe(true);
  });
});

describe('R5-03 vehicles on the move', () => {
  it('reports moving vehicles and a final gone when they stop', () => {
    const { devices, at } = setup();
    devices.backfill();
    const positions = (out: Outgoing[]) =>
      out
        .filter((m) => kindOf(m) === 'pos')
        .map((m) => ({
          id: m.deviceId,
          ...(parsePositionReport(m.payload) as { value: { status?: string } }).value,
        }));
    const first = positions(devices.tick());
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((p) => p.status === undefined)).toBe(true);
    at(DAY0 + 14 * H + 20 * 60_000);
    const later = positions(devices.tick());
    const gone = later.filter((p) => p.status === GONE).map((p) => p.id);
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.every((id) => first.some((p) => p.id === id))).toBe(true);
  });
});
