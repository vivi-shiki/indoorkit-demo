import { describe, expect, it } from 'vitest';
import { createParkingLedger, type LedgerEvent } from '../src/ledger';
import type { Vehicle } from '../src/model';

const vehicle: Vehicle = {
  plate: 'p1',
  vehicleClass: 'standard',
  permit: false,
  contract: { kind: 'hourly' },
};
const e = (kind: LedgerEvent['kind'], time: number, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
  time,
  kind,
  visitId: 'v1',
  plate: 'p1',
  bayId: 'b1',
  deviceId: `d-${kind}`,
  ...(kind === 'entry' ? { vehicle } : {}),
  ...extra,
});

describe('R5-05 parking ledger', () => {
  it('builds a visit from its events and answers parked, exits and sessions', () => {
    const l = createParkingLedger();
    for (const x of [
      e('entry', 0),
      e('park', 10),
      e('leave', 100),
      e('exit', 110, { paid: false, gateId: 'g' }),
    ])
      expect(l.apply(x)).toBe(true);
    expect(l.parkedAt(5)).toEqual([]);
    expect(l.parkedAt(50)).toEqual([{ bayId: 'b1', vehicle, enteredAt: 0, parkedAt: 10 }]);
    expect(l.parkedAt(100)).toEqual([]);
    expect(l.exits(100, 110)).toEqual([{ vehicle, time: 110, paid: false, gateId: 'g' }]);
    expect(l.exits(110, 200)).toEqual([]);
    expect(l.visit('v1')).toMatchObject({
      payment: 'cash',
      entryCamera: 'd-entry',
      exitCamera: 'd-exit',
      exitGate: 'g',
    });
    expect(l.sessions(50)[0]).toMatchObject({ leftAt: null, exitedAt: null, parkedAt: 10 });
    expect(l.events(0, 101).map((x) => x.kind)).toEqual(['entry', 'park', 'leave']);
  });

  it('counts a repeated event once and waits for the entry of an early event', () => {
    const l = createParkingLedger();
    expect(l.apply(e('park', 10))).toBe(true);
    expect(l.parkedAt(50)).toEqual([]);
    l.apply(e('entry', 0));
    expect(l.apply(e('park', 10))).toBe(false);
    expect(l.parkedAt(50)).toHaveLength(1);
    expect(l.visit('v1').leftAt).toBe(Infinity);
  });

  it('shows the full charge only once it happened', () => {
    const l = createParkingLedger();
    for (const x of [e('entry', 0), e('park', 10), e('charged', 60)]) l.apply(x);
    expect(l.parkedAt(30)[0]).not.toHaveProperty('chargedAt');
    expect(l.parkedAt(70)[0]).toMatchObject({ chargedAt: 60 });
  });
});
