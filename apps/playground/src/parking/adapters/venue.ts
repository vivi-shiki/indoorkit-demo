import { buildVenueModel, fetchImdf, type VenueModel } from '@indoorkit/imdf';
import {
  type Bookings,
  createBookings,
  createParking,
  createRouter,
  type ParkedVehicle,
  type Parking,
  parkingExtensions,
  type Router,
} from '@indoorkit/parking';
import { createParkingDay } from '@indoorkit/parking-simulator';
import { backendOf } from '../../adapters/live-source';
import { type AlarmStore, createAlarmStore } from './alarms';
import { connectParking, fallbackSource, type ParkingSource } from './backend';
import { createSimClock, DEFAULT_START, type SimClock } from './clock';
import { alertBays, type BayState, bayStates, detectorsDown, freeByLevel, reservedBays } from './live';
import type { ParkingDayView } from './live-day';

/**
 * 停车场演示的数据：场馆、业务、这一天、时钟、告警和预约；换页后保留。
 * 浏览器模拟时 day、alarms、clock 来自种子生成的一天；后端模式下来自后端（docs/backend/R5-09）。
 */
export interface ParkingContext {
  venue: VenueModel;
  parking: Parking;
  day: ParkingDayView;
  router: Router;
  bookings: Bookings;
  alarms: AlarmStore;
  clock: SimClock;
  /** 地址里有后端时的数据源状态；只用浏览器模拟时为 null */
  source: ParkingSource | null;
}

/** 后端模式下时间是真实时间：不能换倍速、不能跳时间 */
export const isBackend = (ctx: Pick<ParkingContext, 'source'>) => ctx.source?.status().source === 'live';

/** 同一个种子，同一个车牌就是同一辆车 */
export const PARKING_SEED = 'minato';

let cached: { key: string; ctx: Promise<ParkingContext> } | undefined;

/**
 * 虚构的港中央停车场由 tools/venue-gen 在构建时生成；区、设备和车道在 IMDF 之外的扩展文件里。
 * 用后端还是浏览器模拟在打开时按地址决定（?source=、?live=），之后换页沿用同一份。
 */
export function loadParking(query: URLSearchParams = currentQuery()): Promise<ParkingContext> {
  const { mode, url } = backendOf(query);
  const key = `${mode}:${url ?? ''}`;
  if (cached?.key !== key) {
    const ctx = open(mode, url);
    cached = { key, ctx };
    // 失败的请求不缓存，重试时重新下载
    ctx.catch(() => {
      if (cached?.ctx === ctx) cached = undefined;
    });
  }
  return cached.ctx;
}

/** 哈希路由里的查询参数：#/parking/availability?source=live */
function currentQuery() {
  const hash = typeof location === 'undefined' ? '' : location.hash;
  return new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
}

async function open(mode: ReturnType<typeof backendOf>['mode'], url: string | null): Promise<ParkingContext> {
  const archive = await fetchImdf(`${import.meta.env.BASE_URL}data/minato-parking`, fetch, parkingExtensions);
  const venue = buildVenueModel(archive, parkingExtensions);
  const parking = createParking(venue);
  const shared = { venue, parking, router: createRouter(parking), bookings: createBookings(parking) };
  if (mode !== 'sim' && url) {
    const backend = await connectParking({ mode, url });
    if (backend) return { ...shared, ...backend };
  }
  const day = createParkingDay(parking, { seed: PARKING_SEED });
  return {
    ...shared,
    day,
    alarms: createAlarmStore(parking, day),
    clock: createSimClock({ start: DEFAULT_START }),
    source: mode === 'sim' ? null : fallbackSource(mode),
  };
}

/** 某一时刻的场内状态：停着的车、每个车位的状态和每层的空闲数 */
export interface LiveSnapshot {
  time: number;
  parked: readonly ParkedVehicle[];
  parkedByBay: ReadonlyMap<string, ParkedVehicle>;
  states: ReadonlyMap<string, BayState>;
  freeByLevel: ReadonlyMap<string, number>;
}

export function liveAt(
  ctx: Pick<ParkingContext, 'parking' | 'day' | 'alarms' | 'bookings'>,
  t: number,
): LiveSnapshot {
  ctx.alarms.update(t);
  const parked = ctx.day.parkedAt(t);
  const states = bayStates({
    parking: ctx.parking,
    parked,
    detectorsDown: detectorsDown(ctx.parking, ctx.day.deviceReadings(t)),
    reserved: reservedBays(ctx.parking, ctx.day.reservations, ctx.bookings, t),
    alerts: alertBays(ctx.alarms, parked),
  });
  return {
    time: t,
    parked,
    parkedByBay: new Map(parked.map((p) => [p.bayId, p])),
    states,
    freeByLevel: freeByLevel(ctx.parking, states),
  };
}
