# !!!INVESTIGATE!!!

# PROBLEM DESCRIPTION

那就按方案1

1、对每一个需求写详细的需求文档
2、根据这个需求文档写测试和验收方式
3、根据测试进行开发
4、开发后验收

查找目标云服务文档，先是在本地跑通这一链路，我抽时间注册vps，而后再交给你来部署上线

（方案 1：Oracle Cloud 永久免费 ARM 虚拟机 + k3s，按「IndoorKit 实时数据后端规划」实现 device-sim → Mosquitto → ingest → Redis + MongoDB → gateway → 浏览器。）

# UPDATES

# TEST [CONFIRMED]

Requirements, tests and acceptance per requirement: docs/backend/R1..R6 (Chinese, as Vivi asked). This task covers R1 (contract and skeleton), R2 (hospital position stream) and R3 (reliability); R4–R6 follow.

- Unit (in `pnpm verify`): protocol, service kit, device-sim devices and faults, ingest state, gateway session and backpressure, live-client provider and reliability, playground source switching, layer rules for services.
- Integration (`pnpm backend:test`, against `pnpm backend:up`): all six containers healthy; 503 while Redis is down and recovery; graceful stop within 10 s with exit code 0; snapshot of 2000 tags plus a frame per second; gateway restart bridged by resume with one snapshot only; silent tags announced offline and back online; duplicate/reorder dropped by ingest; last will announced; metrics present.
- Browser (`pnpm e2e:live`): tracking page live → fallback to the simulator when the gateway stops → back to live; restart bridged by resend; default page opens no socket.
- Existing `pnpm build` and `pnpm e2e` keep passing; Pages keeps using the simulator.

## R4 (2026-11-11)

- Unit: protocol alarm frames and event reports; device-sim asset events; ingest events de-duplication and server/browser alarm parity; gateway API parsing, REST handler (400 with field, 404, CORS, `ALARM_WRITES=session`), snapshot alarms and alarm frames under backpressure; playground kind filtering, alarm forwarding and REST address.
- Integration: `services/test/history.spec.ts` (ordered track in range, asset track, 400 over an hour, empty for unknown) and `alarms.spec.ts` (open list newest first and in the snapshot; alarms raised around ingest and gateway restarts all reach the client and match MongoDB; ack/resolve change state, push frames and leave the open list).
- Browser: `e2e-live/hospital-live.spec.ts` (assets, occupancy, trail and alerts in live mode).

## R5a (2026-11-12)

- Unit: protocol parking reports and `site-event`; device-sim plan playback and backfill; domain ledger; ingest alarm parity with the browser simulation, duplicates once, silent rebuild; gateway snapshot `day`; playground `parking-backend.test.ts` (the day built from device-sim → ingest output answers like the simulation, frames after the snapshot, moving vehicles, server alarms, auto fallback).
- Integration: `services/test/parking.spec.ts` (snapshot day since yesterday 0:00 with parked cars; alarms raised once; device-sim and ingest restarts add no duplicates).
- Browser: `e2e-live/parking-live.spec.ts` (five pages and the twin on the backend at Tokyo time, no speed chips, alarms acknowledged through REST and kept after reload).

# PROPOSALS

- No.1 Compose stack with MQTT → ingest → Redis Streams → WebSocket gateway, browser switching provider [CONFIRMED]
- No.2 R4: MongoDB history, alarms computed in ingest, REST in the gateway, five hospital pages on the backend [CONFIRMED]
- No.3 R5a: parking on the backend, one ledger shared by ingest and the browser [CONFIRMED]

## No.1 Compose stack with MQTT → ingest → Redis Streams → WebSocket gateway, browser switching provider

### CODE CHANGE

See ADR 0008. Frames carry the Redis Stream id as their sequence number so the gateway resumes from any client cursor without per-client state.

### CONFIRMED

