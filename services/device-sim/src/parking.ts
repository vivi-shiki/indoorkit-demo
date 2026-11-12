import { buildVenueModel } from '@indoorkit/imdf';
import { createParking, type Parking, parkingExtensions } from '@indoorkit/parking';
import { createParkingDay, type ParkingDay, type Visit } from '@indoorkit/parking-simulator';
import {
  type BookingReport,
  type DeviceReport,
  dateKeyOf,
  dayStartOf,
  GONE,
  type ParkingEventReport,
  type PositionReport,
  SIM_SOURCE_ID,
  topic,
} from '@indoorkit/protocol';
import { generateParking, MINATO_PARKING } from '@indoorkit/venue-gen';
import type { Outgoing } from './faults';

/** 和浏览器加载的是同一份虚构停车场 */
export const PARKING: Parking = createParking(
  buildVenueModel(generateParking(MINATO_PARKING), parkingExtensions),
);

const DAY = 24 * 3600_000;
const MINUTE = 60_000;

/** 计划里的一个事件，时刻是相对计划当天 0 点的毫秒 */
interface PlanEvent {
  time: number;
  kind: ParkingEventReport['kind'];
  visit: Visit;
  deviceId: string;
  paid?: boolean;
}

/** 计划对到某一天：第一天（启动那天）带上计划里的昨天，之后每天只播计划里的今天 */
interface Anchor {
  start: number;
  key: string;
  first: boolean;
}

export interface ParkingDeviceOptions {
  seed: string;
  timeZone: string;
  now: () => number;
}

/**
 * 停车场的设备（docs/backend/R5a）：按真实时钟播放浏览器同一个种子的计划。
 * 启动时补传昨天 0 点起的事件，之后每次 tick 发出新发生的事件、行驶中的车辆位置和设备状态变化。
 */
