import {
  createAlarmEngine,
  createParkingLedger,
  type DeviceReading,
  type Parking,
  type ParkingSnapshot,
  type ReservationState,
  type Vehicle,
} from '@indoorkit/parking';
import type {
  AlarmRecord,
  BookingReport,
  DeviceReport,
  ParkingEventReport,
  StreamFrame,
} from '@indoorkit/protocol';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 写进 Redis 的停车场当天状态，快照时给浏览器（R5-04、R5-07）；时刻都是真实时间 */
export interface ParkingDayState {
  timeZone: string;
  devices: (DeviceReading & { ts: number })[];
  reservations: BookingReport['reservations'];
  contracts: BookingReport['contracts'];
}

export interface ParkingSiteOptions {
  /** 当天 0 点（真实时间）：告警从这一刻起每分钟检查，和浏览器模拟一样 */
  origin: number;
  timeZone: string;
  /** 告警 id 的前缀，每次启动不同 */
  idPrefix: string;
}

/**
 * ingest 里的停车场（docs/backend/R5-05、R5-06）：台账、设备读数和预约，
 * 按数据的时间每分钟检查一次告警。不碰网络；产生的帧和告警由调用方取走写进 Redis 和 MongoDB。
 * 所有输入在处理前先把更早的整分钟检查完，所以补传和实时得到的告警与浏览器从 0 点逐分钟检查的相同。
 */
export function createParkingSite(parking: Parking, options: ParkingSiteOptions) {
  const { origin, idPrefix } = options;
  const ledger = createParkingLedger();
  const engine = createAlarmEngine(parking);
  const devices = new Map<string, DeviceReading & { ts: number }>();
  let booking: BookingReport = { ts: 0, reservations: [], contracts: [] };
  /** 预约 id → 预约车辆入场的时刻（相对 origin） */
  const arrivals = new Map<string, number>();
  let checked = 0;
  let frames: StreamFrame[] = [];
  let alarms: AlarmRecord[] = [];
  let dayChanged = false;

  const rel = (wall: number) => wall - origin;
  const reservationsAt = (t: number): ReservationState[] =>
    booking.reservations
      .map((r) => ({ id: r.id, bayId: r.bayId, from: rel(r.from), to: rel(r.to) }))
      .filter((r) => r.from - HOUR <= t && t < r.to)
      .map((r) => {
        const at = arrivals.get(r.id);
        return { ...r, arrivedAt: at !== undefined && at <= t ? at : null };
      });

  /** 检查 step < before 的每个整分钟（before 省略时检查到 until 为止，含 until） */
  const checkUntil = (limit: number, inclusive: boolean, silent: boolean) => {
    for (let step = checked + MINUTE; inclusive ? step <= limit : step < limit; step += MINUTE) {
      const snapshot: ParkingSnapshot = {
        now: step,
        parked: ledger.parkedAt(step),
        reservations: reservationsAt(step),
        devices: [...devices.values()].map(({ ts: _, ...d }) => d),
        exits: ledger.exits(checked, step),
      };
      checked = step;
      for (const a of engine.check(snapshot)) {
        if (silent) continue;
        const record: AlarmRecord = { ...a, id: `${idPrefix}-${a.id}`, time: origin + a.time, state: 'open' };
        alarms.push(record);
        frames.push({ type: 'alarm', site: 'parking', time: record.time, alarm: record });
      }
    }
  };

  return {
    /** 一条停车事件；重复的返回 false */
    event(e: ParkingEventReport, options: { silent?: boolean } = {}): boolean {
      checkUntil(rel(e.ts), false, options.silent ?? false);
      const applied = ledger.apply({
        time: rel(e.ts),
        kind: e.kind,
        visitId: e.visitId,
        plate: e.plate,
        bayId: e.bayId,
        deviceId: e.deviceId,
        ...(e.vehicle ? { vehicle: e.vehicle as unknown as Vehicle } : {}),
        ...(e.paid === undefined ? {} : { paid: e.paid }),
        ...(e.gateId === undefined ? {} : { gateId: e.gateId }),
      });
      if (!applied) return false;
      if (e.kind === 'entry' && e.vehicle?.contract.kind === 'reservation')
        arrivals.set(String(e.vehicle.contract.id), rel(e.ts));
      if (!options.silent)
        frames.push({ type: 'site-event', site: 'parking', time: e.ts, event: { type: 'parking', ...e } });
      return true;
    },

    device(deviceId: string, r: DeviceReport, options: { silent?: boolean } = {}) {
      const before = devices.get(deviceId);
      if (before && before.ts > r.ts) return;
      checkUntil(rel(r.ts), false, options.silent ?? false);
      const reading: DeviceReading & { ts: number } = { deviceId, status: r.status, ts: r.ts };
      if (r.value !== undefined) reading.value = r.value;
      devices.set(deviceId, reading);
      dayChanged = true;
      if (!options.silent && (before?.status !== r.status || before?.value !== r.value))
        frames.push({
          type: 'site-event',
          site: 'parking',
          time: r.ts,
          event: { type: 'device', ...reading },
        });
    },

    booking(b: BookingReport) {
      booking = b;
      dayChanged = true;
      frames.push({ type: 'site-event', site: 'parking', time: b.ts, event: { type: 'booking', ...b } });
    },

    /** 检查到 now 为止的整分钟（实时时由定时器调用；silent 用于重启后重建状态） */
    advance(now: number, options: { silent?: boolean } = {}) {
      checkUntil(rel(now), true, options.silent ?? false);
    },

    /** 取走这段时间产生的帧和告警 */
    drain(): { frames: StreamFrame[]; alarms: AlarmRecord[]; day: ParkingDayState | null } {
      const out = {
        frames,
        alarms,
        day: dayChanged
          ? {
              timeZone: options.timeZone,
              devices: [...devices.values()],
              reservations: booking.reservations,
              contracts: booking.contracts,
            }
          : null,
      };
      frames = [];
      alarms = [];
      dayChanged = false;
      return out;
    },

    /** 重启后从 Redis 读回的设备和预约 */
    restore(day: ParkingDayState) {
      for (const d of day.devices) devices.set(d.deviceId, d);
      booking = { ts: 0, reservations: day.reservations, contracts: day.contracts };
    },

    ledger,
  };
}

export type ParkingSite = ReturnType<typeof createParkingSite>;
