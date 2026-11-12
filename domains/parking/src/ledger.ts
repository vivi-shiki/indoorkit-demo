import type { ExitRecord, ParkedVehicle } from './alarm';
import type { Vehicle } from './model';
import type { ParkingSession } from './stats';
import { feeFor } from './tariff';

/** 设备报来的一次停车事件；时刻的基准由使用方决定（通常是当天 0 点起的毫秒） */
export interface LedgerEvent {
  time: number;
  kind: 'entry' | 'park' | 'leave' | 'exit' | 'charged';
  visitId: string;
  plate: string;
  bayId: string;
  /** 识别这次事件的设备 */
  deviceId: string;
  /** entry：入场时查到的车辆属性 */
  vehicle?: Vehicle;
  /** exit：是否已付款 */
  paid?: boolean;
  /** exit：出场的闸机 */
  gateId?: string;
}

/** 台账里的一次停车；还没发生的时刻是 Infinity */
export interface LedgerVisit {
  id: string;
  vehicle: Vehicle;
  bayId: string;
  enteredAt: number;
  parkedAt: number;
  leftAt: number;
  exitedAt: number;
  /** cash：在精算机付；app：App 预付（预约）；contract：月租、法人手配 */
  payment: 'cash' | 'app' | 'contract';
  paid: boolean;
  chargedAt?: number;
  entryCamera: string;
  exitCamera: string;
  exitGate: string;
}

const ORDER: Record<LedgerEvent['kind'], number> = { entry: 0, park: 1, charged: 2, leave: 3, exit: 4 };

const paymentOf = (v: Vehicle): LedgerVisit['payment'] =>
  v.contract.kind === 'monthly' || v.contract.kind === 'fleet'
    ? 'contract'
    : v.contract.kind === 'reservation'
      ? 'app'
      : 'cash';

/**
 * 停车台账（docs/backend/R5-05）：由设备报来的事件累积出每次停车，
 * 回答某一时刻停着哪些车、哪段时间出场了哪些车和停车记录。服务端和浏览器用同一份。
 * 同一事件重复到达只算一次；事件先于入场到达时等入场到了再算。
 */
export function createParkingLedger() {
  const visits = new Map<string, LedgerVisit>();
  const seen = new Set<string>();
  /** 入场还没到的事件 */
  const early = new Map<string, LedgerEvent[]>();
  const events: LedgerEvent[] = [];
  let sorted = true;

  const record = (v: LedgerVisit, e: LedgerEvent) => {
    if (e.kind === 'park') v.parkedAt = e.time;
    else if (e.kind === 'charged') v.chargedAt = e.time;
    else if (e.kind === 'leave') v.leftAt = e.time;
    else if (e.kind === 'exit') {
      v.exitedAt = e.time;
      v.exitCamera = e.deviceId;
      v.paid = e.paid ?? v.paid;
      v.exitGate = e.gateId ?? v.exitGate;
    }
    if (events.length > 0 && e.time < events.at(-1)!.time) sorted = false;
    events.push(e);
  };

  const apply = (e: LedgerEvent): boolean => {
    const key = `${e.visitId}:${e.kind}`;
    if (seen.has(key)) return false;
    if (e.kind === 'entry') {
      if (!e.vehicle) throw new Error(`entry ${e.visitId} has no vehicle`);
      seen.add(key);
      const v: LedgerVisit = {
        id: e.visitId,
        vehicle: e.vehicle,
        bayId: e.bayId,
        enteredAt: e.time,
        parkedAt: Infinity,
        leftAt: Infinity,
        exitedAt: Infinity,
        payment: paymentOf(e.vehicle),
        paid: true,
        entryCamera: e.deviceId,
        exitCamera: '',
        exitGate: '',
      };
      visits.set(v.id, v);
      record(v, e);
      for (const x of (early.get(e.visitId) ?? []).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]))
        record(v, x);
      early.delete(e.visitId);
      return true;
    }
    seen.add(key);
    const v = visits.get(e.visitId);
    if (v) record(v, e);
    else early.set(e.visitId, [...(early.get(e.visitId) ?? []), e]);
    return true;
  };

  const all = () => {
    if (!sorted) {
      events.sort((a, b) => a.time - b.time);
      sorted = true;
    }
    return events;
  };
  const list = () =>
    [...visits.values()].sort((a, b) => a.enteredAt - b.enteredAt || a.id.localeCompare(b.id));

  return {
    apply,
    /** 按入场时刻 */
    visits: list,
    visit(id: string): LedgerVisit {
      const v = visits.get(id);
      if (!v) throw new Error(`unknown visit "${id}"`);
      return v;
    },
    /** [from, to) 之间的事件，按时刻 */
    events: (from: number, to: number) => all().filter((e) => e.time >= from && e.time < to),
    /** t 时刻停在车位上的车；充满电的时刻只在已经充满时带上 */
    parkedAt: (t: number): ParkedVehicle[] =>
      list()
        .filter((v) => v.parkedAt <= t && t < v.leftAt)
        .map((v) => ({
          bayId: v.bayId,
          vehicle: v.vehicle,
          enteredAt: v.enteredAt,
          parkedAt: v.parkedAt,
          ...(v.chargedAt !== undefined && v.chargedAt <= t ? { chargedAt: v.chargedAt } : {}),
        })),
    /** (since, t] 之间的出场 */
    exits: (since: number, t: number): ExitRecord[] =>
      list()
        .filter((v) => v.exitedAt > since && v.exitedAt <= t)
        .map((v) => ({ vehicle: v.vehicle, time: v.exitedAt, paid: v.paid, gateId: v.exitGate })),
    /** t 时刻以前入场的停车记录，给运营统计用 */
    sessions: (t: number): ParkingSession[] =>
      list()
        .filter((v) => v.enteredAt <= t)
        .map((v) => {
          const exited = v.exitedAt <= t;
          return {
            plate: v.vehicle.plate,
            bayId: v.bayId,
            contract: v.vehicle.contract.kind,
            enteredAt: v.enteredAt,
            parkedAt: Math.min(v.parkedAt, t),
            leftAt: v.leftAt <= t ? v.leftAt : null,
            exitedAt: exited ? v.exitedAt : null,
            fee: v.payment === 'contract' ? 0 : feeFor(v.enteredAt, exited ? v.exitedAt : t).total,
            paid: v.paid,
          };
        }),
  };
}

export type ParkingLedger = ReturnType<typeof createParkingLedger>;
