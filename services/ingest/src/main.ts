/**
 * ingest：订阅设备的 MQTT 上报，校验、去重、合帧后写进 Redis（现在）和 MongoDB（历史），
 * 并用医院的业务规则算告警。设备数据只有它写（docs/backend/R2、R3、R4）。
 */
import {
  type AlarmRecord,
  dayStartOf,
  FRAME_FIELD,
  FRAMES_MAXLEN,
  HOSPITAL_ASSETS,
  HOSPITAL_TAGS,
  MONGO_DB,
  mongoCollections,
  parseBookingReport,
  parseDeviceReport,
  parseEventReport,
  parseParkingEvent,
  parsePositionReport,
  parseTopic,
  redisKeys,
  SITE_TIME_ZONE,
  SITES,
  type Site,
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
import { createHospitalAlarms, HOSPITAL_VENUE } from './hospital/alarms';
import { createParkingSite, type ParkingDayState } from './parking/site';
import { PARKING } from './parking/venue';
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
    /** 固定的客户端 id 加持久会话：ingest 重启期间的 QoS 1 消息（停车事件）由 broker 暂存 */
    MQTT_CLIENT_ID: z.string().min(1).default('ingest'),
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
const idPrefix = Date.now().toString(36);
const hospitalAlarms = createHospitalAlarms(HOSPITAL_VENUE, {
  people: HOSPITAL_TAGS,
  assets: HOSPITAL_ASSETS,
  idPrefix,
});

const DAY = 86_400_000;
/** 昨天 0 点以来的停车事件，和 Redis 的 ik:parking:day-events 一致；Redis 丢了数据时由它补回 */
let dayEvents = await redis.lrange(redisKeys.dayEvents('parking'), 0, -1);
// Redis 是空的（和 ingest 一起重启过）：从 MongoDB 读回，之后补进 Redis
const fromMongo = dayEvents.length === 0;
if (fromMongo) {
  const since = dayStartOf(Date.now(), SITE_TIME_ZONE) - 86_400_000;
  const docs = await events
    .find({ site: 'parking', ts: { $gte: since } }, { projection: { _id: 0, site: 0 } })
    .sort({ ts: 1 })
    .toArray();
  dayEvents = docs.map((d) => JSON.stringify(d));
}
const savedDay = await redis.get(redisKeys.day('parking'));

/**
 * 停车场以当天 0 点为基准。启动和过了 0 点时由设备、预约和昨天以来的事件重建，
 * 悄悄重放一遍，已经报过的告警不再报（R5-07）
 */
function buildParking(events: readonly string[], day: ParkingDayState | null) {
  const site = createParkingSite(PARKING, {
    origin: dayStartOf(Date.now(), SITE_TIME_ZONE),
    timeZone: SITE_TIME_ZONE,
    idPrefix,
  });
  if (day) site.restore(day);
  for (const text of events) {
    const r = parseParkingEvent(text);
    if (r.ok) site.event(r.value, { silent: true });
  }
  site.advance(Date.now(), { silent: true });
  site.drain();
  return site;
}
let parking = buildParking(dayEvents, savedDay ? (JSON.parse(savedDay) as ParkingDayState) : null);
let parkingOrigin = dayStartOf(Date.now(), SITE_TIME_ZONE);
/** 还没写进 Redis 的新停车事件（重复的由台账挡掉） */
const parkingEvents: string[] = [];

/** Redis 重启后数据是空的（不落盘）：重连时把停车场的当天状态和未处理告警补回去 */
let redisSeen = redis.status === 'ready';
let resync = fromMongo && dayEvents.length > 0;
redis.on('ready', () => {
  if (redisSeen) resync = true;
  redisSeen = true;
});
async function resyncRedis() {
  // 每个场景最新的一批未处理告警
  const open = (
    await Promise.all(
      SITES.map((site) =>
        alarmsCollection
          .find({ site, state: { $ne: 'resolved' } }, { projection: { _id: 0 } })
          .sort({ time: -1 })
          .limit(1000)
          .toArray(),
      ),
    )
  ).flat();
  const p = redis.multi();
  p.del(redisKeys.dayEvents('parking'));
  if (dayEvents.length > 0) p.rpush(redisKeys.dayEvents('parking'), ...dayEvents);
  p.set(redisKeys.day('parking'), JSON.stringify(parking.day()));
  for (const { site, ...a } of open) p.hset(redisKeys.openAlarms(site as Site), a.id, JSON.stringify(a));
  await p.exec();
  log('redis state restored', { events: dayEvents.length, alarms: open.length });
}

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
  clientId: config.MQTT_CLIENT_ID,
  clean: false,
  reconnectPeriod: 1000,
});
client.on('connect', () => {
  log('mqtt connected');
  // 位置用共享订阅，多副本时由 broker 分流；设备端状态是保留消息，共享订阅收不到，单独订阅
  client.subscribe([`$share/ingest/${topicFilter('pos')}`, topicFilter('source')], { qos: 0 });
  // 事件至少送达一次，重复的按 id 去掉
  client.subscribe(`$share/ingest/${topicFilter('event')}`, { qos: 1 });
  // 设备状态和预约是保留消息，同样单独订阅（R5-01）
  client.subscribe([topicFilter('dev', 'parking'), topicFilter('booking', 'parking')], { qos: 1 });
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
  if (site === 'parking' && kind !== 'pos') {
    handleParking(kind, deviceId, payload);
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

function handleParking(kind: string, deviceId: string, payload: Buffer) {
  if (kind === 'event') {
    const r = parseParkingEvent(payload);
    if (!r.ok) return void metrics.inc('invalid_total');
    if (parking.event(r.value)) {
      metrics.inc('events_total');
      const text = JSON.stringify(r.value);
      parkingEvents.push(text);
      dayEvents.push(text);
      eventStore
        .save({ ...r.value, site: 'parking' })
        .catch((err: unknown) => log('event write failed', { error: String(err) }));
    } else metrics.inc('events_duplicate_total');
  } else if (kind === 'dev') {
    const r = parseDeviceReport(payload);
    if (!r.ok) return void metrics.inc('invalid_total');
    parking.device(deviceId, r.value);
  } else if (kind === 'booking') {
    const r = parseBookingReport(payload);
    if (!r.ok) return void metrics.inc('invalid_total');
    parking.booking(r.value);
  }
}

/** 停车场：检查到现在（留 2 秒给还在路上的消息），取走帧、告警和当天状态 */
function drainParking(flushes: Flush[], now: number) {
  parking.advance(now - 2000);
  const { frames, alarms, day } = parking.drain();
  if (frames.length > 0) {
    let f = flushes.find((x) => x.site === 'parking');
    if (!f) {
      f = { site: 'parking', frames: [], state: {}, offlineAdd: [], offlineRemove: [], removed: [] };
      flushes.push(f);
    }
    // 场景事件和告警排在这一轮的位置之前，时间顺序更接近
    f.frames.unshift(...frames);
  }
  return { alarms: alarms.map((a) => ({ ...a, site: 'parking' as Site })), day };
}

/** 医院的位置交给告警引擎，新告警作为帧跟在位置后面（R4-05） */
function addAlarms(flushes: Flush[]): (AlarmRecord & { site: Site })[] {
  const raised: (AlarmRecord & { site: Site })[] = [];
  for (const f of flushes) {
    if (f.site !== 'hospital') continue;
    const positions = f.frames.find((x) => x.type === 'positions');
    if (positions?.type !== 'positions') continue;
    for (const alarm of hospitalAlarms.check({ time: positions.time, positions: positions.positions })) {
      f.frames.push({ type: 'alarm', site: f.site, time: positions.time, alarm });
      raised.push({ ...alarm, site: f.site });
    }
  }
  return raised;
}

async function writeHistory(flushes: Flush[], raised: (AlarmRecord & { site: Site })[]) {
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
  if (raised.length > 0) await alarmsCollection.insertMany(raised.map((a) => ({ ...a })));
  metrics.inc('telemetry_total', docs.length);
  metrics.inc('alarms_total', raised.length);
}

/** 过了 0 点：以新的一天为基准重建停车场，只留昨天 0 点以后的事件 */
function rollover(now: number) {
  const origin = dayStartOf(now, SITE_TIME_ZONE);
  if (origin === parkingOrigin) return;
  dayEvents = dayEvents.filter((text) => (JSON.parse(text) as { ts: number }).ts >= origin - DAY);
  parking = buildParking(dayEvents, parking.day());
  parkingOrigin = origin;
  log('parking day rolled over', { origin });
}

async function write(flushes: Flush[], now: number) {
  const fromParking = drainParking(flushes, now);
  const events = parkingEvents.splice(0);
  rollover(now);
  // 补回时整份列表已经包含这一轮的事件
  const full = resync;
  if (full) {
    resync = false;
    await resyncRedis().catch((err: unknown) => {
      resync = true;
      throw err;
    });
  }
  if (flushes.length === 0 && events.length === 0 && !fromParking.day) return;
  const raised = [...addAlarms(flushes), ...fromParking.alarms];
  const p = redis.multi();
  for (const { site, ...a } of raised) p.hset(redisKeys.openAlarms(site), a.id, JSON.stringify(a));
  if (events.length > 0 && !full) p.rpush(redisKeys.dayEvents('parking'), ...events);
  if (fromParking.day) p.set(redisKeys.day('parking'), JSON.stringify(fromParking.day));
  for (const f of flushes) {
    const entries = Object.entries(f.state).map(([id, tag]) => [id, JSON.stringify(tag)] as const);
    if (entries.length > 0) p.hset(redisKeys.state(f.site), Object.fromEntries(entries));
    if (f.removed.length > 0) p.hdel(redisKeys.state(f.site), ...f.removed);
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
  const now = Date.now();
  const flushes = state.flush(now);
  // 上一次还没写完就排在它后面，保证帧的顺序
  writing = writing
    .then(() => write(flushes, now))
    .catch((err: unknown) => {
      metrics.inc('write_errors_total');
      log('redis write failed', { error: String(err) });
    });
}, config.FLUSH_MS);

/** 当天事件列表只留昨天 0 点以后的（R5-07） */
async function trimDayEvents() {
  const cutoff = dayStartOf(Date.now(), SITE_TIME_ZONE) - DAY;
  const key = redisKeys.dayEvents('parking');
  for (;;) {
    const head = await redis.lindex(key, 0);
    if (!head || (JSON.parse(head) as { ts: number }).ts >= cutoff) return;
    await redis.lpop(key);
  }
}
const trimTimer = setInterval(() => {
  trimDayEvents().catch((err: unknown) => log('trim failed', { error: String(err) }));
}, 60_000);

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
  clearInterval(trimTimer);
  // 把最后一轮也写进去
  await writing;
  await write(state.flush(Date.now()), Date.now());
  await redis.quit();
  await mongo.close();
}, log);
