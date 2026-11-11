import {
  compareSeq,
  FRAME_FIELD,
  parseServerFrame,
  redisKeys,
  type Site,
  type TagState,
  tagStateSchema,
} from '@indoorkit/protocol';
import type { Redis } from 'ioredis';
import type { FrameStore, SeqFrame } from './store';

type Entry = [id: string, fields: string[]];

/** Stream 条目转成带序号的帧；ingest 写的内容不对是内部错误，直接抛出 */
export function entryToFrame([id, fields]: Entry): SeqFrame {
  const i = fields.indexOf(FRAME_FIELD);
  const r = parseServerFrame(fields[i + 1]!.replace(/^\{/, `{"seq":"${id}",`));
  if (!r.ok || !('seq' in r.value) || !('time' in r.value))
    throw new Error(`stream entry ${id} is not a frame: ${r.ok ? 'no seq' : r.error}`);
  return r.value;
}

export function createRedisStore(redis: Redis): FrameStore {
  return {
    async lastSeq(site) {
      const last = (await redis.xrevrange(redisKeys.frames(site), '+', '-', 'COUNT', 1)) as Entry[];
      return last[0]?.[0] ?? null;
    },
    async snapshot(site) {
      const [state, offline, source] = await Promise.all([
        redis.hgetall(redisKeys.state(site)),
        redis.smembers(redisKeys.offline(site)),
        redis.get(redisKeys.source(site)),
      ]);
      const positions: TagState[] = Object.values(state).map((v) => tagStateSchema.parse(JSON.parse(v)));
      return { positions, offline, source: source === null ? undefined : source === 'online' };
    },
    async range(site: Site, after: string) {
      const first = (await redis.xrange(redisKeys.frames(site), '-', '+', 'COUNT', 1)) as Entry[];
      // 客户端最后收到的帧比 Stream 里最早的还旧：中间有帧已被裁掉
      if (!first[0] || compareSeq(after, first[0][0]) < 0) return 'gone';
      const entries = (await redis.xrange(redisKeys.frames(site), `(${after}`, '+')) as Entry[];
      return entries.map(entryToFrame);
    },
  };
}

/**
 * 每个场景一个读循环，用一条独占的 Redis 连接阻塞读取新帧，再分发给订阅了这个场景的连接。
 */
export function createTail(
  redisFor: () => Redis,
  site: Site,
  onFrames: (frames: SeqFrame[]) => void,
  onError: (err: unknown) => void,
) {
  const redis = redisFor();
  let running = true;
  let lastId = '$';
  const loop = async () => {
    while (running) {
      try {
        const res = (await redis.xread(
          'COUNT',
          500,
          'BLOCK',
          5000,
          'STREAMS',
          redisKeys.frames(site),
          lastId,
        )) as [string, Entry[]][] | null;
        if (!res) continue;
        const entries = res[0]![1];
        if (entries.length === 0) continue;
        lastId = entries.at(-1)![0];
        onFrames(entries.map(entryToFrame));
      } catch (err) {
        if (!running) return;
        onError(err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  const done = loop();
  return {
    async stop() {
      running = false;
      redis.disconnect();
      await done;
    },
  };
}
