import { describe, expect, it } from 'vitest';
import { type EventStore, handleEvent } from '../src/events';

describe('R4-03 device events', () => {
  it('saves each event id once, however often it arrives', async () => {
    const claimed = new Set<string>();
    const saved: unknown[] = [];
    const store: EventStore = {
      claim: async (site, id) => {
        const key = `${site}:${id}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      save: async (doc) => {
        saved.push(doc);
      },
    };
    const e = { id: 'A0001:7', ts: 5, type: 'status', status: 'offline' };
    expect(await handleEvent(store, 'hospital', 'A0001', e)).toBe('new');
    expect(await handleEvent(store, 'hospital', 'A0001', e)).toBe('duplicate');
    expect(await handleEvent(store, 'parking', 'A0001', e)).toBe('new');
    expect(saved).toEqual([
      { ...e, site: 'hospital', deviceId: 'A0001' },
      { ...e, site: 'parking', deviceId: 'A0001' },
    ]);
  });
});
