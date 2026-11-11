import { departmentExtension } from '@indoorkit/hospital';
import { buildVenueModel, type VenueModel } from '@indoorkit/imdf';
import { type PositionReport, SIM_SOURCE_ID, type Site, SOURCE_OFFLINE, topic } from '@indoorkit/protocol';
import { createSimulation } from '@indoorkit/rtls-simulator';
import { generateVenue, SAKURA_HOSPITAL } from '@indoorkit/venue-gen';
import type { Outgoing } from './faults';

/** 和浏览器加载的是同一份虚构医院：生成器是确定的，楼层 id 和区块 id 都一致 */
export const HOSPITAL_VENUE: VenueModel = buildVenueModel(generateVenue(SAKURA_HOSPITAL), [
  departmentExtension,
]);

export interface HospitalDeviceOptions {
  seed: string;
  tags: number;
  /** 设备时钟（毫秒） */
  now: () => number;
}

/** 医院的定位标签：每次 tick 推进模拟并为每个标签生成一条上报（R2-01、R2-02） */
export function createHospitalDevices(venue: VenueModel, options: HospitalDeviceOptions) {
  const sim = createSimulation(venue, { seed: options.seed, tags: options.tags, assets: 0 });
  const seq = new Map<string, number>();
  return {
    tick(dtMs: number): Outgoing[] {
      const ts = options.now();
      return sim.step(dtMs).map((p) => {
        const next = (seq.get(p.id) ?? -1) + 1;
        seq.set(p.id, next);
        const report: PositionReport = { seq: next, ts, levelId: p.levelId, coord: p.coord };
        if (p.status) report.status = p.status;
        return { deviceId: p.id, topic: topic('hospital', 'pos', p.id), payload: JSON.stringify(report) };
      });
    },
  };
}

/** 模拟器断线时 broker 代发的遗嘱：保留消息，后连上的 ingest 也能知道（R2-03） */
export function sourceWill(site: Site) {
  return {
    topic: topic(site, 'source', SIM_SOURCE_ID),
    payload: SOURCE_OFFLINE,
    retain: true,
    qos: 1 as const,
  };
}
