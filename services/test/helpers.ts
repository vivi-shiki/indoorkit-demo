import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseServerFrame, type ServerFrame } from '@indoorkit/protocol';

/** 集成测试对着 pnpm backend:up 起来的 compose 环境跑（docs/backend/README.md） */
const FILE = join(import.meta.dirname, '../../deploy/compose.yaml');
export const GATEWAY = process.env.INDOORKIT_GATEWAY ?? 'http://localhost:8080';
export const WS_URL = `${GATEWAY.replace(/^http/, 'ws')}/ws`;

export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-f', FILE, ...args], { encoding: 'utf8' });
}

/** 容器内部的 HTTP（device-sim、ingest 不对宿主机开放端口） */
export function inside(
  service: string,
  port: number,
  path: string,
  body?: unknown,
): { status: number; text: string } {
  const args = ['exec', '-T', service, 'wget', '-S', '-qO-', `http://127.0.0.1:${port}${path}`];
  if (body !== undefined)
    args.splice(4, 0, '--header=content-type: application/json', `--post-data=${JSON.stringify(body)}`);
  try {
    const text = execFileSync('docker', ['compose', '-f', FILE, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 200, text };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    const m = /HTTP\/1\.1 (\d+)/.exec(e.stderr ?? '');
    return { status: m ? Number(m[1]) : 0, text: e.stdout ?? '' };
  }
}

export async function waitFor<T>(
  what: string,
  check: () => T | Promise<T>,
  timeoutMs = 20_000,
): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/** 一个直接说协议的 WebSocket 客户端，记录收到的所有帧 */
export function rawClient(subscribe: object = { type: 'subscribe', site: 'hospital' }) {
  const frames: ServerFrame[] = [];
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify(subscribe));
  ws.onmessage = (e) => {
    const r = parseServerFrame(String(e.data));
    if (!r.ok) throw new Error(r.error);
    frames.push(r.value);
    if (r.value.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: r.value.t }));
  };
  return { frames, close: () => ws.close() };
}
