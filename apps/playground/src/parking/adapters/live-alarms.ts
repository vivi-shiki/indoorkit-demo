import type { AlarmEvent } from '@indoorkit/live-client';
import type { ParkingAlarm } from '@indoorkit/parking';
import type { AlarmRecord } from '@indoorkit/protocol';
import type { AlarmState, AlarmStore } from './alarms';

export interface LiveAlarmStore extends AlarmStore {
  /** 后端推来的告警变化 */
  apply(event: AlarmEvent): void;
  /** REST 读回的历史（含已解决的），和已有的合并 */
  merge(records: readonly AlarmRecord[]): void;
}

/**
 * 后端模式的告警（docs/backend/R5-09）：告警由 ingest 计算，这里只收下来，
 * 时刻换成当天 0 点起的毫秒。确认、解决先在本地生效，再交给后端（R4-10），后端推回的状态覆盖本地。
 */
export function createLiveAlarmStore(options: {
  origin: () => number;
  /** 后端的 REST 地址（…/api）；没有时只改本地 */
  api: string | null;
  fetch?: typeof fetch;
}): LiveAlarmStore {
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const alarms = new Map<string, ParkingAlarm>();
  let states = new Map<string, AlarmState>();
  let sorted: ParkingAlarm[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    sorted = [...alarms.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    for (const l of [...listeners]) l();
  };
  const toAlarm = (r: AlarmRecord): ParkingAlarm => {
    const x = r as unknown as ParkingAlarm;
    return {
      id: r.id,
      rule: x.rule,
      tier: x.tier,
      level: x.level,
      time: r.time - options.origin(),
      levelId: x.levelId,
      bayId: x.bayId ?? null,
      deviceId: x.deviceId ?? null,
      plate: x.plate ?? null,
    };
  };
  const add = (records: readonly AlarmRecord[]) => {
    for (const r of records) {
      alarms.set(r.id, toAlarm(r));
      states.set(r.id, r.state);
    }
  };

  return {
    apply(e) {
      if (e.type === 'state') states = new Map(states).set(e.id, e.state);
      else {
        // 快照只带最新的一部分未解决告警（R4-07），不在里面的不能当作已解决，保留原样
        add(e.type === 'raise' ? [e.alarm] : e.alarms);
        states = new Map(states);
      }
      notify();
    },
    merge(records) {
      for (const r of records) {
        if (alarms.has(r.id)) continue;
        alarms.set(r.id, toAlarm(r));
        states.set(r.id, r.state);
      }
      states = new Map(states);
      notify();
    },
    update: () => [],
    all: () => sorted,
    state: (id) => states.get(id) ?? 'open',
    setState(id, state) {
      states = new Map(states).set(id, state);
      notify();
      if (!options.api || state === 'open') return;
      const action = state === 'acknowledged' ? 'ack' : 'resolve';
      void send(`${options.api}/parking/alarms/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
      }).catch(() => {});
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
