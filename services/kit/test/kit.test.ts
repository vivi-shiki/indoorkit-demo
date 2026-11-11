import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetrics, envNumber, type HttpServer, loadConfig, startHttp } from '../src/index';

describe('R1-06 configuration', () => {
  const schema = z.object({ MQTT_URL: z.url(), HTTP_PORT: envNumber(8081), TAGS: envNumber(2000) });

  it('reads and converts environment variables, with defaults', () => {
    expect(loadConfig(schema, { MQTT_URL: 'mqtt://broker:1883', TAGS: '50' })).toEqual({
      MQTT_URL: 'mqtt://broker:1883',
      HTTP_PORT: 8081,
      TAGS: 50,
    });
  });

  it('names every missing or invalid variable', () => {
    expect(() => loadConfig(schema, { TAGS: 'many' })).toThrow(/MQTT_URL[\s\S]*TAGS/);
  });
});

describe('R3-11 metrics', () => {
  it('renders counters and gauges in the Prometheus text format', () => {
    const m = createMetrics('ik_ingest');
    m.inc('messages_total');
    m.inc('messages_total', 2);
    m.set('connections', 4);
    const text = m.render();
    expect(text).toContain('# TYPE ik_ingest_messages_total counter\nik_ingest_messages_total 3');
    expect(text).toContain('# TYPE ik_ingest_connections gauge\nik_ingest_connections 4');
    expect(m.get('messages_total')).toBe(3);
  });
});

describe('R1-05 health endpoint', () => {
  let server: HttpServer | undefined;
  afterEach(async () => {
    await server?.close();
  });

  it('answers 200 when healthy, 503 otherwise, and serves metrics', async () => {
    let healthy = true;
    const metrics = createMetrics('ik_test');
    metrics.inc('x_total');
    server = await startHttp({ port: 0, health: async () => ({ ok: healthy, redis: healthy }), metrics });
    const base = `http://127.0.0.1:${server.port}`;
    let res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redis: true });
    healthy = false;
    res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(503);
    res = await fetch(`${base}/metrics`);
    expect(await res.text()).toContain('ik_test_x_total 1');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('passes other requests to the service handler', async () => {
    server = await startHttp({
      port: 0,
      health: async () => ({ ok: true }),
      metrics: createMetrics('ik_test'),
      handle: (req, res) => {
        if (req.url !== '/faults') return false;
        res.writeHead(204).end();
        return true;
      },
    });
    expect((await fetch(`http://127.0.0.1:${server.port}/faults`, { method: 'POST' })).status).toBe(204);
  });
});
