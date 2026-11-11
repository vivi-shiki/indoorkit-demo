import type { AlarmRecord, AlarmState, Site } from '@indoorkit/protocol';
import { parseApiRequest } from './api';

export interface HistoryPoint {
  ts: number;
  levelId: string;
  coord: [number, number];
  status?: string;
}

/** REST 用到的存储操作；main 里用 MongoDB 和 Redis 实现，测试用假的 */
export interface ApiBackend {
  history(site: Site, deviceId: string, from: number, to: number): Promise<HistoryPoint[]>;
  /** 新的在前 */
  alarms(site: Site, state: 'open' | 'all', limit: number): Promise<AlarmRecord[]>;
  /** 改状态并推 alarm-state 帧；告警不存在时返回 null */
  setAlarmState(site: Site, id: string, state: AlarmState): Promise<AlarmRecord | null>;
}

export interface ApiOptions {
  backend: ApiBackend;
  /** 允许的页面来源；不设表示不限制（只在本地用） */
  allowed?: string[];
  /** session：公开部署，不改共享数据，状态只留在浏览器里（R4-10） */
  writes: 'shared' | 'session';
  onError?: (err: unknown) => void;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

/** /api 下的请求；不是 /api 的返回 null，交给别的路由 */
export async function handleApi(
  req: { method: string; url: string; origin?: string },
  { backend, allowed, writes, onError }: ApiOptions,
): Promise<ApiResponse | null> {
  if (!req.url.startsWith('/api/')) return null;
  const headers: Record<string, string> = { 'content-type': 'application/json', vary: 'Origin' };
  if (req.origin) {
    if (allowed && !allowed.includes(req.origin)) return { status: 403, headers, body: { error: 'origin' } };
    headers['access-control-allow-origin'] = req.origin;
  }
  if (req.method === 'OPTIONS') {
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    headers['access-control-max-age'] = '600';
    return { status: 204, headers };
  }
  const r = parseApiRequest(req.method, req.url);
  if (!r.ok) return { status: r.error === 'not found' ? 404 : 400, headers, body: { error: r.error } };
  const q = r.value;
  try {
    switch (q.name) {
      case 'history':
        return {
          status: 200,
          headers,
          body: { points: await backend.history(q.site, q.deviceId, q.from, q.to) },
        };
      case 'alarms':
        return { status: 200, headers, body: { alarms: await backend.alarms(q.site, q.state, q.limit) } };
      case 'alarm-state': {
        if (writes === 'session')
          return { status: 200, headers, body: { id: q.id, state: q.state, shared: false } };
        const alarm = await backend.setAlarmState(q.site, q.id, q.state);
        return alarm
          ? { status: 200, headers, body: { alarm } }
          : { status: 404, headers, body: { error: 'alarm' } };
      }
    }
  } catch (err) {
    onError?.(err);
    return { status: 500, headers, body: { error: 'internal' } };
  }
}
