import type { VenueModel } from '@indoorkit/imdf';
import type { Polygon } from 'geojson';
import type { FenceRule } from './alarm';
import type { Hospital } from './departments';

/** 预设围栏的名称是文案键，由界面翻译（docs/backend/R4-04） */
export type PresetFence = FenceRule & { label: `fence.${string}` };

/**
 * 告警演示的三个预设围栏：ICU 禁入、出口防盗、病房停留。
 * 浏览器的告警页和服务端的告警计算用同一份定义。
 */
export function presetFences(venue: VenueModel, hospital: Pick<Hospital, 'departmentByCode'>): PresetFence[] {
  const levelOf = (shortName: string) => {
    const level = venue.levels.find((l) => Object.values(l.shortName).includes(shortName));
    if (!level) throw new Error(`no level ${shortName}`);
    return level.id;
  };
  const unitOn = (levelId: string, name: string, pick: 'middle' | 'first' = 'first') => {
    const found = venue.features.units.features.filter(
      (u) =>
        u.properties.level_id === levelId &&
        (u.properties.label_en === name || u.properties.category === name),
    );
    const unit = found[pick === 'middle' ? Math.floor(found.length / 2) : 0];
    if (!unit) throw new Error(`no ${name} on ${levelId}`);
    return (unit.geometry as Polygon).coordinates[0] as [number, number][];
  };
  const f3 = levelOf('3F');
  const f1 = levelOf('1F');
  const f4 = levelOf('4F');
  return [
    {
      id: 'icu-restricted',
      label: 'fence.icu',
      levelId: f3,
      coordinates: unitOn(f3, 'ICU', 'middle'),
      rule: 'forbid',
      selector: { kinds: ['person'] },
      exemptDepartments: [hospital.departmentByCode('icu').id],
      level: 'high',
    },
    {
      id: 'exit-antitheft',
      label: 'fence.exit',
      levelId: f1,
      coordinates: unitOn(f1, 'lobby'),
      rule: 'forbid',
      selector: { kinds: ['asset'] },
      level: 'high',
    },
    {
      id: 'ward-dwell',
      label: 'fence.wardDwell',
      levelId: f4,
      coordinates: unitOn(f4, 'Patient room 401'),
      rule: 'dwell',
      dwellMs: 120_000,
      selector: { roles: ['visitor'] },
      level: 'medium',
    },
  ];
}
