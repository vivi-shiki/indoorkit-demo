/**
 * 实时数据后端的消息契约：MQTT 主题、设备上报、Redis 键名和 WebSocket 帧。
 * device-sim、ingest、gateway 和浏览器的 live-client 都从这里取，规则只写一次（docs/backend/R1）。
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const SITES = ['hospital', 'parking', 'museum'] as const;
export type Site = (typeof SITES)[number];

/**
 * 主题里的数据种类：pos 位置；event 设备事件（QoS 1，按 id 去重）；source 设备端（模拟器）的在线状态；
 * dev 设备状态和测量值（保留消息）；booking 预约系统的当天预约和合同（保留消息，R5-01）
 */
export const KINDS = ['pos', 'event', 'source', 'dev', 'booking'] as const;
export type Kind = (typeof KINDS)[number];

/** 医院的后端模拟：和人员定位页默认的名册用同一个种子和人数，同一个编号是同一个人（R2-01） */
export const HOSPITAL_SEED = 'playground';
export const HOSPITAL_TAGS = 2000;
/** 后端模式下医院的设备数：所有医院页面共用这一批人和设备（R4-01） */
export const HOSPITAL_ASSETS = 400;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const siteSchema = z.enum(SITES);
const kindSchema = z.enum(KINDS);
const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'only letters, digits, - and _');
const ROOT = 'ik/v1';

export interface TopicParts {
  site: Site;
  kind: Kind;
  deviceId: string;
}

/** 构造主题；参数来自我们自己的代码，非法即是程序错误，直接抛出 */
export function topic(site: Site, kind: Kind, deviceId: string): string {
  if (!siteSchema.safeParse(site).success) throw new Error(`topic: invalid site "${site}"`);
  if (!kindSchema.safeParse(kind).success) throw new Error(`topic: invalid kind "${kind}"`);
  if (!deviceIdSchema.safeParse(deviceId).success) throw new Error(`topic: invalid deviceId "${deviceId}"`);
  return `${ROOT}/${site}/${kind}/${deviceId}`;
}

/** 订阅用的通配主题，例如所有场景的位置 ik/v1/+/pos/+ */
export function topicFilter(kind: Kind, site: Site | '+' = '+'): string {
  return `${ROOT}/${site}/${kind}/+`;
}

/** 解析收到的主题：主题来自设备，是外部输入，失败时返回原因 */
export function parseTopic(text: string): Result<TopicParts> {
  const parts = text.split('/');
  if (parts.length !== 5 || `${parts[0]}/${parts[1]}` !== ROOT)
    return fail(`topic: expected ${ROOT}/{site}/{kind}/{deviceId}`);
  const [, , site, kind, deviceId] = parts;
  const s = siteSchema.safeParse(site);
  if (!s.success) return fail(`topic: invalid site "${site}"`);
  const k = kindSchema.safeParse(kind);
  if (!k.success) return fail(`topic: invalid kind "${kind}"`);
  if (!deviceIdSchema.safeParse(deviceId).success) return fail(`topic: invalid deviceId "${deviceId}"`);
  return { ok: true, value: { site: s.data, kind: k.data, deviceId: deviceId! } };
}

const coordSchema = z.tuple([z.number().finite(), z.number().finite()]);

/** 行驶结束（停下或出场）的标签发最后一条这个状态的位置，ingest 把它删掉而不是当作离线（R5-03） */
export const GONE = 'gone';

/** 设备上报的一个位置；seq 是这个设备自己的递增序号，ts 是设备时间（毫秒） */
export const positionReportSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().finite(),
  levelId: z.string().min(1),
  coord: coordSchema,
  status: z.string().min(1).optional(),
});
export type PositionReport = z.infer<typeof positionReportSchema>;

/** 设备事件：状态变化（求助按下、设备离线等），id 全局唯一，重发时不变（R4-03） */
export const eventReportSchema = z.object({
  id: z.string().min(1).max(128),
  ts: z.number().finite(),
  type: z.string().min(1),
  /** 事件后的状态；空字符串表示恢复正常 */
  status: z.string(),
});
export type EventReport = z.infer<typeof eventReportSchema>;

export function parseEventReport(payload: string | Uint8Array): Result<EventReport> {
  return parseJson(payload, eventReportSchema);
}

/** 入场时由控制器查合同库后带上的车辆属性；具体取值由 domains/parking 决定，这里只约定车牌 */
const vehicleSchema = z.looseObject({
  plate: z.string().min(1),
  vehicleClass: z.string().min(1),
  permit: z.boolean(),
  contract: z.looseObject({ kind: z.string().min(1) }),
});

export const PARKING_EVENT_KINDS = ['entry', 'park', 'leave', 'exit', 'charged'] as const;
export type ParkingEventKind = (typeof PARKING_EVENT_KINDS)[number];

