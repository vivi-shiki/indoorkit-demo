# ADR 0008: Live data backend

Status: accepted

The demo has only ever had browser simulators: every page creates its own data in a Worker. To show a real IoT data path, the hospital simulator is moved behind a backend that runs locally with Docker Compose and later on a single k3s node on an Oracle Cloud Always Free Ampere A1 machine (2 OCPU, 12 GB). Requirements, tests and acceptance steps are in [docs/backend](../backend/README.md).

## Shape

```
device-sim ──MQTT──▶ Mosquitto ──▶ ingest ──▶ Redis ──▶ gateway ──WebSocket──▶ browser
```

- `services/device-sim` turns `tools/rtls-simulator` into devices that publish one MQTT message per tag per second on `ik/v1/{site}/pos/{tagId}`, with fault injection.
- `services/ingest` is the only writer. It validates, drops duplicate and out-of-order reports by (sequence number, device time), merges one frame per second and writes the latest state (Hash), the offline set and a capped Stream of frames to Redis.
- `services/gateway` only reads device data. A browser subscribes to a site and gets a snapshot, then the Stream; on reconnect it sends the last sequence number and gets the missed frames, or a new snapshot if they were trimmed. It pings every 15 s, skips position frames for slow clients and catches them up with a snapshot, and says `bye` before shutting down. It also serves `/api` (history and alarms from MongoDB and Redis, R4). Its one write is a user's action on an alarm (acknowledge, resolve): it updates MongoDB and the open-alarm hash and appends an `alarm-state` frame, so every viewer sees it. Device data stays ingest's alone. A public deployment sets `ALARM_WRITES=session` so visitors cannot change the shared state.
- Alarms are computed in ingest with the same `domains/hospital` engine, rules and preset fences as the browser, so both give the same alarms for the same positions.
- `packages/protocol` holds topic names, Redis keys and zod schemas for reports and frames, used by all three services and the browser.
- `packages/live-client` implements the SDK's `DataProvider` over the gateway, with backoff and jitter, resume, heartbeat and duplicate dropping. It lives in this repository until it settles; it uses nothing beyond the SDK's public types, so it can move into IndoorKit unchanged.

The sequence number of a frame is its Redis Stream id, so the gateway can resume from any client cursor without keeping per-client state.

## Decisions

- **Ingest and gateway are separate processes** so that devices and viewers scale independently, and so that the gateway can be restarted (or rolled) without losing data.
- **Positions are latest-wins, state changes are never dropped.** Position reports are QoS 0 and may be skipped under backpressure; device online/offline and source frames are always delivered.
- **The browser decides the source.** `?source=auto|live|sim` and `?live=` (or the build-time `VITE_LIVE_URL`) choose between backend and simulator. Without a backend address the app behaves exactly as before and opens no socket, which is what GitHub Pages does until the public backend exists. In `auto` the page switches to the simulator after 4 s without a synced backend and back once it is synced again; the simulator Worker is created only while needed.
- **Services are bundled with esbuild** into one file each and run on `node:22-alpine`; one Dockerfile serves all three. The workspace keeps TypeScript sources as entry points, so nothing changes for the existing packages.
- **Integration tests run against the real Compose stack** (`pnpm backend:test`, `pnpm e2e:live`) instead of Testcontainers, because the same stack is what developers run and what CI starts.
- **MongoDB is part of the stack from the start** but is first written in R4 (history and server-side alarms).

## Layers

Services may import `@indoorkit/protocol`, the service kit, `domains/*`, the simulators, the venue generator and the SDK's data packages (`imdf`, `rtls`); never `apps/`, React, MapLibre, `@indoorkit/core` or `@indoorkit/plugins`. `packages/protocol` and `packages/live-client` use no Node, UI or map code. `test/layers.test.ts` checks both.
