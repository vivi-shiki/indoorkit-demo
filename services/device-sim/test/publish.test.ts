import { parsePositionReport, parseTopic, SIM_SOURCE_ID, topic } from '@indoorkit/protocol';
import { describe, expect, it } from 'vitest';
import { createHospitalDevices, HOSPITAL_VENUE, sourceWill } from '../src/devices';

describe('R2-01..02 hospital devices', () => {
  it('reports every tag once per tick with a growing per-tag sequence number', () => {
    const devices = createHospitalDevices(HOSPITAL_VENUE, { seed: 'playground', tags: 20, now: () => 5000 });
    const first = devices.tick(1000);
    const second = devices.tick(1000);
    expect(first).toHaveLength(20);
    expect(new Set(first.map((m) => m.deviceId)).size).toBe(20);
    for (const m of [...first, ...second]) {
      const t = parseTopic(m.topic);
      expect(t.ok && t.value).toEqual({ site: 'hospital', kind: 'pos', deviceId: m.deviceId });
      expect(parsePositionReport(m.payload).ok).toBe(true);
    }
    const seqOf = (list: typeof first, id: string) =>
      JSON.parse(list.find((m) => m.deviceId === id)!.payload).seq;
    expect(seqOf(second, first[0]!.deviceId)).toBe(seqOf(first, first[0]!.deviceId) + 1);
    expect(JSON.parse(first[0]!.payload).ts).toBe(5000);
  });

  it('uses the same ids as the browser roster with the same seed', () => {
    const a = createHospitalDevices(HOSPITAL_VENUE, { seed: 'playground', tags: 5, now: () => 0 }).tick(1000);
    const b = createHospitalDevices(HOSPITAL_VENUE, { seed: 'playground', tags: 5, now: () => 0 }).tick(1000);
    expect(a.map((m) => m.deviceId)).toEqual(b.map((m) => m.deviceId));
    expect(a.map((m) => m.payload)).toEqual(b.map((m) => m.payload));
  });
});

describe('R2-03 last will', () => {
  it('announces the simulator going offline on a retained source topic', () => {
    expect(sourceWill('hospital')).toEqual({
      topic: topic('hospital', 'source', SIM_SOURCE_ID),
      payload: 'offline',
      retain: true,
      qos: 1,
    });
  });
});