/**
 * 停车场的事件（R5-02）：入场和出场来自车牌识别相机，停车和离开来自车位检测，充满电来自充电桩。
 * id 是 {日期}:{visitId}:{kind}，重发和补传时不变。
 */
export const parkingEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    ts: z.number().finite(),
    kind: z.enum(PARKING_EVENT_KINDS),
    visitId: z.string().min(1),
    plate: z.string().min(1),
    bayId: z.string().min(1),
    deviceId: z.string().min(1),
    vehicle: vehicleSchema.optional(),
    paid: z.boolean().optional(),
    gateId: z.string().min(1).optional(),
  })
  .check((ctx) => {
    const e = ctx.value;
    if (e.kind === 'entry' && !e.vehicle)
      ctx.issues.push({
        code: 'custom',
        path: ['vehicle'],
        message: 'an entry carries the vehicle',
        input: e,
      });
    if (e.kind === 'exit' && (e.paid === undefined || e.gateId === undefined))
      ctx.issues.push({
        code: 'custom',
        path: ['paid'],
        message: 'an exit carries paid and gateId',
        input: e,
      });
  });
export type ParkingEventReport = z.infer<typeof parkingEventSchema>;

export function parseParkingEvent(payload: string | Uint8Array): Result<ParkingEventReport> {
  return parseJson(payload, parkingEventSchema);
}

export const DEVICE_STATUSES = ['online', 'offline', 'fault', 'calling'] as const;

/** 设备状态和测量值（如 CO 浓度），保留消息；状态变化时和每分钟各发一次（R5-01） */
export const deviceReportSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().finite(),
  status: z.enum(DEVICE_STATUSES),
  value: z.number().finite().optional(),
});
export type DeviceReport = z.infer<typeof deviceReportSchema>;

export function parseDeviceReport(payload: string | Uint8Array): Result<DeviceReport> {
  return parseJson(payload, deviceReportSchema);
}

/** 预约系统：昨天和今天的预约（时刻是真实时间的毫秒）和月租合同，保留消息（R5-01） */
export const bookingReportSchema = z.object({
  ts: z.number().finite(),
  reservations: z.array(
    z.object({
      id: z.string().min(1),
      bayId: z.string().min(1),
      from: z.number().finite(),
      to: z.number().finite(),
      plate: z.string().min(1),
    }),
  ),
  contracts: z.array(z.object({ id: z.string().min(1), bayId: z.string().min(1) })),
});
export type BookingReport = z.infer<typeof bookingReportSchema>;

export function parseBookingReport(payload: string | Uint8Array): Result<BookingReport> {
  return parseJson(payload, bookingReportSchema);
}

/** 停车场演示的种子，和浏览器模拟相同（R5） */
export const PARKING_SEED = 'minato';
/** 停车场、博物馆的时刻按这个时区的当天算 */
export const SITE_TIME_ZONE = 'Asia/Tokyo';

const localParts = (ms: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    min: get('minute'),
    s: get('second'),
  };
};

/** ms 那一刻在 timeZone 里的当天 0 点（真实时间的毫秒） */
export function dayStartOf(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.y, p.m - 1, p.d) - offset;
}

/** ms 那一刻在 timeZone 里的日期，如 20261112 */
export function dateKeyOf(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
}

/** device-sim 的遗嘱主题内容 */
export const SOURCE_ONLINE = 'online';
export const SOURCE_OFFLINE = 'offline';
export const SIM_SOURCE_ID = 'sim';

export function parsePositionReport(payload: string | Uint8Array): Result<PositionReport> {
  return parseJson(payload, positionReportSchema);
}

/** Redis 键名：ingest 写，gateway 读 */
export const redisKeys = {
  /** Hash：设备 id → 最新状态（TagState 的 JSON） */
  state: (site: Site) => `ik:${site}:state`,
  /** Set：当前离线的设备 */
  offline: (site: Site) => `ik:${site}:offline`,
  /** Stream：推给浏览器的帧，字段 f 是帧的 JSON（不含 seq，seq 就是条目 id） */
  frames: (site: Site) => `ik:${site}:frames`,
  /** String：设备端（模拟器）在线状态 */
  source: (site: Site) => `ik:${site}:source`,
  /** Hash：未处理的告警，告警 id → AlarmRecord 的 JSON */
  openAlarms: (site: Site) => `ik:${site}:alarms:open`,
  /** String（带过期）：处理过的事件 id，用于去重 */
  event: (site: Site, id: string) => `ik:${site}:event:${id}`,
  /** List：昨天 0 点以后的场景事件（JSON），快照时整份给浏览器（R5-07） */
  dayEvents: (site: Site) => `ik:${site}:day-events`,
  /** String：场景的当天状态（JSON），快照的 day（R5-07） */
  day: (site: Site) => `ik:${site}:day`,
};
/** MongoDB 的库和集合名：ingest 写，gateway 读（R4） */
export const MONGO_DB = 'indoorkit';
export const mongoCollections = {
  /** 时序集合：timeField ts，metaField meta = { site, deviceId } */
  telemetry: 'telemetry',
  alarms: 'alarms',
  events: 'events',
} as const;
/** 遥测保留天数 */
export const TELEMETRY_TTL_DAYS = 7;

