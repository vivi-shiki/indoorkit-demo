import type { PositionReport } from '@indoorkit/protocol';
import { describe, expect, it } from 'vitest';
import { createIngestState } from '../src/state';

const report = (seq: number, ts: number, x = seq): PositionReport => ({
  seq,
  ts,
  levelId: 'L1',
  coord: [x, 0],
});

describe('R2-05 one frame per flush', () => {
  it('keeps only the latest position of each tag within a flush', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    s.accept('hospital', 'a', report(1, 100), 0);
    s.accept('hospital', 'a', report(2, 200), 0);
    s.accept('hospital', 'b', { ...report(1, 100), status: 'sos' }, 0);
    const [flush] = s.flush(1000);
    expect(flush!.site).toBe('hospital');
    expect(flush!.frames).toEqual([
      {
        type: 'positions',
        site: 'hospital',
        time: 1000,
        positions: [
          { id: 'a', levelId: 'L1', coord: [2, 0] },
          { id: 'b', levelId: 'L1', coord: [1, 0], status: 'sos' },
        ],
      },
    ]);
    expect(Object.keys(flush!.state)).toEqual(['a', 'b']);
  });

  it('writes nothing when nothing changed', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    expect(s.flush(1000)).toEqual([]);
    s.accept('hospital', 'a', report(1, 100), 0);
    s.flush(1000);
    expect(s.flush(2000)).toEqual([]);
  });

  it('keeps sites apart', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    s.accept('hospital', 'a', report(1, 100), 0);
    s.accept('parking', 'a', report(1, 100), 0);
    expect(
      s
        .flush(1000)
        .map((f) => f.site)
        .sort(),
    ).toEqual(['hospital', 'parking']);
  });
});

describe('R3-01 duplicates and out-of-order reports', () => {
  it('drops a report whose sequence number and time are not newer', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    expect(s.accept('hospital', 'a', report(5, 500), 0)).toBe('accepted');
    expect(s.accept('hospital', 'a', report(5, 500), 0)).toBe('stale');
    expect(s.accept('hospital', 'a', report(4, 400), 0)).toBe('stale');
    expect(s.accept('hospital', 'a', report(6, 600), 0)).toBe('accepted');
    const [flush] = s.flush(1000);
    expect(flush!.frames[0]).toMatchObject({ positions: [{ id: 'a', coord: [6, 0] }] });
  });

  it('accepts a restarted device whose counter went back but whose clock moved on', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    s.accept('hospital', 'a', report(900, 500), 0);
    expect(s.accept('hospital', 'a', report(0, 9000), 0)).toBe('accepted');
    expect(s.accept('hospital', 'a', report(1, 10_000), 0)).toBe('accepted');
  });
});
