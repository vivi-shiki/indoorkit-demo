/**
 * 后端实时数据的浏览器客户端：实现 @indoorkit/rtls 的 DataProvider，
 * 内含重连、断点续传、心跳和序号去重（docs/backend/R2、R3）。不依赖 React 和地图。
 */
import {
  type AlarmRecord,
  type AlarmState,
  compareSeq,
  parseServerFrame,
  type ServerFrame,
  type Site,
  type TagState,
} from '@indoorkit/protocol';
import type { DataProvider, PositionBatch } from '@indoorkit/rtls';

/** 浏览器 WebSocket 里用到的部分；测试时注入假的 */
export interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

/** idle 未启动；connecting 第一次连接；open 已同步（收到快照或补发结束）；reconnecting 断开后等待重连 */
export type LiveState = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface LiveStatus {
  state: LiveState;
  /** 服务器测得的往返延迟 */
  latencyMs: number | undefined;
  reconnects: number;
  snapshots: number;
  /** 断线续传时补发的帧数 */
  replayed: number;
  /** 序号不新而丢弃的帧数 */
  dropped: number;
  /** 无法解析的帧数 */
  invalid: number;
  /** 当前离线的设备数 */
  offline: number;
  /** 设备端（模拟器）是否在线；还不知道时为 undefined */
  sourceOnline: boolean | undefined;
}

/** 告警的变化：新告警、状态变化；快照时整体替换为当前未处理的告警（docs/backend/R4） */
export type AlarmEvent =
  | { type: 'raise'; alarm: AlarmRecord }
  | { type: 'state'; id: string; state: AlarmState }
  | { type: 'reset'; alarms: AlarmRecord[] };

export interface LiveProvider extends DataProvider {
  status(): LiveStatus;
  onStatus(listener: (status: LiveStatus) => void): () => void;
  onAlarm(listener: (event: AlarmEvent) => void): () => void;
}

export interface LiveOptions {
  url: string;
  site: Site;
  WebSocket?: WebSocketCtor;
  /** 0～1 的随机数，用于重连抖动 */
  random?: () => number;
  /** 这么久收不到任何消息就认为连接已死（R3-06） */
  silenceMs?: number;
  /** 握手超过这么久还没完成就放弃这次连接，按退避重试 */
  connectTimeoutMs?: number;
}

const BASE_MS = 1000;
const MAX_MS = 30_000;

/** 第 attempt 次重连前的等待：1s、2s、4s……封顶 30s，再乘 0.5～1 的随机抖动（R3-07） */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(MAX_MS, BASE_MS * 2 ** attempt);
  return Math.round(base * (0.5 + 0.5 * random()));
}

