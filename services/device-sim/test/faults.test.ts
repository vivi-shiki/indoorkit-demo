import { describe, expect, it } from 'vitest';
import { createFaults, type Outgoing } from '../src/faults';

const messages = (n: number): Outgoing[] =>
  Array.from({ length: n }, (_, i) => ({
    deviceId: `T${i}`,
    topic: `ik/v1/hospital/pos/T${i}`,
    payload: String(i),
  }));

describe('R3-04 fault injection', () => {
  it('passes everything through by default', () => {
    const f = createFaults({ seed: 's' });
    const list = messages(100);
    expect(f.apply(list)).toEqual(list);
  });

  it('drops, duplicates and reorders at about the configured rates', () => {
    const f = createFaults({ seed: 's', drop: 0.1, duplicate: 0.1, reorder: 0.1 });
    const out = f.apply(messages(10_000));
    const ids = out.map((m) => m.deviceId);
    const unique = new Set(ids).size;
    expect(10_000 - unique).toBeGreaterThan(800);
    expect(10_000 - unique).toBeLessThan(1200);
    expect(ids.length - unique).toBeGreaterThan(800);
    expect(ids.length - unique).toBeLessThan(1200);
    let swapped = 0;
    for (let i = 1; i < out.length; i++) if (Number(out[i]!.payload) < Number(out[i - 1]!.payload)) swapped++;
    expect(swapped).toBeGreaterThan(500);
  });

  it('silences a fixed share of devices until changed', () => {
    const f = createFaults({ seed: 's', silent: 0.2 });
    const a = new Set(f.apply(messages(1000)).map((m) => m.deviceId));
    const b = new Set(f.apply(messages(1000)).map((m) => m.deviceId));
    expect(a.size).toBeGreaterThan(750);
    expect(a.size).toBeLessThan(850);
    expect([...a].sort()).toEqual([...b].sort());
    f.update({ silent: 0 });
    expect(f.apply(messages(1000))).toHaveLength(1000);
    expect(f.current()).toMatchObject({ silent: 0 });
  });

  it('validates updates from the admin endpoint', () => {
    const f = createFaults({ seed: 's' });
    expect(() => f.update({ drop: 2 })).toThrow(/drop/);
  });
});
