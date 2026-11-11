import { type AlarmState, type Result, SITES, type Site } from '@indoorkit/protocol';
import { z } from 'zod';

/** 一次查询最长的时间段（R4-08） */
export const HISTORY_MAX_MS = 3_600_000;
/** 一次查询最多返回的点数（R4-08） */
export const HISTORY_MAX_POINTS = 3600;

export type ApiRequest =
  | { name: 'history'; site: Site; deviceId: string; from: number; to: number }
  | { name: 'alarms'; site: Site; state: 'open' | 'all'; limit: number }
  | { name: 'alarm-state'; site: Site; id: string; state: AlarmState };

const site = z.enum(SITES);
const ms = z.coerce.number().int().nonnegative();
const historySchema = z
  .object({ site, deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), from: ms, to: ms })
  .refine((q) => q.to > q.from && q.to - q.from <= HISTORY_MAX_MS, {
    path: ['to'],
    message: `must be after from and at most ${HISTORY_MAX_MS} ms later`,
  });
const alarmsSchema = z.object({
  site,
  state: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const ACTIONS: Record<string, AlarmState> = { ack: 'acknowledged', resolve: 'resolved' };

/** REST 请求的路由和参数校验（R4-11）：外部输入，失败时写明出错的字段 */
export function parseApiRequest(method: string, rawUrl: string): Result<ApiRequest> {
  const url = new URL(rawUrl, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(url.searchParams);
  if (parts[0] !== 'api') return { ok: false, error: 'not found' };
  const [, siteName, resource, id, action] = parts;
  const check = <T>(schema: z.ZodType<T>, input: unknown): Result<T> => {
    const r = schema.safeParse(input);
    if (r.success) return { ok: true, value: r.data };
    const i = r.error.issues[0]!;
    return { ok: false, error: `${i.path.join('.')}: ${i.message}` };
  };
  if (method === 'GET' && resource === 'history' && parts.length === 3) {
    const r = check(historySchema, { ...query, site: siteName });
    return r.ok ? { ok: true, value: { name: 'history', ...r.value } } : r;
  }
  if (method === 'GET' && resource === 'alarms' && parts.length === 3) {
    const r = check(alarmsSchema, { ...query, site: siteName });
    return r.ok ? { ok: true, value: { name: 'alarms', ...r.value } } : r;
  }
  if (method === 'POST' && resource === 'alarms' && parts.length === 5 && id && action && ACTIONS[action]) {
    const r = check(z.object({ site, id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }), {
      site: siteName,
      id,
    });
    return r.ok ? { ok: true, value: { name: 'alarm-state', ...r.value, state: ACTIONS[action] } } : r;
  }
  return { ok: false, error: 'not found' };
}
