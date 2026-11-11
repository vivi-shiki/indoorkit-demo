import type { AlarmRecord } from '@indoorkit/protocol';
import { describe, expect, it } from 'vitest';
import { type ApiBackend, handleApi } from '../src/rest';

const alarm = (id: string, state: AlarmRecord['state'] = 'open'): AlarmRecord => ({
  id,
  time: 1,
  level: 'high',
  state,
});

function fakeBackend() {
  const calls: string[] = [];
  const backend: ApiBackend = {
    async history(site, deviceId, from, to) {
      calls.push(`history ${site} ${deviceId} ${from} ${to}`);
      return [{ ts: from, levelId: 'L1', coord: [0, 0] }];
    },
    async alarms(site, state, limit) {
      calls.push(`alarms ${site} ${state} ${limit}`);
      return [alarm('a')];
    },
    async setAlarmState(site, id, state) {
      calls.push(`set ${site} ${id} ${state}`);
      return id === 'missing' ? null : alarm(id, state);
    },
  };
  return { backend, calls };
}

const call = (
  method: string,
  url: string,
  options: { origin?: string; allowed?: string[]; writes?: 'shared' | 'session' } = {},
) => {
  const { backend, calls } = fakeBackend();
  return handleApi(
    { method, url, origin: options.origin },
    { backend, allowed: options.allowed, writes: options.writes ?? 'shared' },
  ).then((res) => ({ res, calls }));
};

describe('R4-08..11 REST handler', () => {
  it('ignores paths outside /api', async () => {
    const { res } = await call('GET', '/healthz');
    expect(res).toBeNull();
  });

  it('R4-08 returns the history points', async () => {
    const { res, calls } = await call('GET', '/api/hospital/history?deviceId=P0001&from=0&to=1000');
    expect(res?.status).toBe(200);
    expect(res?.body).toEqual({ points: [{ ts: 0, levelId: 'L1', coord: [0, 0] }] });
    expect(calls).toEqual(['history hospital P0001 0 1000']);
  });

  it('R4-09 lists alarms with defaults', async () => {
    const { res, calls } = await call('GET', '/api/hospital/alarms');
    expect(res?.body).toEqual({ alarms: [alarm('a')] });
    expect(calls).toEqual(['alarms hospital open 100']);
  });

  it('R4-10 changes the shared state by default', async () => {
    const { res, calls } = await call('POST', '/api/hospital/alarms/x-1/ack');
    expect(res?.status).toBe(200);
    expect(res?.body).toEqual({ alarm: alarm('x-1', 'acknowledged') });
    expect(calls).toEqual(['set hospital x-1 acknowledged']);
  });

  it('R4-10 answers 404 for an unknown alarm', async () => {
    const { res } = await call('POST', '/api/hospital/alarms/missing/resolve');
    expect(res?.status).toBe(404);
  });

  it('R4-10 with ALARM_WRITES=session succeeds without touching shared data', async () => {
    const { res, calls } = await call('POST', '/api/hospital/alarms/x-1/resolve', { writes: 'session' });
    expect(res?.status).toBe(200);
    expect(res?.body).toEqual({ id: 'x-1', state: 'resolved', shared: false });
    expect(calls).toEqual([]);
  });

  it('R4-11 answers 400 with the field for bad parameters', async () => {
    const { res, calls } = await call('GET', '/api/hospital/history?deviceId=P0001&from=0&to=99999999');
    expect(res?.status).toBe(400);
    expect(res?.body).toMatchObject({ error: expect.stringContaining('to') });
    expect(calls).toEqual([]);
  });

  it('R4-11 answers 404 for unknown routes under /api', async () => {
    const { res } = await call('DELETE', '/api/hospital/alarms');
    expect(res?.status).toBe(404);
  });

  it('R4-11 allows a listed origin and answers the preflight', async () => {
    const allowed = ['https://a.example'];
    const { res } = await call('OPTIONS', '/api/hospital/alarms/x/ack', {
      origin: 'https://a.example',
      allowed,
    });
    expect(res?.status).toBe(204);
    expect(res?.headers['access-control-allow-origin']).toBe('https://a.example');
    expect(res?.headers['access-control-allow-methods']).toContain('POST');
  });

  it('R4-11 rejects other origins', async () => {
    const { res, calls } = await call('GET', '/api/hospital/alarms', {
      origin: 'https://evil.example',
      allowed: ['https://a.example'],
    });
    expect(res?.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('R4-11 allows any origin when none are configured', async () => {
    const { res } = await call('GET', '/api/hospital/alarms', { origin: 'http://localhost:5173' });
    expect(res?.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('answers 500 without details when the backend fails', async () => {
    const { backend } = fakeBackend();
    backend.alarms = async () => {
      throw new Error('mongo down');
    };
    const res = await handleApi(
      { method: 'GET', url: '/api/hospital/alarms' },
      { backend, writes: 'shared' },
    );
    expect(res?.status).toBe(500);
    expect(JSON.stringify(res?.body)).not.toContain('mongo');
  });
});
