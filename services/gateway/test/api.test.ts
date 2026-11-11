import { describe, expect, it } from 'vitest';
import { parseApiRequest } from '../src/api';

const parse = (method: string, url: string) => parseApiRequest(method, url);

describe('R4-08 history', () => {
  it('reads the device and the time range', () => {
    expect(parse('GET', '/api/hospital/history?deviceId=P0001&from=1000&to=61000')).toEqual({
      ok: true,
      value: { name: 'history', site: 'hospital', deviceId: 'P0001', from: 1000, to: 61_000 },
    });
  });

  it.each([
    ['/api/hospital/history?from=1&to=2', /deviceId/],
    ['/api/hospital/history?deviceId=P0001&from=5&to=1', /to/],
    ['/api/hospital/history?deviceId=P0001&from=0&to=3600001', /to/],
    ['/api/hospital/history?deviceId=P0001&from=x&to=1', /from/],
    ['/api/school/history?deviceId=P0001&from=0&to=1', /site/],
  ])('names the bad field in %s', (url, field) => {
    const r = parse('GET', url);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(field);
  });
});

describe('R4-09 alarm list', () => {
  it('defaults to the 100 newest open alarms', () => {
    expect(parse('GET', '/api/hospital/alarms')).toEqual({
      ok: true,
      value: { name: 'alarms', site: 'hospital', state: 'open', limit: 100 },
    });
    expect(parse('GET', '/api/hospital/alarms?state=all&limit=20')).toMatchObject({
      ok: true,
      value: { state: 'all', limit: 20 },
    });
    expect(parse('GET', '/api/hospital/alarms?limit=5000').ok).toBe(false);
  });
});

describe('R4-10 alarm actions', () => {
  it('maps ack and resolve to the new state', () => {
    expect(parse('POST', '/api/hospital/alarms/k1-alarm-3/ack')).toEqual({
      ok: true,
      value: { name: 'alarm-state', site: 'hospital', id: 'k1-alarm-3', state: 'acknowledged' },
    });
    expect(parse('POST', '/api/hospital/alarms/k1-alarm-3/resolve')).toMatchObject({
      ok: true,
      value: { state: 'resolved' },
    });
    expect(parse('GET', '/api/hospital/alarms/k1-alarm-3/ack').ok).toBe(false);
  });

  it('answers unknown paths with a failure, not a crash', () => {
    expect(parse('GET', '/api/hospital/nothing').ok).toBe(false);
    expect(parse('DELETE', '/api/hospital/alarms').ok).toBe(false);
  });
});
