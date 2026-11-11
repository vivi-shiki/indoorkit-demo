import { type Alarm, DEPARTMENT_RULES, dayTime, presetFences, subjectsOf } from '@indoorkit/hospital';
import {
  floorPlugin,
  polygonPlugin,
  popupPlugin,
  positionStreamPlugin,
  zonePlugin,
} from '@indoorkit/plugins';
import type { AlarmRecord } from '@indoorkit/protocol';
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from 'react';
import { hospitalAlarmPlugin } from '../../adapters/alarm';
import { backendApi, createHospitalSource, LIVE_ASSETS, LIVE_PEOPLE, usesBackend } from '../../adapters/live';
import type { SwitchingProvider } from '../../adapters/live-source';
import { createRoster, SIM_INTERVAL_MS } from '../../adapters/sim';
import { placesOf } from '../../adapters/venue';
import type { HospitalPageProps } from '../../app/routes';
import { i18n, useT } from '../../app-i18n';
import type { MessageKey } from '../../i18n';
import { roleColor } from '../../presentation/colors';
import { assetName, personName, placeText } from '../../presentation/format';
import { LiveStatusMetric } from '../../presentation/live-status';
import { ChipGroup } from '../../presentation/ui';
import { floorName, MapPageLayout, useMapEvent, useMapPage, useSourceStatus } from '../map-page';
import { AlarmItem, type AlarmState } from './view';

/** 浏览器模拟的对象数；后端模式下是后端的那一批（docs/backend/R4-12） */
const SIM_PEOPLE = 600;
const SIM_ASSETS = 200;
/** 列表只显示最新的这么多条；已确认、处理中的始终显示 */
const MAX_SHOWN = 50;
const LAYERS = ['department', 'fence', 'status'] as const;
const NONE: ReadonlySet<string> = new Set();

/** 浏览器引擎的告警 id 是 alarm-N；后端的带每次启动不同的前缀（docs/backend/R4-05） */
const fromServer = (a: Alarm) => !a.id.startsWith('alarm-');
/** 告警时刻 → 一天里的毫秒数：后端是真实时间，模拟从 9:00 起算 */
const clockOf = (a: Alarm) =>
  fromServer(a) ? a.time - new Date(a.time).setHours(0, 0, 0, 0) : dayTime(a.time);

/** 预设围栏在地图上的颜色；围栏本身定义在 @indoorkit/hospital，服务端也用它（docs/backend/R4-04） */
const FENCE_COLORS: Record<string, string> = {
  'icu-restricted': '#dc2626',
  'exit-antitheft': '#ea580c',
  'ward-dwell': '#9333ea',
};

