/**
 * device-sim：把浏览器里的模拟器变成一台台「设备」，通过 MQTT 上报。
 * 医院每秒上报位置（docs/backend/R2）；停车场按真实时钟播放同一份计划，启动时补传（R5a）。
 * 每个场景一条 MQTT 连接，各有自己的遗嘱。内部管理接口 POST /faults 可以在运行中注入故障（R3）。
 */
import {
  HOSPITAL_ASSETS,
  HOSPITAL_SEED,
  HOSPITAL_TAGS,
  PARKING_SEED,
  SITE_TIME_ZONE,
  type Site,
  SOURCE_ONLINE,
} from '@indoorkit/protocol';
import {
  createLogger,
  createMetrics,
  envNumber,
  envRate,
  loadConfig,
  onShutdown,
  readJson,
  startHttp,
} from '@indoorkit/service-kit';
import mqtt, { type MqttClient } from 'mqtt';
import { z } from 'zod';
import { createHospitalDevices, HOSPITAL_VENUE, sourceWill } from './devices';
import { createFaults, type Outgoing } from './faults';
import { createParkingDevices, PARKING } from './parking';

const log = createLogger('device-sim');
const config = loadConfig(
  z.object({
    MQTT_URL: z.string().min(1),
    HTTP_PORT: envNumber(8081),
    TAGS: envNumber(HOSPITAL_TAGS),
    ASSETS: envNumber(HOSPITAL_ASSETS),
    SEED: z.string().default(HOSPITAL_SEED),
    /** 模拟哪些场景，逗号分隔 */
    SITES: z.string().default('hospital,parking'),
    INTERVAL_MS: envNumber(1000),
    FAULT_DROP: envRate(),
    FAULT_DUPLICATE: envRate(),
    FAULT_REORDER: envRate(),
    FAULT_SILENT: envRate(),
  }),
  process.env,
);

const metrics = createMetrics('ik_device_sim');
const devices = createHospitalDevices(HOSPITAL_VENUE, {
  seed: config.SEED,
  tags: config.TAGS,
  assets: config.ASSETS,
  now: Date.now,
});
const faults = createFaults({
  seed: config.SEED,
  drop: config.FAULT_DROP,
  duplicate: config.FAULT_DUPLICATE,
  reorder: config.FAULT_REORDER,
  silent: config.FAULT_SILENT,
});
interface SiteRunner {
  site: Site;
  client: MqttClient | undefined;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 连上之后先发的（停车场的补传），只发一次 */
  first?: () => Outgoing[];
  tick: () => Outgoing[];
}

const enabled = new Set(config.SITES.split(',').map((x) => x.trim()));
const runners: SiteRunner[] = [];
if (enabled.has('hospital'))
  runners.push({
    site: 'hospital',
    client: undefined,
    reconnectTimer: undefined,
    tick: () => devices.tick(config.INTERVAL_MS),
  });
if (enabled.has('parking')) {
  const parking = createParkingDevices(PARKING, {
    seed: PARKING_SEED,
    timeZone: SITE_TIME_ZONE,
    now: Date.now,
  });
  runners.push({
    site: 'parking',
    client: undefined,
    reconnectTimer: undefined,
    first: () => parking.backfill(),
    tick: () => parking.tick(),
  });
}

const publish = (c: MqttClient, out: Outgoing[]) => {
  for (const m of out) c.publish(m.topic, m.payload, { qos: m.qos ?? 0, retain: m.retain ?? false });
  metrics.inc('published_total', out.length);
};

function connect(r: SiteRunner) {
  const will = sourceWill(r.site);
  const c = mqtt.connect(config.MQTT_URL, {
    clientId: `device-sim-${r.site}-${process.pid}-${Date.now()}`,
    will: { topic: will.topic, payload: Buffer.from(will.payload), retain: will.retain, qos: will.qos },
    // 断线期间的位置没有意义，不排队
    queueQoSZero: false,
    reconnectPeriod: 1000,
  });
  c.on('connect', () => {
    log('mqtt connected', { site: r.site });
    c.publish(will.topic, SOURCE_ONLINE, { retain: true, qos: 1 });
    // 补传：设备把启动前的数据补上来；之后的断线由 QoS 1 的会话和 tick 继续
    const first = r.first;
    r.first = undefined;
    if (first) publish(c, first());
  });
  c.on('error', (err) => log('mqtt error', { site: r.site, error: err.message }));
  r.client = c;
}

/** 不发 DISCONNECT 直接断开 TCP，让 broker 代发遗嘱；ms 毫秒后重新连接 */
function disconnectFor(ms: number) {
  for (const r of runners) {
    const c = r.client;
    r.client = undefined;
    c?.stream.destroy();
    c?.end(true);
    clearTimeout(r.reconnectTimer);
    r.reconnectTimer = setTimeout(() => connect(r), ms);
  }
  log('disconnected on request', { ms });
}

for (const r of runners) connect(r);

// 模拟一直在走：断线期间时间照样推进，重连后位置是新的
const ticker = setInterval(() => {
  for (const r of runners) {
    // 补传还没发（还没连上）时不发实时的，免得顺序颠倒
    if (r.first) continue;
    const out = faults.apply(r.tick());
    const c = r.client;
    if (!c?.connected) {
      metrics.inc('skipped_total', out.length);
      continue;
    }
    publish(c, out);
  }
}, config.INTERVAL_MS);

const http = await startHttp({
  port: config.HTTP_PORT,
  metrics,
  health: async () => {
    const connected = runners.every((r) => r.client?.connected === true);
    return { ok: connected, mqtt: connected, sites: runners.map((r) => r.site), faults: faults.current() };
  },
  handle(req, res) {
    if (req.url !== '/faults' || req.method !== 'POST') return false;
    readJson(req).then((body) => {
      const { disconnectMs, ...settings } = (body ?? {}) as { disconnectMs?: unknown };
      try {
        faults.update(settings);
        if (disconnectMs !== undefined) {
          const ms = z.number().int().min(0).max(600_000).parse(disconnectMs);
          disconnectFor(ms);
        }
        log('faults updated', { faults: faults.current() });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(faults.current()));
      } catch (err) {
        res.writeHead(400).end(String(err));
      }
    });
    return true;
  },
});
log('started', {
  sites: runners.map((r) => r.site),
  tags: config.TAGS,
  assets: config.ASSETS,
  port: http.port,
});

onShutdown(async () => {
  clearInterval(ticker);
  await http.close();
  // 正常退出：发 offline 再断开，不触发遗嘱也能让 ingest 知道
  for (const r of runners) {
    clearTimeout(r.reconnectTimer);
    const will = sourceWill(r.site);
    const c = r.client;
    if (c?.connected) await c.publishAsync(will.topic, will.payload, { retain: true, qos: 1 });
    await c?.endAsync();
  }
}, log);