- The first restart test hung: Node's built-in WebSocket fires only `error` (no `close`) when the handshake is refused, and the gateway still accepted upgrades while shutting down. Fixed by treating `error` like `close` in live-client, adding a 10 s handshake timeout, and rejecting upgrades with 503 once shutdown starts. Unit tests added for both.
- `pnpm verify` 482 tests, `pnpm backend:test` 11/11, `pnpm e2e:live` 3/3.
- Shell-style env prefixes in scripts would break on Windows (Vivi's machine), so `dev:live` uses `vite --mode live` and `e2e:live` a separate Playwright config.
- The arm64 image (R1-09) cannot be built in this sandbox (no QEMU); it is a pure-JS bundle on a multi-arch base image and is verified by the arm64 CI build in R6.

## No.2 R4: MongoDB history, alarms computed in ingest, REST in the gateway, five hospital pages on the backend

### CODE CHANGE

- Preset fences moved to `domains/hospital` (`presetFences`) so ingest and the alerts page share them; ingest imports `@indoorkit/plugins/venue-index` only (new SDK subpath export, IndoorKit d381358).
- ingest writes telemetry (time series, 7-day TTL), alarms and events to MongoDB, keeps open alarms in `ik:{site}:alarms:open` and appends `alarm` frames. Alarm ids carry a per-start prefix.
- gateway: snapshot carries up to 200 open alarms; `/api/{site}/history`, `/alarms`, `/alarms/{id}/ack|resolve`; the only write is the alarm state (ADR 0008).
- Playground: `createHospitalSource` filters backend batches by kind; alerts page takes server alarms in live mode and computes locally only on fallback; trail page fetches the last hour from `/history` and falls back to the simulation; every page shows the source status.

### CONFIRMED

- The integration test for asset history found that device-sim never passed `ASSETS` to the simulation, so the backend had no assets. Fixed; the R2 snapshot test now expects people plus assets.
- `pnpm verify` 516 tests, `pnpm backend:test` 19/19, `pnpm e2e:live` 7/7.

## Side fix: 3D twin e2e timing out on CI (separate commit)

- From ec50f42 (docs only) CI failed with the twin specs timing out; the passing run before already used 2.0 of 2.5 minutes. Reproduced locally by limiting to 2 CPUs (`taskset -c 0,1`, CI settings, no retries): 6 twin tests failed. Two twin tests rendering on SwiftShader at the same time starve each other, and the 390px inspection timed out creating its browser context because the 30 s default timeout applied to fixtures.
- Fix: a `twin` Playwright project for the twin specs (including the leak-bench one) with `workers: 1` and a project timeout of 150 s that covers fixtures.
- Confirmed: full suite on 2 CPUs, no retries, 170/170; slowest twin test 1.9 min.

## No.3 R5a: parking on the backend, one ledger shared by ingest and the browser

### CODE CHANGE

- `domains/parking` gains `createParkingLedger` (events → visits, parked cars, exits, sessions); ingest and the browser both use it.
- device-sim plays the seeded plan at real time in Asia/Tokyo and backfills from yesterday 0:00 on start; ingest checks alarms minute by minute on data time and rebuilds silently on restart and at midnight.
- gateway snapshot carries `day`; the browser keeps a live `ParkingDayView`, server alarms and a wall clock behind the same `ParkingContext`, decided when the page opens.

### CONFIRMED

- The first stack run had only 884 of about 5300 backfilled events: ingest subscribed after device-sim published, and Mosquitto queues only 1000 QoS 1 messages per client. Fixed with a fixed client id and persistent session for ingest, device-sim waiting for ingest in Compose, and `max_queued_messages 100000`.
- The browser simulation knows ahead whether a car still parked will leave unpaid; the backend learns it at exit. Parity tests compare `paid` for exited cars only.
- `pnpm verify` 543 tests, `pnpm backend:test` 23/23, `pnpm e2e:live` 13/13, `pnpm e2e` 170/170.
