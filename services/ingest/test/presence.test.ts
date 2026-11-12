import { describe, expect, it } from 'vitest';
import { createIngestState } from '../src/state';

const r = (seq: number) => ({ seq, ts: seq * 1000, levelId: 'L1', coord: [0, 0] as [number, number] });

describe('R3-02 devices that stop reporting', () => {
  it('marks a tag offline after the silence limit and online again when it reports', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    s.accept('hospital', 'a', r(1), 0);
    s.accept('hospital', 'b', r(1), 0);
    s.flush(1000);
    s.accept('hospital', 'b', r(2), 9000);
    expect(s.flush(9500).flatMap((f) => f.frames.map((x) => x.type))).toEqual(['positions']);
    const [off] = s.flush(10_500);
    expect(off!.frames).toEqual([
      { type: 'device', site: 'hospital', time: 10_500, online: [], offline: ['a'] },
    ]);
    expect(off!.offlineAdd).toEqual(['a']);
    // 已经报过离线的不再重复
    expect(s.flush(11_000)).toEqual([]);
    s.accept('hospital', 'a', r(2), 12_000);
    const [on] = s.flush(12_500);
    expect(on!.frames.map((f) => f.type)).toEqual(['positions', 'device']);
    expect(on!.frames[1]).toMatchObject({ online: ['a'], offline: [] });
    expect(on!.offlineRemove).toEqual(['a']);
  });
});

describe('R3-02 after an ingest restart', () => {
  it('reports a device that was offline before the restart as back online', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    s.restoreOffline('hospital', ['a']);
    s.accept('hospital', 'a', r(1), 0);
    const [f] = s.flush(500);
    expect(f!.frames[1]).toMatchObject({ type: 'device', online: ['a'] });
    expect(f!.offlineRemove).toEqual(['a']);
  });
});

describe('R3-03 the simulator going away', () => {
  it('turns the last will into a source frame, once per change', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    s.source('hospital', false);
    s.source('hospital', false);
    const [f] = s.flush(1000);
    expect(f!.frames).toEqual([{ type: 'source', site: 'hospital', time: 1000, online: false }]);
    expect(f!.source).toBe(false);
    s.source('hospital', true);
    expect(s.flush(2000)[0]!.frames).toEqual([
      { type: 'source', site: 'hospital', time: 2000, online: true },
    ]);
  });
});

describe('R5-03 tracks that end', () => {
  it('forwards the gone report once, drops the tag from the state and never calls it offline', () => {
    const s = createIngestState({ offlineAfterMs: 10_000 });
    s.accept('parking', 'v1', r(1), 0);
    s.flush(1000);
    s.accept('parking', 'v1', { ...r(2), status: 'gone' }, 2000);
    const [f] = s.flush(2500);
    expect(f!.frames).toEqual([
      {
        type: 'positions',
        site: 'parking',
        time: 2500,
        positions: [{ ...r(2), id: 'v1', status: 'gone' }].map(({ seq: _, ts: __, ...t }) => t),
      },
    ]);
    expect(f!.state).toEqual({});
    expect(f!.removed).toEqual(['v1']);
    expect(s.flush(20_000)).toEqual([]);
  });
});
