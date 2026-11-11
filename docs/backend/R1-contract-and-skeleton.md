# R1 消息契约与服务骨架

## 目标

后端的三个服务、一个共享的消息契约包，以及一条命令就能起来的本地环境。后面所有需求都在这个骨架上加功能。

## 需求

| 编号 | 需求 |
| --- | --- |
| R1-01 | 新包 `packages/protocol`（`@indoorkit/protocol`）：MQTT 主题名、设备上报、WebSocket 帧的类型和 zod 校验都只在这里定义一次。前端和三个服务都从这里引用 |
| R1-02 | 主题格式 `ik/v1/{site}/{kind}/{deviceId}`。`site` 只能是 `hospital`、`parking`、`museum`；`deviceId` 只含字母、数字、`-`、`_`。构造主题的函数对非法参数抛出写明字段的错误；解析收到的主题时非法输入返回带原因的失败结果（它来自设备，是外部输入） |
| R1-03 | 解析设备上报和 WebSocket 帧时，非法消息返回带原因的失败结果，不抛异常（外部输入，见 coding.md「Fail loudly, but validate input」） |
| R1-04 | 三个服务放在 `services/`：`device-sim`（设备模拟）、`ingest`（接入）、`gateway`（网关）。每个服务都是纯 TypeScript，可以引用 `@indoorkit/protocol`、`domains/*`、`tools/*-simulator`、`@indoorkit/rtls` 和 `@indoorkit/imdf`，不能引用 `apps/`、React、MapLibre 和 `@indoorkit/core` |
| R1-05 | 每个服务都有 HTTP `GET /healthz`：依赖（MQTT、Redis）都连上时返回 200 和 `{ ok: true, ... }`，否则 503 |
| R1-06 | 服务的配置全部来自环境变量，在启动时用 zod 校验，缺失或非法时报出变量名并以非 0 退出 |
| R1-07 | 收到 SIGTERM 时按顺序关闭：先停止接收新的连接和消息，再关闭 MQTT、Redis，最后退出，10 秒内完成 |
| R1-08 | `deploy/compose.yaml` 起 Mosquitto 2、Redis 7、MongoDB 7 和三个服务；每个容器都有健康检查，服务等依赖健康后再启动 |
| R1-09 | 三个服务共用一个多阶段 `deploy/Dockerfile`：构建阶段用 esbuild 把每个服务打成一个 JS 文件，运行阶段只有 Node 22 Alpine 和这个文件。镜像同时支持 amd64 和 arm64（Oracle A1 是 arm64） |
| R1-10 | 只对宿主机开放 gateway 的 8080（WebSocket 和 REST）；MQTT 1883、Redis、MongoDB 只在 compose 网络内部，调试时用 `deploy/compose.debug.yaml` 才对外开放 |
| R1-11 | `test/layers.test.ts` 加上 R1-04 的导入规则 |

## 不做

- 不做认证和多租户：公开部署时的保护放在 R6（Origin 白名单、限流）。
- 不改 `sdk/`。WebSocket 客户端先放在本仓库的 `packages/live-client`，稳定后再考虑搬进 SDK。

## 测试

| 编号 | 测试 | 位置 |
| --- | --- | --- |
| R1-01..03 | 主题构造/解析的往返；非法 site、deviceId 报错并写明字段；合法和非法的上报、帧的解析结果 | `packages/protocol/test/protocol.test.ts` |
| R1-06 | 缺少环境变量时 `loadConfig` 报出变量名 | `services/kit/test/kit.test.ts` |
| R1-04, R1-11 | 服务不引用 apps、React、MapLibre、`@indoorkit/core` | `test/layers.test.ts` |
| R1-05, R1-08 | compose 起来后三个 `/healthz` 都是 200；停掉 Redis 后 ingest 和 gateway 变 503，恢复后回到 200 | `services/test/compose.spec.ts`（`pnpm backend:test`） |
| R1-07 | `docker compose stop` 每个服务都在 10 秒内退出，退出码 0 | 同上 |

## 验收方式

1. `pnpm verify` 通过（包含新的单元测试和分层测试）。
2. `pnpm backend:up` 后 `docker compose -f deploy/compose.yaml ps` 显示 6 个容器都是 `healthy`。
3. `pnpm backend:test` 通过。
4. `docker buildx build --platform linux/arm64` 能构建出镜像（验证 R1-09）。
