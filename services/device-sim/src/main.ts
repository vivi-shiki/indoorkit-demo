/**
 * device-sim：把浏览器里的医院定位模拟器变成一台台「设备」，每秒通过 MQTT 上报位置。
 * 内部管理接口 POST /faults 可以在运行中注入故障（docs/backend/R3）。
 */
import { HOSPITAL_ASSETS, HOSPITAL_SEED, HOSPITAL_TAGS, SOURCE_ONLINE } from '@indoorkit/protocol';
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
import { createFaults } from './faults';

const log = createLogger('device-sim');
const config = loadConfig(
  z.object({
    MQTT_URL: z.string().min(1),
    HTTP_PORT: envNumber(8081),
    TAGS: envNumber(HOSPITAL_TAGS),
    ASSETS: envNumber(HOSPITAL_ASSETS),
    SEED: z.string().default(HOSPITAL_SEED),
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
const will = sourceWill('hospital');

let client: MqttClient | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function connect() {
  const c = mqtt.connect(config.MQTT_URL, {
    clientId: `device-sim-${process.pid}-${Date.now()}`,
    will: { topic: will.topic, payload: Buffer.from(will.payload), retain: will.retain, qos: will.qos },
    // 断线期间的位置没有意义，不排队
    queueQoSZero: false,
    reconnectPeriod: 1000,
  });
  c.on('connect', () => {
    log('mqtt connected');
    c.publish(will.topic, SOURCE_ONLINE, { retain: true, qos: 1 });
  });
  c.on('error', (err) => log('mqtt error', { error: err.message }));
  client = c;
}

/** 不发 DISCONNECT 直接断开 TCP，让 broker 代发遗嘱；ms 毫秒后重新连接 */
function disconnectFor(ms: number) {
  const c = client;
  client = undefined;
  c?.stream.destroy();
  c?.end(true);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, ms);
  log('disconnected on request', { ms });
}

connect();

// 模拟一直在走：断线期间时间照样推进，重连后位置是新的
const ticker = setInterval(() => {
  const out = faults.apply(devices.tick(config.INTERVAL_MS));
  const c = client;
  if (!c?.connected) {
    metrics.inc('skipped_total', out.length);
    return;
  }
  for (const m of out) c.publish(m.topic, m.payload, { qos: m.qos ?? 0 });
  metrics.inc('published_total', out.length);
}, config.INTERVAL_MS);

const http = await startHttp({
  port: config.HTTP_PORT,
  metrics,
  health: async () => ({
    ok: client?.connected === true,
    mqtt: client?.connected === true,
    faults: faults.current(),
  }),
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
log('started', { tags: config.TAGS, assets: config.ASSETS, port: http.port });

onShutdown(async () => {
  clearInterval(ticker);
  clearTimeout(reconnectTimer);
  await http.close();
  // 正常退出：发 offline 再断开，不触发遗嘱也能让 ingest 知道
  const c = client;
  if (c?.connected) await c.publishAsync(will.topic, will.payload, { retain: true, qos: 1 });
  await c?.endAsync();
}, log);
