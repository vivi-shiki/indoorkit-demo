import type { VenueModel } from '@indoorkit/imdf';
import { createLiveProvider } from '@indoorkit/live-client';
import { HOSPITAL_TAGS } from '@indoorkit/protocol';
import { createSwitchingProvider, resolveSource } from './live-source';
import { createSimProvider, PEOPLE_SEED } from './sim';

/** 构建时的后端地址；Pages 还没有后端时不设（docs/backend/R2-11） */
const BUILD_LIVE_URL: string | undefined = import.meta.env.VITE_LIVE_URL || undefined;

/** 这个页面地址会不会用后端：会的话人数由后端决定（R2-15） */
export function usesBackend(query: URLSearchParams) {
  return resolveSource(query, BUILD_LIVE_URL).mode !== 'sim';
}

/** 后端模式下人员定位的标签数 */
export const LIVE_PEOPLE = HOSPITAL_TAGS;

/**
 * 人员定位的数据源：后端的医院位置流，不可用时退回浏览器里的模拟器。
 * 模拟器和后端用同一个种子，退回时还是同一批人。
 */
export function createPeopleSource(venue: VenueModel, options: { people: number; query: URLSearchParams }) {
  const { mode, url } = resolveSource(options.query, BUILD_LIVE_URL);
  return createSwitchingProvider({
    mode,
    live: url ? createLiveProvider({ url, site: 'hospital' }) : null,
    createSim: () => createSimProvider(venue, { people: options.people, seed: PEOPLE_SEED }),
  });
}
