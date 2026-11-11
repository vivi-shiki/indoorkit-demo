/**
 * ingest：订阅设备的 MQTT 上报，校验、去重、合帧后写进 Redis。
 * 是唯一的写入方；gateway 只读（docs/backend/R2、R3）。
 */
import {
  FRAME_FIELD,
  FRAMES_MAXLEN,
  parsePositionReport,
  parseTopic,
  redisKeys,
  SITES,
  SOURCE_ONLINE,
  topicFilter,
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
import mqtt from 'mqtt';
import { z } from 'zod';
import { createIngestState, type Flush } from './state';

const log = createLogger('ingest');
const config = loadConfig(
  z.object({
    MQTT_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    HTTP_PORT: envNumber(8082),
    FLUSH_MS: envNumber(1000),
    OFFLINE_AFTER_MS: envNumber(10_000),
  }),
  process.env,
);

const metrics = createMetrics('ik_ingest');
const state = createIngestState({ offlineAfterMs: config.OFFLINE_AFTER_MS });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on('error', (err) => log('redis error', { error: err.message }));

for (const site of SITES)
  state.restoreOffline(site, await redis.smembers(redisKeys.offline(site)).catch(() => []));

const client = mqtt.connect(config.MQTT_URL, {
  clientId: `ingest-${process.pid}-${Date.now()}`,
  reconnectPeriod: 1000,
});
client.on('connect', () => {
  log('mqtt connected');
  // 位置用共享订阅，多副本时由 broker 分流；设备端状态是保留消息，共享订阅收不到，单独订阅
  client.subscribe([`$share/ingest/${topicFilter('pos')}`, topicFilter('source')], { qos: 0 });
});
client.on('error', (err) => log('mqtt error', { error: err.message }));
client.on('message', (topicText, payload) => {
  metrics.inc('messages_total');
  const t = parseTopic(topicText);
  if (!t.ok) {
    metrics.inc('invalid_total');
    return;
  }
  const { site, kind, deviceId } = t.value;
  if (kind === 'source') {
    state.source(site, payload.toString() === SOURCE_ONLINE);
    return;
  }
  const r = parsePositionReport(payload);
  if (!r.ok) {
    metrics.inc('invalid_total');
    return;
  }
  if (state.accept(site, deviceId, r.value, Date.now()) === 'stale') metrics.inc('stale_total');
});

async function write(flushes: Flush[]) {
  if (flushes.length === 0) return;
  const p = redis.multi();
  for (const f of flushes) {
    const entries = Object.entries(f.state).map(([id, tag]) => [id, JSON.stringify(tag)] as const);
    if (entries.length > 0) p.hset(redisKeys.state(f.site), Object.fromEntries(entries));
    if (f.offlineAdd.length > 0) p.sadd(redisKeys.offline(f.site), ...f.offlineAdd);
    if (f.offlineRemove.length > 0) p.srem(redisKeys.offline(f.site), ...f.offlineRemove);
    if (f.source !== undefined) p.set(redisKeys.source(f.site), f.source ? 'online' : 'offline');
    for (const frame of f.frames) {
      p.xadd(redisKeys.frames(f.site), 'MAXLEN', '~', FRAMES_MAXLEN, '*', FRAME_FIELD, JSON.stringify(frame));
    }
    metrics.inc('frames_total', f.frames.length);
  }
  await p.exec();
}

let writing = Promise.resolve();
const flushTimer = setInterval(() => {
  const flushes = state.flush(Date.now());
  // 上一次还没写完就排在它后面，保证帧的顺序
  writing = writing
    .then(() => write(flushes))
    .catch((err: unknown) => {
      metrics.inc('write_errors_total');
      log('redis write failed', { error: String(err) });
    });
}, config.FLUSH_MS);

const http = await startHttp({
  port: config.HTTP_PORT,
  metrics,
  health: async () => {
    const redisOk = redis.status === 'ready';
    return { ok: client.connected && redisOk, mqtt: client.connected, redis: redisOk };
  },
});
log('started', { port: http.port });

onShutdown(async () => {
  await http.close();
  await client.endAsync();
  clearInterval(flushTimer);
  // 把最后一轮也写进去
  await writing;
  await write(state.flush(Date.now()));
  await redis.quit();
}, log);