/** 禁入区域告警：科室范围、自定义围栏和设备状态三类告警的实时列表与处理 */
export function AlertsPage({ query }: HospitalPageProps) {
  const t = useT();
  const backend = usesBackend(query);
  const counts = backend
    ? { people: LIVE_PEOPLE, assets: LIVE_ASSETS }
    : { people: SIM_PEOPLE, assets: SIM_ASSETS };
  const api = useMemo(() => backendApi(query), [query]);
  const stageRef = useRef<HTMLDivElement>(null);
  const source = useRef<SwitchingProvider | null>(null);
  // 设备用灰色画，人员按角色着色；名册在场馆加载后才有
  const roster = useRef<ReturnType<typeof createRoster> | null>(null);
  const [page, load] = useMapPage(stageRef, {
    demo: 'alerts',
    readyWhen: 'first-positions',
    floor: '3F',
    plugins: (venue) => {
      roster.current = createRoster(venue, counts);
      const src = createHospitalSource(venue, {
        query,
        kinds: ['person', 'asset'],
        ...counts,
        seed: 'alerts',
      });
      source.current = src;
      const roles = new Map(roster.current.people.map((p) => [p.id, p.role]));
      return [
        floorPlugin,
        polygonPlugin,
        popupPlugin,
        zonePlugin({ zones: placesOf(venue).hospital.zones() }),
        hospitalAlarmPlugin({
          subjects: subjectsOf(roster.current),
          departmentRules: DEPARTMENT_RULES,
          // 显示后端数据时告警由服务器算，浏览器只在退回模拟时自己算（R4-13）
          local: () => src.status().source === 'sim',
        }),
        positionStreamPlugin({
          provider: src,
          intervalMs: SIM_INTERVAL_MS,
          decorate: (id) => ({ role: roles.get(id) ?? 'asset' }),
          circleColor: roleColor,
        }),
      ] as const;
    },
  });
  const alarm = page?.indoor.plugins.alarm;
  const liveStatus = useSourceStatus(page, source);
  const people = useMemo(() => new Map((page ? roster.current!.people : []).map((p) => [p.id, p])), [page]);
  const assets = useMemo(() => new Map((page ? roster.current!.assets : []).map((a) => [a.id, a])), [page]);

  const fences = useMemo(() => (page ? presetFences(page.venue, page.hospital) : []), [page]);
  useEffect(() => {
    for (const { levelId, label, ...fence } of fences) {
      alarm!.addFence({
        ...fence,
        label: i18n.t(label as MessageKey),
        floor: levelId,
        color: FENCE_COLORS[fence.id],
      });
    }
  }, [alarm, fences]);

  const [states, setStates] = useState(new Map<string, AlarmState>());
  const updateStates = useCallback(
    (entries: Iterable<[string, AlarmState]>) =>
      setStates((prev) => {
        const next = new Map(prev);
        for (const [id, state] of entries) next.set(id, state);
        return next;
      }),
    [],
  );

  // 后端的告警：新告警、快照里未处理的告警和别人确认、解决的状态（R4-13）
  useEffect(() => {
    const src = source.current;
    if (!page || !alarm || !src) return;
    const asAlarm = (r: AlarmRecord) => r as unknown as Alarm;
    return src.onAlarm((e) => {
      if (e.type === 'state') updateStates([[e.id, e.state]]);
      else {
        const records = e.type === 'raise' ? [e.alarm] : e.alarms;
        alarm.add(records.map(asAlarm), { announce: e.type === 'raise' });
        updateStates(records.filter((r) => r.state !== 'open').map((r) => [r.id, r.state]));
        dirty.current = true;
      }
    });
  }, [page, alarm, updateStates]);

  const stateOf = (id: string): AlarmState => states.get(id) ?? 'open';
  const [layers, setLayers] = useState(NONE);

  const subjectName = (id: string) => {
    const p = people.get(id);
    if (p) return `${personName(p)} · ${t(`role.${p.role}`)}`;
    const a = assets.get(id);
    return a ? assetName(a) : id;
  };
  const kindText = (a: Alarm) => {
    const fence = a.fenceId ? fences.find((f) => f.id === a.fenceId) : undefined;
    return fence ? `${t(`alarm.${a.kind}`)} · ${t(fence.label as MessageKey)}` : t(`alarm.${a.kind}`);
  };

  // 记住弹窗对应的告警，切换语言时用新语言重开
  const [popupAlarm, setPopupAlarm] = useState<Alarm | null>(null);
  const showPopup = (a: Alarm) => {
    setPopupAlarm(a);
    page!.indoor.plugins.popup.open({
      id: 'alarm',
      coord: a.coord,
      text: `${subjectName(a.subjectId)} · ${kindText(a)}`,
    });
  };
  const reopenPopup = useEffectEvent(() => {
    if (popupAlarm && page?.indoor.plugins.popup.list().includes('alarm')) showPopup(popupAlarm);
  });
  useEffect(() => i18n.subscribe(() => reopenPopup()), []);

  // 告警在位置上报时产生，每次上报后最多重画一次列表
  const [, redraw] = useReducer((v: number) => v + 1, 0);
  const dirty = useRef(false);
  useMapEvent(page, 'alarm:raise', (a) => {
    // 当前楼层的新告警弹窗提示
    if (a.levelId === page!.floor.current().id) showPopup(a);
    dirty.current = true;
  });
  useMapEvent(page, 'positions:update', () => {
    if (!dirty.current) return;
    dirty.current = false;
    redraw();
  });

  const unhandled = alarm ? alarm.alarms().filter((a) => stateOf(a.id) !== 'resolved').length : 0;
  useEffect(() => {
    if (!page || !alarm) return;
    const { hooks } = page;
    hooks.fenceIds = () => alarm.fences().map((f) => f.id);
    hooks.alertCount = () => alarm.alarms().length;
    hooks.alarmIds = () => alarm.alarms().map((a) => a.id);
    hooks.alarmLayers = () => [...new Set(alarm.alarms().map((a) => a.layer))].sort();
  }, [page, alarm]);
  useEffect(() => {
    if (!page || !alarm) return;
    page.hooks.alarmState = (id) => states.get(id) ?? 'open';
    page.hooks.unhandledCount = () =>
      alarm.alarms().filter((a) => (states.get(a.id) ?? 'open') !== 'resolved').length;
  }, [page, alarm, states]);

  let feed = null;
  if (page && alarm) {
    const { floor, index, venue } = page;
    const all = alarm.alarms().filter((a) => layers.size === 0 || layers.has(a.layer));
    const shown: Alarm[] = [];
    let latest = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const a = all[i]!;
      if (latest < MAX_SHOWN) {
        latest++;
        shown.push(a);
      } else if (stateOf(a.id) === 'acknowledged') shown.push(a);
    }
    const act = (a: Alarm, action: 'ack' | 'resolve' | 'locate') => {
      if (action === 'locate') {
        floor.set(a.levelId);
        page.indoor.camera.focus(a.coord);
        showPopup(a);
        redraw();
        return;
      }
      const state = action === 'ack' ? 'acknowledged' : 'resolved';
      updateStates([[a.id, state]]);
      // 后端的告警由后端改状态，再推给所有打开告警页的人（R4-10）
      if (api && fromServer(a)) {
        void fetch(`${api}/hospital/alarms/${encodeURIComponent(a.id)}/${action}`, { method: 'POST' }).catch(
          () => {},
        );
      }
    };
    feed = shown.map((a) => (
      <AlarmItem
        key={a.id}
        alarm={a}
        text={{
          floor: floorName(floor, a.levelId),
          kind: kindText(a),
          subject: subjectName(a.subjectId),
          clock: clockOf(a),
          place: `${floorName(floor, a.levelId)} · ${placeText(index, venue, a.unitId ? { unitId: a.unitId, departmentId: a.departmentId } : null)}`,
        }}
        state={stateOf(a.id)}
        onAction={(action) => act(a, action)}
      />
    ));
  }

  return (
    <MapPageLayout
      title="page.alerts.title"
      desc="page.alerts.desc"
      stageRef={stageRef}
      page={page}
      load={load}
      controls={
        <>
          <LiveStatusMetric status={liveStatus} />
          <span className="metric">
            {t('metric.alerts')}: <b data-testid="alert-count">{alarm?.alarms().length ?? 0}</b>
          </span>
          <span className="metric">
            {t('metric.unhandled')}: <b data-testid="unhandled-count">{unhandled}</b>
          </span>
          <ChipGroup
            testId="layer-chip"
            items={LAYERS.map((l) => ({ value: l, text: t(`layer.${l}`) }))}
            selected={layers}
            onChange={setLayers}
          />
        </>
      }
    >
      <aside className="panel alarm-panel">
        <ul className="alarm-feed" data-testid="alert-list">
          {feed}
        </ul>
      </aside>
    </MapPageLayout>
  );
}
