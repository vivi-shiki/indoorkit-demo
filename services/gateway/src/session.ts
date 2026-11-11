import {
  compareSeq,
  PROTOCOL_VERSION,
  parseClientFrame,
  type ServerFrame,
  type Site,
} from '@indoorkit/protocol';
import type { FrameStore, SeqFrame } from './store';

/** WebSocket 里 session 用到的部分 */
export interface SocketLike {
  send(text: string): void;
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

export interface SessionOptions {
  socket: SocketLike;
  store: FrameStore;
  now: () => number;
  /** 背压阈值（字节）：发送缓冲超过 high 停发位置帧，降到 low 以下补一个快照（R3-09） */
  limits: { high: number; low: number };
}

/** 连续几次 ping 没有回应就断开（R3-06） */
const MAX_MISSED_PONGS = 2;

/**
 * 一个浏览器连接：订阅、快照、增量、断点续传、心跳和背压。
 * 不直接碰 WebSocket 和 Redis，测试时换成假的。
 */
export function createSession({ socket, store, now, limits }: SessionOptions) {
  let site: Site | null = null;
  /** 已经发给客户端的最后一帧（或快照）的序号 */
  let cursor = '0-0';
  /** 正在读快照或补发：这期间到达的帧先排队 */
  let syncing: Promise<void> | null = null;
  let queue: SeqFrame[] = [];
  let owed = false;
  let missedPongs = 0;
  let rttMs: number | undefined;
  const stats = { invalid: 0, replayed: 0, snapshots: 0, skipped: 0, sent: 0 };

  const send = (frame: ServerFrame) => {
    socket.send(JSON.stringify(frame));
    stats.sent++;
  };

  const sendSnapshot = async (s: Site) => {
    const seq = (await store.lastSeq(s)) ?? '0-0';
    const snap = await store.snapshot(s);
    if (site !== s) return;
    const frame: ServerFrame = {
      type: 'snapshot',
      site: s,
      seq,
      time: now(),
      positions: snap.positions,
      offline: snap.offline,
    };
    if (snap.source !== undefined) frame.source = snap.source;
    if (snap.alarms.length > 0) frame.alarms = snap.alarms;
    send(frame);
    cursor = seq;
    stats.snapshots++;
  };

  /** 读快照或补发期间排队，完成后把比 cursor 新的帧补上 */
  const sync = (work: () => Promise<void>) => {
    queue = [];
    const run = (async () => {
      try {
        await work();
      } finally {
        syncing = null;
        const queued = queue;
        queue = [];
        for (const f of queued) deliver(f);
      }
    })();
    syncing = run;
    return run;
  };

  const deliver = (frame: SeqFrame) => {
    if (frame.site !== site) return;
    if (syncing) {
      queue.push(frame);
      return;
    }
    if (compareSeq(frame.seq, cursor) <= 0) return;
    if (frame.type === 'positions') {
      // 位置只要最新的：慢客户端跳过，缓冲降下来后用快照追上
      if (owed || socket.bufferedAmount() > limits.high) {
        cursor = frame.seq;
        stats.skipped++;
        if (!owed) owed = true;
        else if (socket.bufferedAmount() < limits.low) {
          owed = false;
          const s = frame.site;
          void sync(() => sendSnapshot(s));
        }
        return;
      }
    }
    send(frame);
    cursor = frame.seq;
  };

  send({ type: 'hello', protocol: PROTOCOL_VERSION, serverTime: now() });

  return {
    async receive(text: string) {
      const r = parseClientFrame(text);
      if (!r.ok) {
        stats.invalid++;
        return;
      }
      const msg = r.value;
      if (msg.type === 'pong') {
        rttMs = now() - msg.t;
        missedPongs = 0;
        return;
      }
      site = msg.site;
      const s = msg.site;
      const after = msg.after;
      await sync(async () => {
        if (after) {
          const frames = await store.range(s, after);
          if (frames !== 'gone') {
            cursor = after;
            for (const f of frames) {
              send({ ...f, replay: true });
              cursor = f.seq;
            }
            stats.replayed += frames.length;
            send({ type: 'synced', site: s, seq: cursor, replayed: frames.length });
            return;
          }
        }
        await sendSnapshot(s);
      });
    },
    deliver,
    ping() {
      if (missedPongs >= MAX_MISSED_PONGS) {
        socket.close(4000, 'heartbeat timeout');
        return;
      }
      missedPongs++;
      const frame: ServerFrame = { type: 'ping', t: now() };
      if (rttMs !== undefined) frame.rttMs = rttMs;
      send(frame);
    },
    shutdown() {
      send({ type: 'bye', reason: 'restart' });
      socket.close(1001, 'restart');
    },
    site: () => site,
    /** 等正在进行的快照或补发结束（测试和关闭时用） */
    idle: () => syncing ?? Promise.resolve(),
    stats: () => ({ ...stats, rttMs }),
  };
}

export type Session = ReturnType<typeof createSession>;
