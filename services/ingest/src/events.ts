import type { EventReport, Site } from '@indoorkit/protocol';

export interface EventStore {
  /** 第一次见到这个 id 时返回 true（Redis SET NX 加过期），重复的返回 false */
  claim(site: Site, id: string): Promise<boolean>;
  save(doc: EventReport & { site: Site; deviceId: string }): Promise<void>;
}

/** 设备事件按 id 去重后保存（R4-03）：QoS 1 和设备重发都可能让同一事件到达多次 */
export async function handleEvent(
  store: EventStore,
  site: Site,
  deviceId: string,
  report: EventReport,
): Promise<'new' | 'duplicate'> {
  if (!(await store.claim(site, report.id))) return 'duplicate';
  await store.save({ ...report, site, deviceId });
  return 'new';
}
