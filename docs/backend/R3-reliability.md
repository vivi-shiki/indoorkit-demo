# R3 可靠性

## 目标

断线、重复、乱序、丢包和慢客户端都有明确的处理方式，并且能在演示时当场制造故障、看到系统自己恢复。

原则：**位置只要最新的**，丢了等下一条；**状态变化（上线/离线）和告警一条都不能丢**。

## 需求

### 设备 → ingest

| 编号 | 需求 |
| --- | --- |
| R3-01 | ingest 按标签记住收到的最大 `seq`，`seq` 不大于它的位置直接丢弃（处理重复和乱序），计入 `stale` 计数 |
| R3-02 | 某个标签 10 秒没有上报就判为离线；之后再收到上报判为上线。上线和离线作为 `device` 帧写进 Stream，快照里也带离线列表 |
| R3-03 | 收到 `ik/v1/{site}/source/sim` 为 `offline`（device-sim 断线的遗嘱）时，发一条 `source` 帧告诉浏览器设备端断开了 |
| R3-04 | device-sim 支持故障注入：丢包率、重复率、乱序率、让指定比例的标签停止上报、整个断开 MQTT 若干秒。启动时用环境变量设，运行中用内部的 `POST /faults` 改 |

### gateway → 浏览器

| 编号 | 需求 |
| --- | --- |
| R3-05 | 断点续传：客户端重连时带上最后收到的 `seq`（`after`）。Stream 里还有这之后的帧就补发；已经被裁掉（超过约 5 分钟）就重新发快照 |
| R3-06 | 心跳：gateway 每 15 秒发 `{ type: 'ping', t }`，客户端回 `pong`，gateway 据此算往返延迟并在下一次 `ping` 里带回。客户端 35 秒收不到任何消息就主动断开重连（处理半开连接）；gateway 对 2 次没回 pong 的连接直接断开 |
| R3-07 | 客户端重连用指数退避加随机抖动：1 秒、2 秒、4 秒……封顶 30 秒，连上并收到快照或补发后归零 |
| R3-08 | 客户端按 `seq` 丢弃重复和过期的帧 |
| R3-09 | 背压：某个客户端的发送缓冲超过 1 MB 时不再给它发位置帧，只记下「欠了」；缓冲降到 256 KB 以下后补一个快照。`device`、`source` 帧不跳过 |
| R3-10 | gateway 收到 SIGTERM 时给每个客户端发 `{ type: 'bye', reason: 'restart' }` 再关闭，客户端收到后立刻重连，不等退避 |
| R3-11 | 各服务在 `/metrics` 输出 Prometheus 文本格式的计数：收到/丢弃/过期的消息数、帧数、连接数、补发数、快照数、背压跳过数 |
| R3-12 | 前端状态栏显示已补发和已丢弃的帧数；测试钩子 `liveStatus()` 带上这些数字 |

## 不做

- 不引入 toxiproxy：网络故障用 device-sim 的故障注入和直接重启容器来制造，够演示也够测试。
- 告警的可靠送达（QoS 1、按消息 id 去重）放在 R4，和告警一起做。

## 测试

| 编号 | 测试 | 位置 |
| --- | --- | --- |
| R3-01 | 重复、乱序的序号被丢弃并计数 | `services/ingest/test/frames.test.ts` |
| R3-02, R3-03 | 假时钟下 10 秒无上报判离线，再上报判上线；遗嘱 `offline` 产生 `source` 帧 | `services/ingest/test/presence.test.ts` |
| R3-04 | 故障注入的比例（固定种子下的统计）、停止上报、断开 | `services/device-sim/test/faults.test.ts` |
| R3-05 | `after` 在 Stream 里时补发其后的帧；被裁掉时发快照 | `services/gateway/test/session.test.ts` |
| R3-06, R3-07, R3-08, R3-10 | 假 WebSocket + 假时钟：心跳超时重连、退避序列和封顶、重复帧丢弃、`bye` 立即重连 | `packages/live-client/test/reliability.test.ts` |
| R3-09 | 发送缓冲超限时跳过位置帧，降下来后补快照，`device` 帧不跳过 | `services/gateway/test/backpressure.test.ts` |
| R3-05, R3-10 | 真实链路：订阅中重启 gateway，客户端收到 `bye`、重连并通过补发接上，序号不断 | `services/test/chain.spec.ts` |
| R3-02, R3-04 | 真实链路：让 10% 标签停止上报，12 秒内收到这些标签的离线帧 | 同上 |
| R3-11 | 三个服务的 `/metrics` 有约定的指标名 | 同上 |

## 验收方式

1. `pnpm verify` 通过。
2. `pnpm backend:test` 通过，其中包含重启 gateway 和故障注入的场景。
3. 人工演示：页面打开时执行 `docker compose restart gateway`，状态栏短暂显示「重连中」后恢复，补发计数增加，地图没有跳回模拟数据。
