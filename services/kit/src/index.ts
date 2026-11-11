/**
 * 三个后端服务共用的小工具：环境变量配置、/healthz 和 /metrics、按顺序关闭（docs/backend/R1）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/** 数字型环境变量：可以不设，用默认值 */
export const envNumber = (fallback: number) => z.coerce.number().finite().default(fallback);
/** 0～1 之间的比例 */
export const envRate = (fallback = 0) => z.coerce.number().min(0).max(1).default(fallback);

/** 启动时校验环境变量；失败时一次列出所有出错的变量名 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  env: Record<string, string | undefined>,
): z.infer<S> {
  const r = schema.safeParse(env);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`invalid configuration:\n${lines.join('\n')}`);
}

export interface Metrics {
  inc(name: string, by?: number): void;
  set(name: string, value: number): void;
  get(name: string): number;
  render(): string;
}

/** Prometheus 文本格式的计数器（名字以 _total 结尾）和仪表 */
export function createMetrics(prefix: string): Metrics {
  const values = new Map<string, number>();
  return {
    inc(name, by = 1) {
      values.set(name, (values.get(name) ?? 0) + by);
    },
    set(name, value) {
      values.set(name, value);
    },
    get: (name) => values.get(name) ?? 0,
    render() {
      return [...values]
        .map(([name, v]) => {
          const full = `${prefix}_${name}`;
          return `# TYPE ${full} ${name.endsWith('_total') ? 'counter' : 'gauge'}\n${full} ${v}`;
        })
        .join('\n')
        .concat('\n');
    },
  };
}

export interface HttpOptions {
  port: number;
  health: () => Promise<{ ok: boolean } & Record<string, unknown>>;
  metrics: Metrics;
  /** 服务自己的路由；处理了返回 true */
  handle?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

export interface HttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startHttp(options: HttpOptions): Promise<HttpServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      options.health().then(
        (h) => res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(h)),
        (err: unknown) =>
          res
            .writeHead(503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: String(err) })),
      );
      return;
    }
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(options.metrics.render());
      return;
    }
    if (options.handle?.(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** 读完请求体并解析 JSON；格式错误时返回 undefined */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** SIGTERM / SIGINT 时按顺序关闭，超过 timeoutMs 强制退出（R1-07） */
export function onShutdown(close: () => Promise<void>, log: (msg: string) => void, timeoutMs = 10_000) {
  let closing = false;
  const handler = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal} received, shutting down`);
    const timer = setTimeout(() => {
      log('shutdown timed out');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    close().then(
      () => process.exit(0),
      (err: unknown) => {
        log(`shutdown failed: ${String(err)}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

/** 一行一个 JSON 的日志，容器和 k8s 都好收集 */
export function createLogger(service: string) {
  return (msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), service, msg, ...extra }));
}
