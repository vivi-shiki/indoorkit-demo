/**
 * gateway：浏览器的唯一入口。/ws 推实时帧（快照、增量、补发、心跳、背压），/api 查历史和告警（docs/backend/R2、R3、R4）。
 * 设备数据只读；唯一的写是用户对告警的确认和解决（R4-10）。
 */
import {
  type AlarmRecord,
  FRAME_FIELD,
  FRAMES_MAXLEN,
  MONGO_DB,
  mongoCollections,
  redisKeys,
  SITES,
  type Site,
  type StreamFrame,
} from '@indoorkit/protocol';
import {
  createLogger,
  createMetrics,
  envNumber,
  loadConfig,
  onShutdown,
  startHttp,
} from '@indoorkit/service-kit';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { HISTORY_MAX_POINTS } from './api';
import { createRedisStore, createTail, latestAlarms } from './redis-store';
import { type ApiBackend, type HistoryPoint, handleApi } from './rest';
import { createSession, type Session } from './session';

const log = createLogger('gateway');
const config = loadConfig(
  z.object({
    REDIS_URL: z.string().min(1),
    MONGO_URL: z.string().min(1),
    /** session：公开部署时不改共享的告警状态（R4-10） */
    ALARM_WRITES: z.enum(['shared', 'session']).default('shared'),
    PORT: envNumber(8080),
    PING_MS: envNumber(15_000),
    /** 允许的页面来源，逗号分隔；不设表示不限制（只在本地用） */
    ALLOWED_ORIGINS: z.string().optional(),
    BACKPRESSURE_HIGH: envNumber(1024 * 1024),
    BACKPRESSURE_LOW: envNumber(256 * 1024),
  }),
  process.env,
);
const allowed = config.ALLOWED_ORIGINS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const metrics = createMetrics('ik_gateway');
const newRedis = () =>
  new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 }).on('error', (err) =>
    log('redis error', { error: err.message }),
  );
const redis = newRedis();
const store = createRedisStore(redis);
const mongo = new MongoClient(config.MONGO_URL);
await mongo.connect();
const db = mongo.db(MONGO_DB);
const telemetry = db.collection<
  { ts: Date; meta: { site: string; deviceId: string } } & Omit<HistoryPoint, 'ts'>
>(mongoCollections.telemetry);
const alarmsCollection = db.collection<AlarmRecord & { site: string }>(mongoCollections.alarms);

const backend: ApiBackend = {
  async history(site, deviceId, from, to) {
    const docs = await telemetry
      .find(
        { 'meta.site': site, 'meta.deviceId': deviceId, ts: { $gte: new Date(from), $lte: new Date(to) } },
        { projection: { _id: 0, ts: 1, levelId: 1, coord: 1, status: 1 } },
      )
      .sort({ ts: 1 })
      .limit(HISTORY_MAX_POINTS)
      .toArray();
    return docs.map((d) => ({ ...d, ts: d.ts.getTime() }));
  },
  async alarms(site, state, limit) {
    if (state === 'open') return latestAlarms(await redis.hvals(redisKeys.openAlarms(site)), limit).reverse();
    return alarmsCollection
      .find({ site }, { projection: { _id: 0, site: 0 } })
      .sort({ time: -1 })
      .limit(limit)
      .toArray();
  },
  async setAlarmState(site, id, state) {
    const cached = await redis.hget(redisKeys.openAlarms(site), id);
    const stored = cached
      ? null
      : await alarmsCollection.findOne({ site, id }, { projection: { _id: 0, site: 0 } });
    const before = cached ? (JSON.parse(cached) as AlarmRecord) : stored;
    if (!before) return null;
    const alarm = { ...before, state };
    // ingest 晚一点才写历史，刚产生的告警库里可能还没有：没匹配上不算错
    await alarmsCollection.updateOne({ site, id }, { $set: { state } });
    const frame: StreamFrame = { type: 'alarm-state', site, time: Date.now(), id, state };
    const p = redis.multi();
    if (state === 'resolved') p.hdel(redisKeys.openAlarms(site), id);
    else p.hset(redisKeys.openAlarms(site), id, JSON.stringify(alarm));
    p.xadd(redisKeys.frames(site), 'MAXLEN', '~', FRAMES_MAXLEN, '*', FRAME_FIELD, JSON.stringify(frame));
    await p.exec();
    metrics.inc('alarm_state_total');
    return alarm;
  },
};

