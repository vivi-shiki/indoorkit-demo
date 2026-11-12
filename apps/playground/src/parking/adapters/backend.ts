import { createLiveProvider, type LiveProvider } from '@indoorkit/live-client';
import { GONE } from '@indoorkit/protocol';
import type { DataProvider, PositionBatch } from '@indoorkit/rtls';
import { apiBase, FALLBACK_AFTER_MS, type SourceMode, type SourceStatus } from '../../adapters/live-source';
import { createWallClock, type SimClock } from './clock';
import { createLiveAlarmStore, type LiveAlarmStore } from './live-alarms';
import { createLiveParkingDay, type LiveParkingDay } from './live-day';

/** 停车场页面看到的数据源状态（标题栏的 LiveStatusMetric）和行驶中车辆的位置 */
export interface ParkingSource {
  status(): SourceStatus;
  onStatus(listener: (status: SourceStatus) => void): () => void;
  /** 给一个页面的位置流插件用：释放它不影响后端连接；显示浏览器模拟时为 null */
  movingFeed(): DataProvider | null;
}

export interface ParkingBackend {
  day: LiveParkingDay;
  alarms: LiveAlarmStore;
  clock: SimClock;
  source: ParkingSource;
}

/** 后端不可用、退回浏览器模拟时的状态 */
export function fallbackSource(mode: SourceMode): ParkingSource {
  const status: SourceStatus = {
    mode,
    source: 'sim',
    state: 'sim',
    latencyMs: undefined,
    replayed: 0,
    dropped: 0,
    offline: 0,
    sourceOnline: undefined,
  };
  return { status: () => status, onStatus: () => () => {}, movingFeed: () => null };
}

/**
 * 连上后端，等第一份快照（docs/backend/R5-09）。auto 模式 FALLBACK_AFTER_MS 内没等到就放弃，返回 null，
 * 由调用方用浏览器模拟；live 模式一直等。连上之后断线只是重连，不再换到模拟。
 */
export async function connectParking(options: {
  mode: Exclude<SourceMode, 'sim'>;
  url: string;
  live?: LiveProvider;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<ParkingBackend | null> {
  const live = options.live ?? createLiveProvider({ url: options.url, site: 'parking' });
  const api = apiBase(options.url);
  const now = options.now ?? Date.now;
  const day = createLiveParkingDay({ now });
  const alarms = createLiveAlarmStore({
    origin: () => day.origin() ?? 0,
    api,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const moving = new Set<(batch: PositionBatch) => void>();
  live.subscribe((batch) => {
    day.positions(batch);
    for (const l of [...moving]) l(batch);
  });
  // 告警的时刻要换成当天时刻，所以等 0 点定下之后再收
  const pending: Parameters<LiveAlarmStore['apply']>[0][] = [];
  live.onAlarm((e) => (day.origin() === null ? pending.push(e) : alarms.apply(e)));
  const ready = new Promise<void>((resolve) => {
    live.onSite((e) => {
      if (e.type === 'day') {
        day.reset(e.day, e.time);
        for (const a of pending.splice(0)) alarms.apply(a);
        resolve();
      } else day.apply(e.event);
    });
  });
  live.start();
  const timeout =
    options.mode === 'auto'
      ? new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), FALLBACK_AFTER_MS))
      : new Promise<never>(() => {});
  if ((await Promise.race([ready, timeout])) === 'timeout') {
    live.dispose();
    return null;
  }
  // 告警页要显示今天已经处理过的：从 REST 读回历史，不挡住打开页面
  if (api) {
    const send = options.fetch ?? fetch;
    void send(`${api}/parking/alarms?state=all&limit=500`)
      .then((res) => (res.ok ? res.json() : { alarms: [] }))
      .then((body: { alarms: Parameters<LiveAlarmStore['merge']>[0] }) => alarms.merge(body.alarms))
      .catch(() => {});
  }

  const status = (): SourceStatus => {
    const s = live.status();
    return {
      mode: options.mode,
      source: 'live',
      state: s.state,
      latencyMs: s.latencyMs,
      replayed: s.replayed,
      dropped: s.dropped,
      offline: s.offline,
      sourceOnline: s.sourceOnline,
    };
  };
  return {
    day,
    alarms,
    clock: createWallClock({ origin: day.origin()!, now }),
    source: {
      status,
      onStatus(listener) {
        return live.onStatus(() => listener(status()));
      },
      movingFeed() {
        const listeners = new Set<(batch: PositionBatch) => void>();
        const forward = (batch: PositionBatch) => {
          const positions = batch.positions.filter((p) => p.status !== GONE);
          for (const l of [...listeners]) l({ ...batch, positions });
        };
        moving.add(forward);
        return {
          start() {},
          stop() {},
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          dispose() {
            moving.delete(forward);
            listeners.clear();
          },
        };
      },
    },
  };
}
