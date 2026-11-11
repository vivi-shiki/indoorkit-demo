import { definePlugin } from '@indoorkit/core';
import {
  type Alarm,
  type AlarmSubject,
  createAlarmEngine,
  createHospital,
  type DepartmentRule,
  type FenceRule,
} from '@indoorkit/hospital';
import { createVenueIndex, type FloorApi, type PolygonInput, type ShapeApi } from '@indoorkit/plugins';
import type { PositionBatch } from '@indoorkit/rtls';

declare module '@indoorkit/core' {
  interface IndoorEvents {
    'alarm:raise': Alarm;
  }
}

export type FenceInput = Omit<FenceRule, 'levelId'> & {
  /** 楼层 id 或简称；省略时使用当前楼层 */
  floor?: string;
  /** 围栏在地图上的颜色 */
  color?: string;
};

export interface AlarmApi {
  addFence(input: FenceInput): string;
  removeFence(id: string): boolean;
  fences(): readonly FenceRule[];
  /** 打开地图以来产生的全部报警，按时间先后 */
  alarms(): readonly Alarm[];
  check(batch: PositionBatch): Alarm[];
  /**
   * 加入别处（后端）算出的告警，已有的 id 跳过。announce 为 true 时广播 alarm:raise；
   * 快照里补上的旧告警不广播。返回新加入的告警。
   */
  add(alarms: readonly Alarm[], options: { announce: boolean }): Alarm[];
}

/**
 * 把医院的两层报警接到地图上：每次位置上报交给报警引擎检查，报警作为 alarm:raise 事件广播；
 * 自定义围栏用 SDK 的 polygon 插件画出。
 */
export function hospitalAlarmPlugin(options: {
  subjects: Iterable<AlarmSubject>;
  departmentRules: readonly DepartmentRule[];
  /** 是否在浏览器里算告警；后端模式下告警来自服务器，返回 false（docs/backend/R4-13） */
  local?: () => boolean;
}) {
  return definePlugin({
    name: 'alarm',
    deps: ['floor', 'polygon'],
    setup(ctx): AlarmApi {
      const floor = ctx.get<FloorApi>('floor');
      const polygons = ctx.get<ShapeApi<PolygonInput>>('polygon');
      const engine = createAlarmEngine({
        hospital: createHospital(ctx.venue, createVenueIndex(ctx.venue)),
        subjects: options.subjects,
        departmentRules: options.departmentRules,
      });
      const raised: Alarm[] = [];
      const known = new Set<string>();
      const check = (batch: PositionBatch) => {
        if (options.local && !options.local()) return [];
        const alarms = engine.check(batch);
        for (const a of alarms) {
          raised.push(a);
          known.add(a.id);
          ctx.events.emit('alarm:raise', a);
        }
        return alarms;
      };
      ctx.on('positions:update', check);
      return {
        addFence({ floor: ref, color, ...input }) {
          const level = ref ? floor.resolve(ref) : floor.current();
          engine.addFence({ ...input, levelId: level.id });
          polygons.add({
            id: input.id,
            coordinates: input.coordinates,
            floor: level.id,
            label: input.label,
            color,
          });
          return input.id;
        },
        removeFence(id) {
          if (!engine.removeFence(id)) return false;
          polygons.remove(id);
          return true;
        },
        fences: engine.fences,
        alarms: () => raised,
        check,
        add(alarms, { announce }) {
          const fresh = alarms.filter((a) => !known.has(a.id));
          for (const a of fresh) {
            known.add(a.id);
            raised.push(a);
          }
          if (fresh.length > 0 && !announce) raised.sort((a, b) => a.time - b.time);
          if (announce) for (const a of fresh) ctx.events.emit('alarm:raise', a);
          return fresh;
        },
      };
    },
  });
}
