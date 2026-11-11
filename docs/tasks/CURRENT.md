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

# PROPOSALS

- No.1 Compose stack with MQTT → ingest → Redis Streams → WebSocket gateway, browser switching provider [CONFIRMED]

## No.1 Compose stack with MQTT → ingest → Redis Streams → WebSocket gateway, browser switching provider

### CODE CHANGE

See ADR 0008. Frames carry the Redis Stream id as their sequence number so the gateway resumes from any client cursor without per-client state.

### CONFIRMED

- The first restart test hung: Node's built-in WebSocket fires only `error` (no `close`) when the handshake is refused, and the gateway still accepted upgrades while shutting down. Fixed by treating `error` like `close` in live-client, adding a 10 s handshake timeout, and rejecting upgrades with 503 once shutdown starts. Unit tests added for both.
- `pnpm verify` 482 tests, `pnpm backend:test` 11/11, `pnpm e2e:live` 3/3.
- Shell-style env prefixes in scripts would break on Windows (Vivi's machine), so `dev:live` uses `vite --mode live` and `e2e:live` a separate Playwright config.
- The arm64 image (R1-09) cannot be built in this sandbox (no QEMU); it is a pure-JS bundle on a multi-arch base image and is verified by the arm64 CI build in R6.