/** Stream 里帧的字段名 */
export const FRAME_FIELD = 'f';
/** Stream 约保留的帧数：每秒一帧，约 5 分钟 */
export const FRAMES_MAXLEN = 300;

export const tagStateSchema = z.object({
  id: z.string().min(1),
  levelId: z.string().min(1),
  coord: coordSchema,
  status: z.string().min(1).optional(),
});
export type TagState = z.infer<typeof tagStateSchema>;

/**
 * 告警记录。具体字段由各场景的业务包决定（医院：layer、kind、ruleId、subjectId……），
 * 协议只约定所有场景共有的部分，其余原样透传。
 */
export const ALARM_STATES = ['open', 'acknowledged', 'resolved'] as const;
export type AlarmState = (typeof ALARM_STATES)[number];
export const alarmRecordSchema = z.looseObject({
  id: z.string().min(1),
  time: z.number().finite(),
  level: z.string().min(1),
  state: z.enum(ALARM_STATES),
});
export type AlarmRecord = z.infer<typeof alarmRecordSchema>;

/** Redis Stream 的条目 id，形如 "1700000000000-0" */
const seqSchema = z.string().regex(/^\d+-\d+$/);

const siteFrame = {
  site: siteSchema,
  seq: seqSchema,
  time: z.number().finite(),
  /** 断线续传时补发的帧（R3-05） */
  replay: z.literal(true).optional(),
};

export const serverFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int(), serverTime: z.number() }),
  z.object({
    type: z.literal('snapshot'),
    ...siteFrame,
    positions: z.array(tagStateSchema),
    offline: z.array(z.string()),
    /** 设备端（模拟器）是否在线；还不知道时不带 */
    source: z.boolean().optional(),
    /** 未处理的告警，新的在后（R4-07） */
    alarms: z.array(alarmRecordSchema).optional(),
    /** 停车场、博物馆的当天状态，内容由场景决定（R5-04） */
    day: z.looseObject({}).optional(),
  }),
  z.object({ type: z.literal('positions'), ...siteFrame, positions: z.array(tagStateSchema) }),
  z.object({
    type: z.literal('device'),
    ...siteFrame,
    online: z.array(z.string()),
    offline: z.array(z.string()),
  }),
  z.object({ type: z.literal('source'), ...siteFrame, online: z.boolean() }),
  z.object({ type: z.literal('alarm'), ...siteFrame, alarm: alarmRecordSchema }),
  z.object({
    type: z.literal('alarm-state'),
    ...siteFrame,
    id: z.string().min(1),
    state: z.enum(ALARM_STATES),
  }),
  /** 场景事件（停车事件、设备状态变化），内容由场景决定（R5-04） */
  z.object({ type: z.literal('site-event'), ...siteFrame, event: z.looseObject({}) }),
  /** 断线续传的补发结束：之后都是实时帧（R3-05） */
  z.object({
    type: z.literal('synced'),
    site: siteSchema,
    seq: z.string(),
    replayed: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('ping'), t: z.number(), rttMs: z.number().optional() }),
  z.object({ type: z.literal('bye'), reason: z.enum(['restart', 'shutdown']) }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;
/** 写进 Stream 的帧：seq 由 Redis 分配，读出来时补上 */
export type StreamFrame = DistributiveOmit<Extract<ServerFrame, { seq: string; time: number }>, 'seq'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), site: siteSchema, after: seqSchema.optional() }),
  z.object({ type: z.literal('pong'), t: z.number() }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export function parseServerFrame(text: string): Result<ServerFrame> {
  return parseJson(text, serverFrameSchema);
}

export function parseClientFrame(text: string): Result<ClientFrame> {
  return parseJson(text, clientFrameSchema);
}

/** 按数值比较两个 Stream id；字符串比较会把 "10-0" 排在 "9-0" 前面 */
export function compareSeq(a: string, b: string): number {
  const [am, an] = a.split('-').map(Number) as [number, number];
  const [bm, bn] = b.split('-').map(Number) as [number, number];
  return am !== bm ? am - bm : an - bn;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const decoder = new TextDecoder();

function parseJson<T>(payload: string | Uint8Array, schema: z.ZodType<T>): Result<T> {
  let data: unknown;
  try {
    data = JSON.parse(typeof payload === 'string' ? payload : decoder.decode(payload));
  } catch {
    return fail('invalid JSON');
  }
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0]!;
  return fail(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
}
