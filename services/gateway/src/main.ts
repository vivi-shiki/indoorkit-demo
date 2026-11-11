/**
 * gateway：浏览器的唯一入口。/ws 推实时帧（快照、增量、补发、心跳、背压），只读 Redis（docs/backend/R2、R3）。
 */
import { SITES, type Site } from '@indoorkit/protocol';
import {
  createLogger,
  createMetrics,
  envNumber,
  loadConfig,
  onShutdown,
  startHttp,
} from '@indoorkit/service-kit';
import { Redis } from 'ioredis';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { createRedisStore, createTail } from './redis-store';
import { createSession, type Session } from './session';

const log = createLogger('gateway');
const config = loadConfig(
  z.object({
    REDIS_URL: z.string().min(1),
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
    const ok = redis.status === 'ready';
    return { ok, redis: ok, connections: sessions.size };
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

log('started', { port: http.port, origins: allowed ?? 'any' });

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
}, log);
