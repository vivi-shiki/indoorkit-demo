# R4 MongoDB 历史与服务端告警

## 目标

Redis 管「现在」，MongoDB 管「过去」。告警不再在浏览器里算，改由 ingest 用 `domains/hospital` 的同一套规则计算；医院的设备、告警、热力、轨迹页面都能在后端模式下使用。

## 需求

| 编号 | 需求 |
| --- | --- |
| R4-01 | MongoDB `telemetry` 时序集合：timeField `ts`，metaField `{ site, deviceId, kind }`，7 天过期。ingest 每秒批量 `insertMany`，不逐条写 |
| R4-02 | `alarms` 集合：告警的发生、确认、解决时间和处理人；`(site, alarmId)` 唯一 |
| R4-03 | ingest 引用 `domains/hospital` 的告警规则和引擎计算告警，结果写 `alarms`、Redis `ik:{site}:alarms:open`，并作为 `alarm` 帧推送 |
| R4-04 | 告警帧不受背压影响，一条不丢：客户端发现 `alarm` 序号断档时请求补发 |
| R4-05 | device-sim 发设备事件（如呼叫按钮）用 QoS 1，ingest 按事件 id 去重 |
| R4-06 | gateway REST：`GET /api/{site}/history?deviceId&from&to`（轨迹）、`GET /api/{site}/alarms?state`、`POST /api/{site}/alarms/{id}/ack`。参数用 zod 校验 |
| R4-07 | 公开环境里「确认告警」只影响自己的浏览器会话，不改共享数据（R6 打开这个开关） |
| R4-08 | 医院四个页面（设备、告警、热力、轨迹）在后端模式下可用，轨迹回放来自 MongoDB |

## 测试与验收

- 单元：告警规则在服务端和浏览器得到相同结果（同一输入）；去重；REST 参数校验。
- 集成（`pnpm backend:test`）：写入后能按时间查到轨迹；告警发生 → 确认 → 状态变化；重启 ingest 不产生重复告警。
- 浏览器（`pnpm e2e:live`）：四个页面在 `?source=live` 下的现有断言全部通过。
- 验收：以上全部通过；`pnpm e2e` 不受影响。
