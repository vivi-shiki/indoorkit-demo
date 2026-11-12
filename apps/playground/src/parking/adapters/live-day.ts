import {
  createParkingLedger,
  type DeviceReading,
  type MonthlyContract,
  type ParkedVehicle,
  type ParkingLedger,
  type ParkingSession,
  type Vehicle,
} from '@indoorkit/parking';
import type { MovingVehicle, ParkingEvent, SimReservation, Visit } from '@indoorkit/parking-simulator';
import {
  type BookingReport,
  bookingReportSchema,
  dayStartOf,
  GONE,
  type ParkingEventReport,
  parkingEventSchema,
} from '@indoorkit/protocol';
import type { PositionBatch } from '@indoorkit/rtls';

/**
 * 页面向「这一天」问的问题（docs/backend/R5-09）。浏览器模拟的 ParkingDay 和后端实现都回答这些；
 * 时刻都是当天 0 点起的毫秒，昨天是负数。
 */
export interface ParkingDayView {
  readonly visits: readonly Visit[];
  readonly reservations: readonly SimReservation[];
  readonly monthlyContracts: readonly MonthlyContract[];
  parkedAt(t: number): ParkedVehicle[];
  movingAt(t: number): MovingVehicle[];
  /** [from, to) 之间的入场、停车、离开、出场事件，按时刻 */
  events(from: number, to: number): ParkingEvent[];
  deviceReadings(t: number): DeviceReading[];
  sessions(t: number): ParkingSession[];
  visit(id: string): Visit;
}

/** 快照里的 day 和 site-event 帧里的 event：ingest 写的内容（services/ingest/src/parking/site.ts） */
type DayPayload = Record<string, unknown>;

export interface LiveParkingDay extends ParkingDayView {
  /** 当天 0 点（真实时间）；收到第一份快照前为 null */
  origin(): number | null;
  /** 快照：整份替换；time 是快照的时刻 */
  reset(day: DayPayload, time: number): void;
  /** 一条场景事件：停车事件、设备状态或预约 */
  apply(event: DayPayload): void;
  /** 行驶中车辆的位置；gone 表示行驶结束 */
  positions(batch: PositionBatch): void;
  subscribe(listener: () => void): () => void;
}

const isEvent = (e: { kind: string }): e is ParkingEvent => e.kind !== 'charged';

/**
 * 由后端的快照和之后的帧维护的「这一天」：停车事件进台账（和 ingest 同一份 createParkingLedger），
 * 设备读数和预约取最新的，行驶中的车取最新位置。时刻相对第一次快照那天的 0 点。
 */
export function createLiveParkingDay(options: { now?: () => number } = {}): LiveParkingDay {
  const now = options.now ?? Date.now;
  let origin: number | null = null;
  let ledger: ParkingLedger = createParkingLedger();
  let devices = new Map<string, DeviceReading>();
  let booking: Pick<BookingReport, 'reservations' | 'contracts'> = { reservations: [], contracts: [] };
  const moving = new Map<string, { levelId: string; coord: [number, number] }>();
  let lastBatch: PositionBatch | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };

  const rel = (wall: number) => wall - origin!;
  const event = (e: ParkingEventReport) =>
    ledger.apply({
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
  const device = (d: DayPayload) => {
    const reading: DeviceReading = {
      deviceId: String(d.deviceId),
      status: d.status as DeviceReading['status'],
    };
    if (typeof d.value === 'number') reading.value = d.value;
    devices.set(reading.deviceId, reading);
  };
  const setBooking = (b: DayPayload) => {
    const r = bookingReportSchema.safeParse({ ts: 0, ...b });
    if (r.success) booking = r.data;
  };

  /** 预约车辆入场的时刻：入场事件里车辆的合同指向预约 id */
  const arrivals = () => {
    const out = new Map<string, number>();
    for (const v of ledger.visits())
      if (v.vehicle.contract.kind === 'reservation') out.set(String(v.vehicle.contract.id), v.enteredAt);
    return out;
  };

  return {
    origin: () => origin,
    get visits() {
      return ledger.visits();
    },
    get reservations() {
      if (origin === null) return [];
      const arrived = arrivals();
      return booking.reservations.map((r) => ({
        id: r.id,
        bayId: r.bayId,
        from: rel(r.from),
        to: rel(r.to),
        plate: r.plate,
        arrivedAt: arrived.get(r.id) ?? null,
      }));
    },
    get monthlyContracts() {
      return booking.contracts;
    },
    parkedAt: (t) => ledger.parkedAt(t),
    movingAt: () =>
      [...moving].map(([id, p]) => ({
        id,
        plate: (() => {
          try {
            return ledger.visit(id).vehicle.plate;
          } catch {
            return '';
          }
        })(),
        levelId: p.levelId,
        coord: p.coord,
      })),
    events: (from, to) => ledger.events(from, to).filter(isEvent),
    deviceReadings: () => [...devices.values()],
    sessions: (t) => ledger.sessions(t),
    visit: (id) => ledger.visit(id),

    reset(day, time) {
      const timeZone = typeof day.timeZone === 'string' ? day.timeZone : 'UTC';
      // 0 点只在第一次定下：重连后的快照不让页面上的时刻跳动
      origin ??= dayStartOf(now(), timeZone);
      ledger = createParkingLedger();
      for (const e of Array.isArray(day.events) ? day.events : []) {
        const r = parkingEventSchema.safeParse(e);
        if (r.success) event(r.data);
      }
      devices = new Map();
      for (const d of Array.isArray(day.devices) ? (day.devices as DayPayload[]) : []) device(d);
      setBooking(day);
      // 快照里的位置就是现在全部行驶中的车：紧挨在 day 之前，时刻相同
      moving.clear();
      if (lastBatch?.time === time) {
        for (const p of lastBatch.positions)
          if (p.status !== GONE) moving.set(p.id, { levelId: p.levelId, coord: p.coord });
      }
      notify();
    },

    apply(e) {
      if (origin === null) return;
      if (e.type === 'parking') {
        const r = parkingEventSchema.safeParse(e);
        if (r.success) event(r.data);
      } else if (e.type === 'device') device(e);
      else if (e.type === 'booking') setBooking(e);
      notify();
    },

    positions(batch) {
      lastBatch = batch;
      for (const p of batch.positions) {
        if (p.status === GONE) moving.delete(p.id);
        else moving.set(p.id, { levelId: p.levelId, coord: p.coord });
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