const sessions = new Set<Session>();
const closedTotals = { sent: 0, replayed: 0, snapshots: 0, skipped: 0, invalid: 0 };
const tails = new Map<Site, ReturnType<typeof createTail>>();
for (const site of SITES) {
  tails.set(
    site,
    createTail(
      newRedis,
      site,
      (frames) => {
        for (const s of sessions) for (const f of frames) s.deliver(f);
      },
      (err) => log('stream read failed', { site, error: String(err) }),
    ),
  );
}

const http = await startHttp({
  port: config.PORT,
  metrics,
  health: async () => {
    const redisOk = redis.status === 'ready';
    const mongoOk = await db
      .command({ ping: 1 }, { timeoutMS: 1000 })
      .then(() => true)
      .catch(() => false);
    return { ok: redisOk && mongoOk, redis: redisOk, mongo: mongoOk, connections: sessions.size };
  },
  handle(req, res) {
    if (!req.url?.startsWith('/api/')) return false;
    metrics.inc('api_requests_total');
    handleApi(
      { method: req.method ?? 'GET', url: req.url, origin: req.headers.origin },
      {
        backend,
        allowed,
        writes: config.ALARM_WRITES,
        onError: (err) => log('api failed', { url: req.url, error: String(err) }),
      },
    ).then((r) => {
      if (!r) return void res.writeHead(404).end();
      res.writeHead(r.status, r.headers).end(r.body === undefined ? undefined : JSON.stringify(r.body));
    });
    return true;
  },
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
let closing = false;
http.server.on('upgrade', (req, socket, head) => {
  // 正在关闭：拒绝新连接，客户端马上去连别的副本
  if (closing) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  const path = (req.url ?? '').split('?')[0];
  const origin = req.headers.origin;
  if (path !== '/ws' || (allowed && (!origin || !allowed.includes(origin)))) {
    metrics.inc('rejected_total');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = createSession({
      socket: {
        send: (text) => ws.send(text),
        bufferedAmount: () => ws.bufferedAmount,
        close: (code, reason) => ws.close(code, reason),
      },
      store,
      now: Date.now,
      limits: { high: config.BACKPRESSURE_HIGH, low: config.BACKPRESSURE_LOW },
    });
    sessions.add(session);
    metrics.inc('connections_total');
    ws.on('message', (data) => {
      session
        .receive(data.toString())
        .catch((err: unknown) => log('subscribe failed', { error: String(err) }));
    });
    ws.on('close', () => {
      sessions.delete(session);
      const s = session.stats();
      for (const k of Object.keys(closedTotals) as (keyof typeof closedTotals)[]) closedTotals[k] += s[k];
    });
    ws.on('error', (err) => log('socket error', { error: err.message }));
  });
});

const pinger = setInterval(() => {
  for (const s of sessions) s.ping();
}, config.PING_MS);

// 指标：已关闭连接的累计加上当前连接
const gauges = setInterval(() => {
  metrics.set('connections', sessions.size);
  const live = [...sessions].map((s) => s.stats());
  for (const k of Object.keys(closedTotals) as (keyof typeof closedTotals)[]) {
    metrics.set(`frames_${k}_total`, closedTotals[k] + live.reduce((n, s) => n + s[k], 0));
  }
}, 1000);

log('started', { port: http.port, origins: allowed ?? 'any', alarmWrites: config.ALARM_WRITES });

onShutdown(async () => {
  closing = true;
  clearInterval(pinger);
  clearInterval(gauges);
  // 先告诉客户端马上重连到别的副本，再关
  for (const s of sessions) s.shutdown();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await http.close();
  await Promise.all([...tails.values()].map((t) => t.stop()));
  await redis.quit();
  await mongo.close();
}, log);
