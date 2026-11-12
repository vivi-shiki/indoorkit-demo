import { GONE, type PositionReport, type Site, type StreamFrame, type TagState } from '@indoorkit/protocol';

export interface IngestOptions {
  /** 多久没有上报判为离线（毫秒） */
  offlineAfterMs: number;
}

/** 一次合帧的结果：要写进 Redis 的帧和状态 */
export interface Flush {
  site: Site;
  frames: StreamFrame[];
  /** 这一轮有变化的标签的最新状态 */
  state: Record<string, TagState>;
  offlineAdd: string[];
  offlineRemove: string[];
  /** 行驶结束、要从现在的状态里删掉的标签（R5-03） */
  removed: string[];
  /** 设备端在线状态有变化时才有 */
  source?: boolean;
}

interface SiteState {
  last: Map<string, { seq: number; ts: number; seenAt: number }>;
  pending: Map<string, TagState>;
  removed: Set<string>;
  offline: Set<string>;
  cameBack: Set<string>;
  source: boolean | undefined;
  sourceChanged: boolean;
}

/**
 * ingest 的内存状态，不碰网络，方便测试：
 * 收到的上报先去重、去乱序（R3-01），每次 flush 合成一帧（R2-05），并判断设备上下线（R3-02、R3-03）。
 */
export function createIngestState(options: IngestOptions) {
  const sites = new Map<Site, SiteState>();
  const siteOf = (site: Site) => {
    let s = sites.get(site);
    if (!s) {
      s = {
        last: new Map(),
        pending: new Map(),
        removed: new Set(),
        offline: new Set(),
        cameBack: new Set(),
        source: undefined,
        sourceChanged: false,
      };
      sites.set(site, s);
    }
    return s;
  };

  return {
    /**
     * 序号和设备时间都不比上一条新的是重复或乱序，丢弃。
     * 序号变小但时间更新，说明设备重启后计数归零，照常接收。
     */
    accept(site: Site, deviceId: string, report: PositionReport, now: number): 'accepted' | 'stale' {
      const s = siteOf(site);
      const prev = s.last.get(deviceId);
      if (prev && report.seq <= prev.seq && report.ts <= prev.ts) return 'stale';
      const tag: TagState = { id: deviceId, levelId: report.levelId, coord: report.coord };
      if (report.status) tag.status = report.status;
      s.pending.set(deviceId, tag);
      // 行驶结束：转发这一条让浏览器删掉，之后不再跟踪，也就不会判离线
      if (report.status === GONE) {
        s.last.delete(deviceId);
        s.offline.delete(deviceId);
        s.removed.add(deviceId);
        return 'accepted';
      }
      s.removed.delete(deviceId);
      s.last.set(deviceId, { seq: report.seq, ts: report.ts, seenAt: now });
      if (s.offline.delete(deviceId)) s.cameBack.add(deviceId);
      return 'accepted';
    },

    /** 重启后从 Redis 读回离线设备，它们再上报时能正确发出上线 */
    restoreOffline(site: Site, ids: string[]) {
      for (const id of ids) siteOf(site).offline.add(id);
    },

    source(site: Site, online: boolean) {
      const s = siteOf(site);
      if (s.source === online) return;
      s.source = online;
      s.sourceChanged = true;
    },

    flush(now: number): Flush[] {
      const out: Flush[] = [];
      for (const [site, s] of sites) {
        const wentOffline: string[] = [];
        for (const [id, last] of s.last) {
          if (!s.offline.has(id) && now - last.seenAt >= options.offlineAfterMs) {
            s.offline.add(id);
            wentOffline.push(id);
          }
        }
        const frames: StreamFrame[] = [];
        if (s.pending.size > 0)
          frames.push({ type: 'positions', site, time: now, positions: [...s.pending.values()] });
        const cameBack = [...s.cameBack];
        if (cameBack.length > 0 || wentOffline.length > 0) {
          frames.push({ type: 'device', site, time: now, online: cameBack, offline: wentOffline });
        }
        if (s.sourceChanged) frames.push({ type: 'source', site, time: now, online: s.source! });
        if (frames.length > 0) {
          const flush: Flush = {
            site,
            frames,
            state: Object.fromEntries([...s.pending].filter(([id]) => !s.removed.has(id))),
            offlineAdd: wentOffline,
            offlineRemove: cameBack,
            removed: [...s.removed],
          };
          if (s.sourceChanged) flush.source = s.source!;
          out.push(flush);
        }
        s.pending.clear();
        s.removed.clear();
        s.cameBack.clear();
        s.sourceChanged = false;
      }
      return out;
    },
  };
}