export function createParkingDevices(parking: Parking, options: ParkingDeviceOptions) {
  const { timeZone, now } = options;
  const plan: ParkingDay = createParkingDay(parking, { seed: options.seed });
  const startedAt = now();
  const firstDay = dayStartOf(startedAt, timeZone);

  // 计划里的全部事件（含充满电），按时刻排好
  const parkDevice = new Map<string, string>();
  const planEvents: PlanEvent[] = [];
  for (const e of plan.events(-Infinity, Infinity)) {
    const visit = plan.visit(e.visitId);
    if (e.kind === 'park') parkDevice.set(visit.id, e.deviceId);
    planEvents.push({
      time: e.time,
      kind: e.kind,
      visit,
      deviceId: e.deviceId,
      ...(e.paid === undefined ? {} : { paid: e.paid }),
    });
  }
  for (const v of plan.visits) {
    if (v.chargedAt !== undefined && v.chargedAt < v.leftAt)
      planEvents.push({ time: v.chargedAt, kind: 'charged', visit: v, deviceId: parkDevice.get(v.id)! });
  }
  planEvents.sort((a, b) => a.time - b.time);

  const anchors = (until: number): Anchor[] => {
    const out: Anchor[] = [];
    // 一次停车最长跨两天，更早的日子已经播完
    // 启动那天之前（补传昨天时）也用启动那天的计划，它带着昨天
    for (let start = firstDay; start <= Math.max(until, firstDay); start += DAY)
      if (start > until - 3 * DAY)
        out.push({ start, key: dateKeyOf(start + DAY / 2, timeZone), first: start === firstDay });
    return out;
  };
  const includes = (a: Anchor, enteredAt: number) => a.first || enteredAt >= 0;
  const visitId = (a: Anchor, v: Visit) => `${a.key}-${v.id}`;
  const reservationId = (a: Anchor, id: string) => `${a.key}-${id}`;

  const toReport = (a: Anchor, e: PlanEvent): ParkingEventReport => {
    const id = visitId(a, e.visit);
    const report: ParkingEventReport = {
      id: `${id}:${e.kind}`,
      ts: a.start + e.time,
      kind: e.kind,
      visitId: id,
      plate: e.visit.vehicle.plate,
      bayId: e.visit.bayId,
      deviceId: e.deviceId,
    };
    if (e.kind === 'entry') {
      const { contract } = e.visit.vehicle;
      // 预约车辆的合同指向预约 id，和预约系统发的一样带上日期
      report.vehicle = {
        ...e.visit.vehicle,
        contract:
          contract.kind === 'reservation'
            ? { ...contract, id: reservationId(a, contract.id) }
            : { ...contract },
      };
    }
    if (e.kind === 'exit') {
      report.paid = e.paid ?? e.visit.paid;
      report.gateId = e.visit.exitGate;
    }
    return report;
  };

  /** 真实时间 (from, to] 之间发生的事件，按时刻 */
  const eventsBetween = (from: number, to: number): ParkingEventReport[] => {
    const out: ParkingEventReport[] = [];
    for (const a of anchors(to)) {
      for (const e of planEvents) {
        const t = a.start + e.time;
        if (t <= from || t > to || !includes(a, e.visit.enteredAt)) continue;
        out.push(toReport(a, e));
      }
    }
    return out.sort((x, y) => x.ts - y.ts);
  };

  /** 真实时间 t 时每台设备的状态；CO 传感器带浓度 */
  const devicesAt = (t: number): Map<string, Omit<DeviceReport, 'seq' | 'ts'>> => {
    const out = new Map<string, Omit<DeviceReport, 'seq' | 'ts'>>(
      parking.devices.map((d) => [d.id, { status: 'online' }]),
    );
    const current = anchors(t).at(-1)!;
    for (const a of anchors(t)) {
      for (const i of plan.incidents) {
        if (!includes(a, i.from) || a.start + i.from > t || t >= a.start + i.to) continue;
        if (parking.device(i.deviceId).kind !== 'co-sensor') out.set(i.deviceId, { status: i.status });
      }
    }
    for (const r of plan.deviceReadings(t - current.start)) {
      if (r.value !== undefined) out.set(r.deviceId, { status: r.status, value: r.value });
    }
    return out;
  };

  const booking = (until: number): BookingReport => ({
    ts: until,
    reservations: anchors(until).flatMap((a) =>
      plan.reservations
        .filter((r) => includes(a, r.from))
        .map((r) => ({
          id: reservationId(a, r.id),
          bayId: r.bayId,
          from: a.start + r.from,
          to: a.start + r.to,
          plate: r.plate,
        })),
    ),
    contracts: plan.monthlyContracts.map((c) => ({ id: c.id, bayId: c.bayId })),
  });

  const seq = new Map<string, number>();
  const nextSeq = (id: string) => {
    const n = (seq.get(id) ?? -1) + 1;
    seq.set(id, n);
    return n;
  };
  const eventMessage = (e: ParkingEventReport): Outgoing => ({
    deviceId: e.deviceId,
    topic: topic('parking', 'event', e.deviceId),
    payload: JSON.stringify(e),
    qos: 1,
  });
  const deviceMessage = (
    deviceId: string,
    ts: number,
    d: Omit<DeviceReport, 'seq' | 'ts'>,
    retain: boolean,
  ): Outgoing => ({
    deviceId,
    topic: topic('parking', 'dev', deviceId),
    payload: JSON.stringify({ seq: nextSeq(deviceId), ts, ...d } satisfies DeviceReport),
    qos: 1,
    retain,
  });
  const bookingMessage = (until: number): Outgoing => ({
    deviceId: SIM_SOURCE_ID,
    topic: topic('parking', 'booking', SIM_SOURCE_ID),
    payload: JSON.stringify(booking(until)),
    qos: 1,
    retain: true,
  });
  const same = (a: Omit<DeviceReport, 'seq' | 'ts'> | undefined, b: Omit<DeviceReport, 'seq' | 'ts'>) =>
    a?.status === b.status && a?.value === b.value;

  let cursor = firstDay - DAY;
  let lastDevices = new Map<string, Omit<DeviceReport, 'seq' | 'ts'>>();
  let lastMinute = -1;
  let today = '';
  const moving = new Map<string, PositionReport>();

  return {
    /** 启动时的补传：预约、昨天 0 点起的事件和设备变化按时刻交错，最后是每台设备现在的状态（保留） */
    backfill(): Outgoing[] {
      const until = now();
      const out: Outgoing[] = [bookingMessage(until)];
      today = anchors(until).at(-1)!.key;
      // 设备状态只在事故开始和结束时变化
      const changes = new Set<number>();
      for (const a of anchors(until))
        for (const i of plan.incidents)
          if (includes(a, i.from))
            for (const t of [a.start + i.from, a.start + i.to]) if (t > cursor && t <= until) changes.add(t);
      const timeline: { ts: number; message: () => Outgoing[] }[] = [
        ...eventsBetween(cursor, until).map((e) => ({ ts: e.ts, message: () => [eventMessage(e)] })),
        ...[...changes].map((t) => ({
          ts: t,
          message: () => {
            const next = devicesAt(t);
            const sent: Outgoing[] = [];
            for (const [id, d] of next)
              if (!same(lastDevices.get(id), d)) sent.push(deviceMessage(id, t, d, false));
            lastDevices = next;
            return sent;
          },
        })),
      ].sort((a, b) => a.ts - b.ts);
      for (const item of timeline) out.push(...item.message());
      lastDevices = devicesAt(until);
      for (const [id, d] of lastDevices) out.push(deviceMessage(id, until, d, true));
      cursor = until;
      lastMinute = Math.floor(until / MINUTE);
      return out;
    },

    /** 上次以来的事件、设备变化（CO 每分钟一次）、行驶中的车辆位置和刚结束行驶的 gone */
    tick(): Outgoing[] {
      const t = now();
      const out: Outgoing[] = [];
      const current = anchors(t);
      // 过了 0 点：预约系统发新一天的预约
      if (current.at(-1)!.key !== today) {
        today = current.at(-1)!.key;
        out.push(bookingMessage(t));
      }
      for (const e of eventsBetween(cursor, t)) out.push(eventMessage(e));
      const devices = devicesAt(t);
      const minute = Math.floor(t / MINUTE);
      for (const [id, d] of devices) {
        const co = d.value !== undefined && minute !== lastMinute;
        if (co || !same(lastDevices.get(id), d)) out.push(deviceMessage(id, t, d, true));
      }
      lastDevices = devices;
      lastMinute = minute;
      cursor = t;

      const seen = new Set<string>();
      for (const a of current) {
        for (const m of plan.movingAt(t - a.start)) {
          const v = plan.visit(m.id);
          if (!includes(a, v.enteredAt)) continue;
          const id = visitId(a, v);
          seen.add(id);
          const report: PositionReport = { seq: nextSeq(id), ts: t, levelId: m.levelId, coord: m.coord };
          moving.set(id, report);
          out.push({ deviceId: id, topic: topic('parking', 'pos', id), payload: JSON.stringify(report) });
        }
      }
      for (const [id, last] of moving) {
        if (seen.has(id)) continue;
        moving.delete(id);
        const report: PositionReport = { ...last, seq: nextSeq(id), ts: t, status: GONE };
        out.push({ deviceId: id, topic: topic('parking', 'pos', id), payload: JSON.stringify(report) });
      }
      return out;
    },
  };
}
