import type { ServerFrame, Site, TagState } from '@indoorkit/protocol';

/** 带序号的帧：Stream 里读出来的条目 */
export type SeqFrame = Extract<ServerFrame, { seq: string; time: number }>;

/** gateway 读 Redis 的全部方式；测试用内存实现 */
export interface FrameStore {
  /** Stream 里最后一帧的序号；还没有帧时为 null */
  lastSeq(site: Site): Promise<string | null>;
  snapshot(site: Site): Promise<{ positions: TagState[]; offline: string[]; source: boolean | undefined }>;
  /** after 之后的所有帧；after 之后的帧已经被裁掉时返回 'gone' */
  range(site: Site, after: string): Promise<SeqFrame[] | 'gone'>;
}
