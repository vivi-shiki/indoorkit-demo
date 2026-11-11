import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { compose, GATEWAY, inside, waitFor } from './helpers';

const health = (service: 'device-sim' | 'ingest' | 'gateway') =>
  service === 'gateway'
    ? fetch(`${GATEWAY}/healthz`).then(
        (r) => r.status,
        () => 0,
      )
    : Promise.resolve(inside(service, service === 'device-sim' ? 8081 : 8082, '/healthz').status);

afterAll(() => {
  compose('up', '-d', '--wait');
});

describe('R1-05, R1-08 the local backend', () => {
  it('starts every service healthy', async () => {
    for (const s of ['device-sim', 'ingest', 'gateway'] as const) expect(await health(s), s).toBe(200);
    const ps = compose('ps', '--format', '{{.Service}} {{.Health}}');
    expect(ps.trim().split('\n').sort()).toEqual(
      ['device-sim', 'gateway', 'ingest', 'mongo', 'mosquitto', 'redis'].map((s) => `${s} healthy`),
    );
  });

  it('reports 503 while Redis is down and recovers by itself', async () => {
    compose('stop', 'redis');
    try {
      await waitFor('gateway 503', async () => (await health('gateway')) === 503);
      await waitFor('ingest 503', async () => (await health('ingest')) === 503);
    } finally {
      compose('start', 'redis');
    }
    await waitFor('gateway 200', async () => (await health('gateway')) === 200, 30_000);
    await waitFor('ingest 200', async () => (await health('ingest')) === 200, 30_000);
  });
});

describe('R1-07 graceful shutdown', () => {
  it.each(['device-sim', 'ingest', 'gateway'])('%s exits with 0 within 10 seconds', (service) => {
    const started = Date.now();
    compose('stop', '-t', '15', service);
    const took = Date.now() - started;
    const id = compose('ps', '-a', '-q', service).trim();
    const code = execFileSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', id], {
      encoding: 'utf8',
    }).trim();
    compose('start', service);
    expect(code).toBe('0');
    expect(took).toBeLessThan(10_000);
  });
});