export function createLiveProvider(options: LiveOptions): LiveProvider {
  const Ctor = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const random = options.random ?? Math.random;
  const silenceMs = options.silenceMs ?? 35_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const listeners = new Set<(batch: PositionBatch) => void>();
  const statusListeners = new Set<(status: LiveStatus) => void>();
  const alarmListeners = new Set<(event: AlarmEvent) => void>();
  const emitAlarm = (event: AlarmEvent) => {
    for (const l of [...alarmListeners]) l(event);
  };

  let started = false;
  let disposed = false;
  let ws: WebSocketLike | null = null;
  let lastSeq: string | undefined;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  const offline = new Set<string>();
  const status: LiveStatus = {
    state: 'idle',
    latencyMs: undefined,
    reconnects: 0,
    snapshots: 0,
    replayed: 0,
    dropped: 0,
    invalid: 0,
    offline: 0,
    sourceOnline: undefined,
  };

  const notify = () => {
    status.offline = offline.size;
    const copy = { ...status };
    for (const l of [...statusListeners]) l(copy);
  };
  const setState = (state: LiveState) => {
    if (status.state === state) return;
    status.state = state;
    notify();
  };
  const emit = (time: number, positions: TagState[]) => {
    const batch: PositionBatch = { time, positions };
    for (const l of [...listeners]) l(batch);
  };
  const clearTimers = () => {
    clearTimeout(retryTimer);
    clearTimeout(silenceTimer);
    retryTimer = undefined;
    silenceTimer = undefined;
  };
  /** 握手和之后的静默共用一个计时器：到时间就关掉，onclose 里按退避重连 */
  const armSilence = (ms = silenceMs) => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      silenceTimer = undefined;
      ws?.close(4000, 'silent');
    }, ms);
  };

  const closeSocket = () => {
    const s = ws;
    ws = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close(1000, 'client');
    }
  };

  const scheduleReconnect = (delay: number) => {
    clearTimers();
    setState('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      status.reconnects++;
      connect();
    }, delay);
  };

  const synced = () => {
    attempt = 0;
    setState('open');
  };

  const handle = (frame: ServerFrame) => {
    switch (frame.type) {
      case 'hello':
        return;
      case 'ping':
        ws?.send(JSON.stringify({ type: 'pong', t: frame.t }));
        if (frame.rttMs !== undefined) {
          status.latencyMs = frame.rttMs;
          notify();
        }
        return;
      case 'bye':
        // 服务器在重启：马上重连到别的副本，不等退避
        closeSocket();
        scheduleReconnect(0);
        return;
      case 'snapshot':
        lastSeq = frame.seq;
        offline.clear();
        for (const id of frame.offline) offline.add(id);
        if (frame.source !== undefined) status.sourceOnline = frame.source;
        status.snapshots++;
        emit(frame.time, frame.positions);
        if (frame.alarms) emitAlarm({ type: 'reset', alarms: frame.alarms });
        synced();
        notify();
        return;
      case 'synced':
        status.replayed += frame.replayed;
        synced();
        notify();
        return;
    }
    if (lastSeq !== undefined && compareSeq(frame.seq, lastSeq) <= 0) {
      status.dropped++;
      return;
    }
    lastSeq = frame.seq;
    if (frame.type === 'positions') emit(frame.time, frame.positions);
    else if (frame.type === 'alarm') emitAlarm({ type: 'raise', alarm: frame.alarm });
    else if (frame.type === 'alarm-state') emitAlarm({ type: 'state', id: frame.id, state: frame.state });
    else if (frame.type === 'device') {
      for (const id of frame.online) offline.delete(id);
      for (const id of frame.offline) offline.add(id);
      notify();
    } else {
      status.sourceOnline = frame.online;
      notify();
    }
  };

  function connect() {
    closeSocket();
    setState(status.snapshots === 0 && status.reconnects === 0 ? 'connecting' : 'reconnecting');
    const s = new Ctor(options.url);
    ws = s;
    armSilence(connectTimeoutMs);
    s.onopen = () => {
      armSilence();
      s.send(
        JSON.stringify(
          lastSeq
            ? { type: 'subscribe', site: options.site, after: lastSeq }
            : { type: 'subscribe', site: options.site },
        ),
      );
    };
    s.onmessage = (e) => {
      armSilence();
      const r = parseServerFrame(String(e.data));
      if (!r.ok) {
        status.invalid++;
        return;
      }
      handle(r.value);
    };
    // 浏览器在失败时先 error 后 close；Node 的 WebSocket 握手被拒时只有 error。两个都当作断开，只处理一次
    s.onclose = s.onerror = () => {
      if (ws !== s) return;
      closeSocket();
      scheduleReconnect(backoffDelay(attempt++, random));
    };
  }

  return {
    start() {
      if (disposed) throw new Error('the live provider is disposed');
      if (started) return;
      started = true;
      connect();
    },
    stop() {
      started = false;
      clearTimers();
      closeSocket();
      attempt = 0;
      setState('idle');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => ({ ...status, offline: offline.size }),
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onAlarm(listener) {
      alarmListeners.add(listener);
      return () => alarmListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      clearTimers();
      closeSocket();
      listeners.clear();
      statusListeners.clear();
      alarmListeners.clear();
    },
  };
}
