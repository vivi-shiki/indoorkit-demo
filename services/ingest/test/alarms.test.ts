import {
  createAlarmEngine,
  createHospital,
  DEPARTMENT_RULES,
  presetFences,
  subjectsOf,
} from '@indoorkit/hospital';
import { createVenueIndex } from '@indoorkit/plugins/venue-index';
import type { PositionBatch } from '@indoorkit/rtls';
import { createRoster, createSimulation } from '@indoorkit/rtls-simulator';
import { describe, expect, it } from 'vitest';
import { createHospitalAlarms, HOSPITAL_VENUE } from '../src/hospital/alarms';

describe('R4-04 preset fences', () => {
  it('defines the three demo fences once, on real levels, with message keys as names', () => {
    const hospital = createHospital(HOSPITAL_VENUE, createVenueIndex(HOSPITAL_VENUE));
    const fences = presetFences(HOSPITAL_VENUE, hospital);
    expect(fences.map((f) => [f.id, f.label, f.rule])).toEqual([
      ['icu-restricted', 'fence.icu', 'forbid'],
      ['exit-antitheft', 'fence.exit', 'forbid'],
      ['ward-dwell', 'fence.wardDwell', 'dwell'],
    ]);
    const levels = new Set(HOSPITAL_VENUE.levels.map((l) => l.id));
    expect(fences.every((f) => levels.has(f.levelId))).toBe(true);
  });
});

describe('R4-05 alarms on the server', () => {
  it('raises the same alarms as the browser engine for the same positions', () => {
    const people = 300;
    const assets = 100;
    const sim = createSimulation(HOSPITAL_VENUE, { seed: 'playground', tags: people, assets });
    const server = createHospitalAlarms(HOSPITAL_VENUE, { people, assets, idPrefix: 'boot1' });
    const hospital = createHospital(HOSPITAL_VENUE, createVenueIndex(HOSPITAL_VENUE));
    const browser = createAlarmEngine({
      hospital,
      subjects: subjectsOf(createRoster(HOSPITAL_VENUE, { people, assets })),
      departmentRules: DEPARTMENT_RULES,
    });
    for (const f of presetFences(HOSPITAL_VENUE, hospital)) browser.addFence(f);
    const fromServer = [];
    const fromBrowser = [];
    for (let t = 1; t <= 900; t++) {
      const batch: PositionBatch = { time: t * 1000, positions: sim.step(1000) };
      fromServer.push(...server.check(batch));
      fromBrowser.push(...browser.check(batch));
    }
    expect(fromServer.length).toBeGreaterThan(0);
    expect(fromServer.map(({ id, state, ...a }) => a)).toEqual(fromBrowser.map(({ id, ...a }) => a));
    expect(fromServer.every((a) => a.id.startsWith('boot1-') && a.state === 'open')).toBe(true);
  });
});
