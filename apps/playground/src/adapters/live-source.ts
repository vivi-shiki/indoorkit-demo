import type { AlarmEvent, LiveProvider, LiveState } from '@indoorkit/live-client';
import type { DataProvider, PositionBatch } from '@indoorkit/rtls';

/** auto 先用后端、不行就用浏览器模拟器；live 只用后端；sim 只用模拟器（docs/backend/R2-11） */
export type SourceMode = 'auto' | 'live' | 'sim';
const MODES: readonly SourceMode[] = ['auto', 'live', 'sim'];

/** 后端不可用多久后改用模拟器（R2-12） */
export const FALLBACK_AFTER_MS = 4000;

/**
 * 从页面地址（?source=、?live=）和构建时的后端地址决定数据源。
 * 没有后端地址时只能用模拟器：Pages 现在就是这样，不会多出任何请求。
 */
export function resolveSource(query: URLSearchParams, buildUrl: string | undefined) {
  const url = query.get('live') || buildUrl || null;
  const requested = query.get('source') as SourceMode | null;
  const mode: SourceMode = !url ? 'sim' : requested && MODES.includes(requested) ? requested : 'auto';
  return { mode, url };
}

/** 后端 WebSocket 地址对应的 REST 地址：ws://host/ws → http://host/api（docs/backend/R4-08） */
export function apiBase(wsUrl: string | null): string | null {
  if (!wsUrl) return null;
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = `${u.pathname.replace(/\/ws$/, '')}/api`;
  return u.toString().replace(/\/$/, '');
}

export interface SourceStatus {
  mode: SourceMode;
  /** 地图上现在显示的是哪边的数据 */
  source: 'live' | 'sim';
  /** 后端连接状态；只用模拟器时为 'sim' */
  state: LiveState | 'sim';
  latencyMs: number | undefined;
  replayed: number;
  dropped: number;
  offline: number;
  sourceOnline: boolean | undefined;
}

export interface SwitchingProvider extends DataProvider {
  status(): SourceStatus;
  onStatus(listener: (status: SourceStatus) => void): () => void;
  /** 后端的告警；显示模拟器数据时不转发（R4-13） */
  onAlarm(listener: (event: AlarmEvent) => void): () => void;
}

/**
 * 把后端和模拟器合成一个数据源：地图只看到一个 DataProvider，切换对页面透明。
 * 模拟器只在需要时才创建（它会起一个 Worker），切回后端时立即释放。
 */
export function createSwitchingProvider(options: {
  mode: SourceMode;
  live: LiveProvider | null;
  createSim: () => DataProvider;
  /** 后端推来的对象里这个页面要的（R4-12）；模拟器本来就只模拟页面要的 */
  keep?: (id: string) => boolean;
}): SwitchingProvider {
  const { mode, createSim, keep } = options;
  const live = mode === 'sim' ? null : options.live;
  if (mode !== 'sim' && !live) throw new Error(`source mode "${mode}" needs a live provider`);
  const listeners = new Set<(batch: PositionBatch) => void>();
  const statusListeners = new Set<(s: SourceStatus) => void>();
  const alarmListeners = new Set<(e: AlarmEvent) => void>();
  let active: 'live' | 'sim' = mode === 'sim' ? 'sim' : 'live';
  let sim: DataProvider | null = null;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let offLive: (() => void) | undefined;
  let offLiveStatus: (() => void) | undefined;
  let offLiveAlarm: (() => void) | undefined;

  const forward = (from: 'live' | 'sim') => (input: PositionBatch) => {
    if (active !== from) return;
    const batch =
      from === 'live' && keep ? { ...input, positions: input.positions.filter((p) => keep(p.id)) } : input;
    for (const l of [...listeners]) l(batch);
  };
  const status = (): SourceStatus => {
    const s = live?.status();
    return {
      mode,
      source: active,
      state: s?.state ?? 'sim',
      latencyMs: s?.latencyMs,
      replayed: s?.replayed ?? 0,
      dropped: s?.dropped ?? 0,
      offline: s?.offline ?? 0,
      sourceOnline: s?.sourceOnline,
    };
  };
  const notify = () => {
    const s = status();
    for (const l of [...statusListeners]) l(s);
  };
  const switchToSim = () => {
    clearTimeout(fallback);
    fallback = undefined;
    active = 'sim';
    if (!sim) {
      sim = createSim();
      sim.subscribe(forward('sim'));
      void sim.start();
    }
    notify();
  };
  const switchToLive = () => {
    clearTimeout(fallback);
    fallback = undefined;
    active = 'live';
    sim?.dispose();
    sim = null;
    notify();
  };
  const armFallback = () => {
    if (mode !== 'auto' || fallback !== undefined || active === 'sim') return;
    fallback = setTimeout(switchToSim, FALLBACK_AFTER_MS);
  };

  return {
    start() {
      if (!live) {
        switchToSim();
        return;
      }
      offLive ??= live.subscribe(forward('live'));
      offLiveAlarm ??= live.onAlarm((e) => {
        if (active !== 'live') return;
        for (const l of [...alarmListeners]) l(e);
      });
      offLiveStatus ??= live.onStatus((s) => {
        if (s.state === 'open') {
          if (active !== 'live' || sim) switchToLive();
          else {
            clearTimeout(fallback);
            fallback = undefined;
            notify();
          }
        } else {
          armFallback();
          notify();
        }
      });
      void live.start();
      if (live.status().state !== 'open') armFallback();
    },
    stop() {
      clearTimeout(fallback);
      fallback = undefined;
      void live?.stop();
      void sim?.stop();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onAlarm(listener) {
      alarmListeners.add(listener);
      return () => alarmListeners.delete(listener);
    },
    dispose() {
      clearTimeout(fallback);
      fallback = undefined;
      offLive?.();
      offLiveStatus?.();
      offLiveAlarm?.();
      live?.dispose();
      sim?.dispose();
      sim = null;
      listeners.clear();
      statusListeners.clear();
      alarmListeners.clear();
    },
  };
}
