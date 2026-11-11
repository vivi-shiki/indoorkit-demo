# R2 医院人员位置走后端链路

## 目标

医院「人员定位」页的实时位置来自后端：device-sim 发出每个标签的位置，经过 Mosquitto、ingest、Redis、gateway，到浏览器里显示。后端不可用时页面自动退回浏览器模拟器，并告诉用户。

## 需求

### 后端

| 编号 | 需求 |
| --- | --- |
| R2-01 | device-sim 用现有的 `tools/rtls-simulator` 跑医院，种子 `playground`、2000 人，和人员定位页默认的名册一致：同一个编号是同一个人 |
| R2-02 | device-sim 每秒为每个标签发一条 `ik/v1/hospital/pos/{tagId}`，QoS 0，内容 `{ seq, ts, levelId, coord, status? }`；`seq` 是这个标签自己的递增序号，`ts` 是设备时间（毫秒） |
| R2-03 | device-sim 连接时设遗嘱消息：`ik/v1/hospital/source/sim` 保留消息 `online`，断线时 broker 发 `offline` |
| R2-04 | ingest 用共享订阅 `$share/ingest/ik/v1/+/pos/+` 接收位置，校验失败的消息计数后丢弃 |
| R2-05 | ingest 每 1 秒把这一秒内变化的位置合成一帧：写 Redis `ik:{site}:state`（Hash，标签 → 最新位置）和 `ik:{site}:frames`（Stream，最多保留约 300 帧，即 5 分钟） |
| R2-06 | gateway 在 `/ws` 提供 WebSocket。客户端发 `{ type: 'subscribe', site, after? }`；没有 `after` 时先发快照（Hash 里全部标签的最新位置）再发增量帧 |
| R2-07 | 每一帧带 `seq`（Redis Stream 的 id），客户端用它判断先后 |

### 前端

| 编号 | 需求 |
| --- | --- |
| R2-08 | 新包 `packages/live-client`：`createLiveProvider({ url, site })` 实现现有的 `DataProvider`，另有 `status()` 和 `onStatus(listener)`。不依赖 React、MapLibre 和 DOM 以外的浏览器接口；`WebSocket` 可以注入，方便在 Node 里测试 |
| R2-09 | 快照和增量帧都转换成 `PositionBatch`；快照之后的第一批包含全部标签 |
| R2-10 | `dispose()` 关闭 socket、清掉所有定时器，之后不再发出任何批次；leak-bench 继续通过 |
| R2-11 | 数据源选择：`?source=live` 只用后端，`?source=sim` 只用模拟器，默认 `auto`。后端地址取 `?live=` 或构建时的 `VITE_LIVE_URL`；两者都没有时 `auto` 等于 `sim`（Pages 现在就是这样，不会多出任何请求） |
| R2-12 | `auto` 模式：后端 4 秒内没有连上或者连接断开超过 4 秒，就启动浏览器模拟器继续显示；后端恢复并收到快照后停掉模拟器，换回后端数据 |
| R2-13 | 人员定位页标题栏显示数据源状态：数据源（后端/模拟）、连接状态（已连接/重连中/不可用）、往返延迟；中、英、日三语。沿用现有的标题栏样式 |
| R2-14 | 新的测试钩子 `window.__vivi.liveStatus()` 返回 `{ source, state, latencyMs }` |
| R2-15 | 后端模式下标签数固定为后端的 2000，页面上的数量选择不可用并说明原因 |

## 不做

- 人员定位以外的医院页面（设备、告警、热力、轨迹）还用模拟器，R4 再接。
- 不做跳时刻和倍速：后端模式显示服务器时钟。

## 测试

| 编号 | 测试 | 位置 |
| --- | --- | --- |
| R2-02, R2-03 | device-sim 发出的主题和内容能被 protocol 解析；遗嘱主题正确 | `services/device-sim/test/publish.test.ts` |
| R2-04, R2-05 | ingest 的合帧逻辑：一秒内同一标签多条只留最新；非法消息计数 | `services/ingest/test/frames.test.ts` |
| R2-06, R2-07 | gateway 的订阅逻辑：无 `after` 先快照后增量（用假的 Redis 读取接口） | `services/gateway/test/session.test.ts` |
| R2-08..10 | 用假的 WebSocket：快照转批次、增量转批次、`dispose` 后没有批次也没有定时器 | `packages/live-client/test/provider.test.ts` |
| R2-11, R2-12 | 数据源选择和自动退回：假时钟下 4 秒后切到模拟、收到快照后切回 | `apps/playground/test/live-source.test.ts` |
| R2-01..07 | 真实链路：WebSocket 客户端订阅医院，5 秒内收到快照（2000 个标签）和至少 3 帧增量 | `services/test/chain.spec.ts`（`pnpm backend:test`） |
| R2-12..14 | 浏览器：`?source=live` 打开人员定位，`liveStatus()` 为后端已连接、标签在动；停掉 gateway 后切到模拟并提示；启动后切回 | `apps/playground/e2e-live/tracking-live.spec.ts`（`pnpm e2e:live`） |

## 验收方式

1. `pnpm verify`、`pnpm build`、`pnpm e2e` 通过（原有功能不受影响，Pages 上默认还是模拟器）。
2. `pnpm backend:up` 后 `pnpm backend:test` 和 `pnpm e2e:live` 通过。
3. 人工：`pnpm dev:live` 打开人员定位页，标题栏显示「后端 · 已连接」，标签在动；`docker compose stop gateway` 后几秒显示「后端不可用 · 模拟数据」，`start` 后切回。
