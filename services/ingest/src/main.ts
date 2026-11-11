/**
 * ingest：订阅设备的 MQTT 上报，校验、去重、合帧后写进 Redis（现在）和 MongoDB（历史），
 * 并用医院的业务规则算告警。设备数据只有它写（docs/backend/R2、R3、R4）。
 */
import {
  type AlarmRecord,
  FRAME_FIELD,
  FRAMES_MAXLEN,
  HOSPITAL_ASSETS,
  HOSPITAL_TAGS,
  MONGO_DB,
  mongoCollections,
  parseEventReport,
  parsePositionReport,
  parseTopic,
  redisKeys,
  SITES,
  SOURCE_ONLINE,
  TELEMETRY_TTL_DAYS,
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
import { MongoClient, MongoServerError } from 'mongodb';
import mqtt from 'mqtt';
import { z } from 'zod';
import { handleEvent } from './events';
import { createHospitalAlarms, HOSPITAL_VENUE } from './hospital';
import { createIngestState, type Flush } from './state';

const log = createLogger('ingest');
const config = loadConfig(
  z.object({
    MQTT_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    MONGO_URL: z.string().min(1),
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

const mongo = new MongoClient(config.MONGO_URL);
await mongo.connect();
const db = mongo.db(MONGO_DB);
await ensureCollections();
const telemetry = db.collection(mongoCollections.telemetry);
const alarmsCollection = db.collection<AlarmRecord & { site: string }>(mongoCollections.alarms);
const events = db.collection(mongoCollections.events);

/** 第一次启动时建集合和索引；已存在时什么都不改 */
async function ensureCollections() {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  if (!existing.has(mongoCollections.telemetry)) {
    await db.createCollection(mongoCollections.telemetry, {
      timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
      expireAfterSeconds: TELEMETRY_TTL_DAYS * 86_400,
    });
  }
  await db.collection(mongoCollections.telemetry).createIndex({ 'meta.site': 1, 'meta.deviceId': 1, ts: 1 });
  await db.collection(mongoCollections.alarms).createIndex({ site: 1, id: 1 }, { unique: true });
  await db.collection(mongoCollections.alarms).createIndex({ site: 1, time: -1 });
  await db.collection(mongoCollections.events).createIndex({ site: 1, id: 1 }, { unique: true });
}

// 告警 id 带上这次启动的时间，重启后不和库里的重复
const hospitalAlarms = createHospitalAlarms(HOSPITAL_VENUE, {
  people: HOSPITAL_TAGS,
  assets: HOSPITAL_ASSETS,
  idPrefix: Date.now().toString(36),
});

const eventStore = {
  claim: async (site: string, id: string) =>
    (await redis.set(redisKeys.event(site as never, id), '1', 'EX', 86_400, 'NX')) === 'OK',
  save: async (doc: object) => {
    try {
      await events.insertOne({ ...doc });
    } catch (err) {
      // Redis 过期后同一事件再来，库里的唯一索引兜底
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
    }
  },
};

const client = mqtt.connect(config.MQTT_URL, {
  clientId: `ingest-${process.pid}-${Date.now()}`,
  reconnectPeriod: 1000,
});
client.on('connect', () => {
  log('mqtt connected');
  // 位置用共享订阅，多副本时由 broker 分流；设备端状态是保留消息，共享订阅收不到，单独订阅
  client.subscribe([`$share/ingest/${topicFilter('pos')}`, topicFilter('source')], { qos: 0 });
  // 事件至少送达一次，重复的按 id 去掉
  client.subscribe(`$share/ingest/${topicFilter('event')}`, { qos: 1 });
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
  if (kind === 'event') {
    const e = parseEventReport(payload);
    if (!e.ok) {
      metrics.inc('invalid_total');
      return;
    }
    handleEvent(eventStore, site, deviceId, e.value).then(
      (r) => metrics.inc(r === 'new' ? 'events_total' : 'events_duplicate_total'),
      (err: unknown) => log('event write failed', { error: String(err) }),
    );
    return;
  }
  const r = parsePositionReport(payload);
  if (!r.ok) {
    metrics.inc('invalid_total');
    return;
  }
  if (state.accept(site, deviceId, r.value, Date.now()) === 'stale') metrics.inc('stale_total');
});

/** 医院的位置交给告警引擎，新告警作为帧跟在位置后面（R4-05） */
function addAlarms(flushes: Flush[]): AlarmRecord[] {
  const raised: AlarmRecord[] = [];
  for (const f of flushes) {
    if (f.site !== 'hospital') continue;
    const positions = f.frames.find((x) => x.type === 'positions');
    if (positions?.type !== 'positions') continue;
    for (const alarm of hospitalAlarms.check({ time: positions.time, positions: positions.positions })) {
      f.frames.push({ type: 'alarm', site: f.site, time: positions.time, alarm });
      raised.push(alarm);
    }
  }
  return raised;
}

async function writeHistory(flushes: Flush[], raised: AlarmRecord[]) {
  const docs = flushes.flatMap((f) => {
    const positions = f.frames.find((x) => x.type === 'positions');
    if (positions?.type !== 'positions') return [];
    const ts = new Date(positions.time);
    return positions.positions.map((p) => ({
      ts,
      meta: { site: f.site, deviceId: p.id },
      levelId: p.levelId,
      coord: p.coord,
      ...(p.status ? { status: p.status } : {}),
    }));
  });
  if (docs.length > 0) await telemetry.insertMany(docs, { ordered: false });
  if (raised.length > 0) await alarmsCollection.insertMany(raised.map((a) => ({ ...a, site: 'hospital' })));
  metrics.inc('telemetry_total', docs.length);
  metrics.inc('alarms_total', raised.length);
}

async function write(flushes: Flush[]) {
  if (flushes.length === 0) return;
  const raised = addAlarms(flushes);
  const p = redis.multi();
  for (const a of raised) p.hset(redisKeys.openAlarms('hospital'), a.id, JSON.stringify(a));
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
  // 历史晚一点写也没关系，不挡住实时帧
  writeHistory(flushes, raised).catch((err: unknown) => {
    metrics.inc('history_errors_total');
    log('history write failed', { error: String(err) });
  });
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
    const mongoOk = await db
      .command({ ping: 1 }, { timeoutMS: 1000 })
      .then(() => true)
      .catch(() => false);
    return {
      ok: client.connected && redisOk && mongoOk,
      mqtt: client.connected,
      redis: redisOk,
      mongo: mongoOk,
    };
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
  await mongo.close();
}, log);
