import { createAlarmEngine, type ParkingAlarm } from '@indoorkit/parking';
import { createParkingDay } from '@indoorkit/parking-simulator';
import {
  dayStartOf,
  parseBookingReport,
  parseDeviceReport,
  parseParkingEvent,
  parseTopic,
} from '@indoorkit/protocol';
import { describe, expect, it } from 'vitest';
// 设备端的补传就是这里的输入：两边对上才算整条链路一致
import type { Outgoing } from '../../device-sim/src/faults';
import { createParkingDevices, PARKING } from '../../device-sim/src/parking';
import { createParkingSite } from '../src/parking/site';

const TZ = 'Asia/Tokyo';
const H = 3600_000;
const DAY0 = dayStartOf(Date.UTC(2026, 10, 12, 3), TZ);

/** 浏览器模拟的告警：和 apps/playground 的 createAlarmStore 一样，从 0 点起每分钟检查一次 */
function browserAlarms(until: number): ParkingAlarm[] {
  const day = createParkingDay(PARKING, { seed: 'minato' });
  const engine = createAlarmEngine(PARKING);
  const out: ParkingAlarm[] = [];
  let since = 0;
  for (let step = 60_000; step <= until; step += 60_000) {
    out.push(...engine.check(day.snapshotAt(step, since)));
    since = step;
  }
  return out;
}

function feed(site: ReturnType<typeof createParkingSite>, messages: Outgoing[]) {
  for (const m of messages) {
    const t = parseTopic(m.topic);
    if (!t.ok) throw new Error(t.error);
    if (t.value.kind === 'event') {
      const r = parseParkingEvent(m.payload);
      if (!r.ok) throw new Error(r.error);
      site.event(r.value);
    } else if (t.value.kind === 'dev') {
      const r = parseDeviceReport(m.payload);
      if (!r.ok) throw new Error(r.error);
      site.device(t.value.deviceId, r.value);
    } else if (t.value.kind === 'booking') {
      const r = parseBookingReport(m.payload);
      if (!r.ok) throw new Error(r.error);
      site.booking(r.value);
    }
  }
}

const key = (a: {
  rule: string;
  time: number;
  bayId: string | null;
  deviceId: string | null;
  plate: string | null;
}) => `${a.rule}@${a.time}:${a.bayId}:${a.deviceId}:${a.plate}`;

describe('R5-05, R5-06 parking alarms in ingest', () => {
  it('raises the same alarms from the uploaded events as the browser simulation does', () => {
    const now = DAY0 + 14 * H;
    const devices = createParkingDevices(PARKING, { seed: 'minato', timeZone: TZ, now: () => now });
    const site = createParkingSite(PARKING, { origin: DAY0, timeZone: TZ, idPrefix: 'x' });
    feed(site, devices.backfill());
    site.advance(now);
    const { alarms, frames } = site.drain();
    const expected = browserAlarms(14 * H);
    expect(expected.length).toBeGreaterThan(10);
    expect(alarms.map((a) => key({ ...(a as unknown as ParkingAlarm), time: a.time - DAY0 }))).toEqual(
      expected.map(key),
    );
    expect(alarms[0]!.id).toMatch(/^x-PA-\d{5}$/);
    expect(frames.filter((f) => f.type === 'alarm')).toHaveLength(alarms.length);
    expect(new Set(alarms.map((a) => (a as unknown as ParkingAlarm).rule)).size).toBeGreaterThan(5);
  });

  it('counts an event delivered twice once', () => {
    const now = DAY0 + 10 * H;
    const devices = createParkingDevices(PARKING, { seed: 'minato', timeZone: TZ, now: () => now });
    const out = devices.backfill();
    const site = createParkingSite(PARKING, { origin: DAY0, timeZone: TZ, idPrefix: 'x' });
    feed(site, out);
    const once = site.ledger.visits().length;
    const events = site.drain().frames.filter((f) => f.type === 'site-event').length;
    feed(
      site,
      out.filter((m) => m.topic.includes('/event/')),
    );
    expect(site.ledger.visits()).toHaveLength(once);
    expect(site.drain().frames.filter((f) => f.type === 'site-event')).toHaveLength(0);
    expect(events).toBeGreaterThan(once);
  });

  it('rebuilds after a restart without raising old alarms again', () => {
    const now = DAY0 + 12 * H;
    const devices = createParkingDevices(PARKING, { seed: 'minato', timeZone: TZ, now: () => now });
    const out = devices.backfill();
    const site = createParkingSite(PARKING, { origin: DAY0, timeZone: TZ, idPrefix: 'y' });
    for (const m of out) {
      const r = m.topic.includes('/event/') ? parseParkingEvent(m.payload) : null;
      if (r?.ok) site.event(r.value, { silent: true });
    }
    site.advance(now, { silent: true });
    expect(site.drain().alarms).toEqual([]);
  });
});
