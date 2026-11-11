import { seededRandom } from '@indoorkit/rtls-simulator';
import { z } from 'zod';

/** 一条要发出的 MQTT 消息 */
export interface Outgoing {
  deviceId: string;
  topic: string;
  payload: string;
}

const rate = z.number().min(0).max(1);
export const faultSchema = z.object({
  /** 丢包率 */
  drop: rate.optional(),
  /** 重复发送的比例 */
  duplicate: rate.optional(),
  /** 和前一条交换顺序的比例 */
  reorder: rate.optional(),
  /** 停止上报的设备比例：按设备 id 固定挑选 */
  silent: rate.optional(),
});
export type FaultSettings = Required<z.infer<typeof faultSchema>>;

/** 故障注入（R3-04）：同一个种子下结果可重复，方便测试 */
export function createFaults(initial: Partial<FaultSettings> & { seed: string }) {
  const { seed, ...rest } = initial;
  let settings: FaultSettings = { drop: 0, duplicate: 0, reorder: 0, silent: 0, ...rest };
  const random = seededRandom(seed);
  const silentScore = new Map<string, number>();
  const isSilent = (id: string) => {
    let s = silentScore.get(id);
    if (s === undefined) {
      s = seededRandom(`${seed}:${id}`)();
      silentScore.set(id, s);
    }
    return s < settings.silent;
  };
  return {
    current: (): FaultSettings => ({ ...settings }),
    /** 来自管理接口的修改：外部输入，校验后合并 */
    update(input: unknown) {
      const r = faultSchema.safeParse(input);
      if (!r.success) {
        const i = r.error.issues[0]!;
        throw new Error(`${i.path.join('.')}: ${i.message}`);
      }
      settings = { ...settings, ...r.data };
    },
    apply(messages: Outgoing[]): Outgoing[] {
      const { drop, duplicate, reorder, silent } = settings;
      if (drop === 0 && duplicate === 0 && reorder === 0 && silent === 0) return messages;
      const out: Outgoing[] = [];
      for (const m of messages) {
        if (silent > 0 && isSilent(m.deviceId)) continue;
        if (drop > 0 && random() < drop) continue;
        out.push(m);
        if (duplicate > 0 && random() < duplicate) out.push(m);
        if (reorder > 0 && out.length > 1 && random() < reorder) {
          const last = out.length - 1;
          [out[last - 1], out[last]] = [out[last]!, out[last - 1]!];
        }
      }
      return out;
    },
  };
}
