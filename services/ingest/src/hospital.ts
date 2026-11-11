import {
  createAlarmEngine,
  createHospital,
  DEPARTMENT_RULES,
  departmentExtension,
  presetFences,
  subjectsOf,
} from '@indoorkit/hospital';
import { buildVenueModel, type VenueModel } from '@indoorkit/imdf';
import { createVenueIndex } from '@indoorkit/plugins/venue-index';
import type { AlarmRecord } from '@indoorkit/protocol';
import type { PositionBatch } from '@indoorkit/rtls';
import { createRoster } from '@indoorkit/rtls-simulator';
import { generateVenue, SAKURA_HOSPITAL } from '@indoorkit/venue-gen';

/** 和浏览器、device-sim 同一份虚构医院 */
export const HOSPITAL_VENUE: VenueModel = buildVenueModel(generateVenue(SAKURA_HOSPITAL), [
  departmentExtension,
]);

/**
 * 服务端的医院告警（docs/backend/R4-05）：和浏览器的告警页用同一个引擎、同一组科室规则和预设围栏。
 * 告警 id 加上 idPrefix（每次启动不同），ingest 重启后也不会和库里已有的重复。
 */
export function createHospitalAlarms(
  venue: VenueModel,
  options: { people: number; assets: number; idPrefix: string },
) {
  const hospital = createHospital(venue, createVenueIndex(venue));
  const roster = createRoster(venue, { people: options.people, assets: options.assets });
  const engine = createAlarmEngine({
    hospital,
    subjects: subjectsOf(roster),
    departmentRules: DEPARTMENT_RULES,
  });
  for (const fence of presetFences(venue, hospital)) engine.addFence(fence);
  return {
    check(batch: PositionBatch): AlarmRecord[] {
      return engine.check(batch).map((a) => ({ ...a, id: `${options.idPrefix}-${a.id}`, state: 'open' }));
    },
  };
}
