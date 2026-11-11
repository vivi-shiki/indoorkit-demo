import type { VenueModel } from '@indoorkit/imdf';
import { createLiveProvider } from '@indoorkit/live-client';
import { HOSPITAL_ASSETS, HOSPITAL_TAGS } from '@indoorkit/protocol';
import { apiBase, createSwitchingProvider, resolveSource } from './live-source';
import { createSimProvider, PEOPLE_SEED } from './sim';

/** 构建时的后端地址；Pages 还没有后端时不设（docs/backend/R2-11） */
const BUILD_LIVE_URL: string | undefined = import.meta.env.VITE_LIVE_URL || undefined;

/** 这个页面地址会不会用后端：会的话对象数由后端决定（R2-15） */
export function usesBackend(query: URLSearchParams) {
  return resolveSource(query, BUILD_LIVE_URL).mode !== 'sim';
}

/** 后端的 REST 地址；只用模拟器时为 null（R4-08） */
export function backendApi(query: URLSearchParams) {
  const { mode, url } = resolveSource(query, BUILD_LIVE_URL);
  return mode === 'sim' ? null : apiBase(url);
}

/** 后端模式下医院的对象数：所有页面共用这一批（R4-12） */
export const LIVE_PEOPLE = HOSPITAL_TAGS;
export const LIVE_ASSETS = HOSPITAL_ASSETS;

export type HospitalKind = 'person' | 'asset';

/** 名册的编号：人员 P0001…，设备 A0001…（@indoorkit/rtls-simulator 的 createRoster） */
const kindOf = (id: string): HospitalKind => (id.startsWith('A') ? 'asset' : 'person');

/**
 * 医院页面的数据源：后端的医院位置流里取这个页面要的对象，后端不可用时退回浏览器模拟器。
 * people、assets、seed 是模拟器的参数；后端模式下页面应当用 LIVE_PEOPLE、LIVE_ASSETS 建名册。
 */
export function createHospitalSource(
  venue: VenueModel,
  options: {
    query: URLSearchParams;
    kinds: readonly HospitalKind[];
    people: number;
    assets: number;
    seed: string;
  },
) {
  const { mode, url } = resolveSource(options.query, BUILD_LIVE_URL);
  const kinds = new Set(options.kinds);
  return createSwitchingProvider({
    mode,
    live: url ? createLiveProvider({ url, site: 'hospital' }) : null,
    createSim: () =>
      createSimProvider(venue, { people: options.people, assets: options.assets, seed: options.seed }),
    keep: kinds.size === 2 ? undefined : (id) => kinds.has(kindOf(id)),
  });
}

/** 人员页面的数据源。模拟器和后端用同一个种子，退回时还是同一批人 */
export function createPeopleSource(venue: VenueModel, options: { people: number; query: URLSearchParams }) {
  return createHospitalSource(venue, {
    query: options.query,
    kinds: ['person'],
    people: options.people,
    assets: 0,
    seed: PEOPLE_SEED,
  });
}
