import type { ServerFrame, Site, StreamFrame, TagState } from '@indoorkit/protocol';
import type { SocketLike } from '../src/session';
import type { FrameStore, SeqFrame } from '../src/store';

/** 内存里的 Stream：只保留最近 keep 条，模拟 MAXLEN 裁剪 */
export function fakeStore(keep = 300) {
  let n = 0;
  const frames: SeqFrame[] = [];
  const state = new Map<string, TagState>();
  const offline = new Set<string>();
  const store: FrameStore & { push(f: StreamFrame): SeqFrame; state: typeof state; offline: typeof offline } =
    {
      state,
      offline,
      push(f) {
        n++;
        const frame = { ...f, seq: `${n}-0` } as SeqFrame;
        frames.push(frame);
        if (frames.length > keep) frames.shift();
        if (frame.type === 'positions') for (const p of frame.positions) state.set(p.id, p);
        return frame;
      },
      async lastSeq() {
        return frames.at(-1)?.seq ?? null;
      },
      async snapshot(_site: Site) {
        return { positions: [...state.values()], offline: [...offline], source: undefined };
      },
      async range(_site: Site, after: string) {
        const i = frames.findIndex((f) => f.seq === after);
        if (i < 0) return 'gone';
        return frames.slice(i + 1);
      },
    };
  return store;
}

export function fakeSocket() {
  const sent: ServerFrame[] = [];
  let buffered = 0;
  const socket: SocketLike & {
    sent: ServerFrame[];
    closed: { code: number; reason: string } | null;
    setBuffered(n: number): void;
  } = {
    sent,
    closed: null,
    send(text) {
      sent.push(JSON.parse(text));
    },
    bufferedAmount: () => buffered,
    close(code, reason) {
      socket.closed = { code, reason };
    },
    setBuffered(n) {
      buffered = n;
    },
  };
  return socket;
}

export const tag = (id: string, x = 0): TagState => ({ id, levelId: 'L1', coord: [x, 0] });
