# R5 停车场与博物馆接入后端

## 目标

停车场和博物馆的设备也走后端：车辆和设备的上报经过 MQTT → ingest → Redis / MongoDB → gateway 到浏览器，告警由 ingest 用 `domains/parking`、`domains/museum` 的规则计算。三个场景的全部页面都能在 Vivi 自己的电脑上（`pnpm backend:up` + `pnpm dev:live`）连后端运行。

分两步：**R5a 停车场**，**R5b 博物馆**。R5b 在 R5a 验收后按本文同样的粒度细化，再开始开发。

## 现状与取舍

两个演示和医院不同：浏览器里是**按种子生成的一整天**（昨天和今天），页面用「模拟时钟」从任意时刻查询状态，可以 10 倍、60 倍速快进，也可以用 `?t=09:30` 跳到某个时刻。告警页从 0 点起每分钟检查一次，运营统计用到昨天的记录。

后端只有一个「现在」。所以：

- **后端模式下时间就是真实时间**（场馆所在时区 `Asia/Tokyo` 的当天时刻），不能快进、不能跳时间；倍速按钮在后端模式下不显示。浏览器模拟保持原样，Pages 不变。
- **device-sim 按真实时钟播放同一份计划**：用和浏览器相同的种子 `minato` 生成计划，把计划里的时刻对到今天的日期。每天的计划相同，演示可以一直循环。
- **启动时补传**：device-sim 启动时先把昨天 0 点到现在的事件补传一遍（相当于设备把断网期间缓存的数据补上来），之后按真实时间发。ingest 按事件 id 去重，所以 device-sim 重启多少次结果都一样。这样打开页面时场内已经停着车，运营统计也有昨天可比。
- **页面基本不改**：停车场的页面都通过 `ParkingContext` 取数据（`day`、`alarms`、`clock`）。后端模式下换成另一套实现，回答同样的问题，数据来自后端。
- **后端模式在打开时决定**：和医院不同，停车场的数据是一整份场内状态，不在中途换到浏览器模拟。打开时 4 秒连不上后端就用浏览器模拟（和 R2-12 一样）；连上之后断线只显示「重连中」，恢复后断点续传。
- **简化**：现实中车位传感器只知道有没有车，车牌要靠入口的车牌识别和车位的 AI 相机对上。演示里假设每个车位的检测都能给出车牌（相当于全部车位有 AI 相机），车辆属性（车型、无障碍许可、合同）由入口控制器查合同库后随入场事件上报。

## 需求

### 协议（`@indoorkit/protocol`）

| 编号 | 需求 |
| --- | --- |
| R5-01 | 主题仍是 `ik/v1/{site}/{kind}/{deviceId}`。停车场用到：`pos`（行驶中的车辆位置，设备 id 是这次停车的 id，如 `20261112-V00042`）、`event`（入场、停车、离开、出场、充满电，QoS 1）、`dev`（设备状态和测量值：在线、离线、故障、呼叫中，CO 浓度）、`booking`（预约系统的当天预约和月租合同，保留消息）。新的上报都有 zod schema |
| R5-02 | 停车事件 `{ id, ts, kind, visitId, plate, bayId, deviceId, vehicle?, paid?, gateId? }`：`entry` 带 `vehicle`（车牌、车型、许可、合同），`exit` 带 `paid` 和 `gateId`。事件 id 是 `{日期}:{visitId}:{kind}`，跨天不重复 |
| R5-03 | 行驶中的车辆停下或出场时，device-sim 发一条 `status: "gone"` 的位置；ingest 把它从现在的位置里删掉，不当作离线 |
| R5-04 | WebSocket 新增 `site-event` 帧（带 seq，和别的帧一起补发）：停车场的停车事件和设备状态变化。快照新增 `day`：`{ dayStart, timeZone, parked, devices, reservations, contracts, events }`，`events` 是昨天 0 点起的全部停车事件 |

### ingest

| 编号 | 需求 |
| --- | --- |
| R5-05 | 按事件的时间顺序维护场内状态：停着的车（来自 `park`/`leave`，车辆属性来自同一 visitId 的 `entry`）、设备读数、预约（到场时刻由预约车牌的 `park` 事件算出）、上次检查之后的出场 |
| R5-06 | 用 `domains/parking` 的 `createAlarmEngine` 按「当天时刻」每分钟检查一次；补传时按事件时间逐分钟补检查，和浏览器模拟从 0 点逐分钟检查的结果相同。告警和医院一样写 MongoDB `alarms`、Redis 未处理告警，并推 `alarm` 帧 |
| R5-07 | 停车事件写进 Redis 列表 `ik:parking:day-events`（保留昨天 0 点以后的）和 MongoDB `events`；设备读数、预约、合同写进 `ik:parking:day`。服务按场景分目录：`services/ingest/src/{hospital,parking}` |

### gateway 与 REST

| 编号 | 需求 |
| --- | --- |
| R5-08 | 停车场的快照带上 R5-04 的 `day`；告警的确认、解决和医院共用 R4-10 的接口 |

### 浏览器

| 编号 | 需求 |
| --- | --- |
| R5-09 | `apps/playground/src/parking/adapters` 增加后端实现：`ParkingDay` 中页面用到的查询（`parkedAt`、`movingAt`、`deviceReadings`、`reservations`、`events`、`visits`、`visit`、`sessions`、`monthlyContracts`）由快照和之后的帧维护；时钟是真实的当天时刻；告警来自服务端 |
| R5-10 | 停车场 5 个页面（满空、车辆、预约、告警、运营统计）和 3D 页在 `?source=live` 下可用，标题栏显示数据源状态（R2-13 的同一个组件），不显示倍速 |
| R5-11 | 地址里没有后端时完全是原来的浏览器模拟；`pnpm e2e` 的停车场用例不受影响 |

## 不做

- 页面上新建的预约、法人手配、活动包场不写后端（仍只存在浏览器里）。
- 不做多个停车场；不做真实的车牌识别和合同库。
- 后端模式不能快进和跳时间。

## 测试

| 需求 | 测什么 | 在哪 |
| --- | --- | --- |
| R5-01..03 | 新主题、停车事件和设备读数的解析；`gone` 位置 | `packages/protocol/test/protocol.test.ts` |
| R5-02, R5-03 | device-sim 由计划生成的事件 id、补传范围、行驶结束时的 `gone` | `services/device-sim/test/parking.test.ts` |
| R5-05, R5-06 | 同一份计划，ingest 的场内状态和逐分钟告警与浏览器模拟（`createAlarmStore`）一致；事件乱序到达时按时间处理；重复事件只处理一次 | `services/ingest/test/parking.test.ts` |
| R5-04, R5-08 | 快照带 `day`；`site-event` 帧补发 | `services/gateway/test/session.test.ts` |
| R5-09 | 由快照和帧维护的 `ParkingDay` 和浏览器模拟在同一时刻回答相同 | `apps/playground/test/parking-live.test.ts` |
| R5-05..08 | 集成：启动后快照里有停着的车和昨天起的事件；告警出现在 `/alarms`；重启 device-sim 后事件和告警不重复 | `services/test/parking.spec.ts` |
| R5-10 | 浏览器：停车场 5 个页面和 3D 页在 `?source=live` 下打开、显示后端状态、有数据；告警来自后端 | `apps/playground/e2e-live/parking-live.spec.ts` |

## 验收

1. `pnpm verify`、`pnpm build`、`pnpm e2e` 全部通过（浏览器模拟不受影响）。
2. `pnpm backend:up` 后 `pnpm backend:test`、`pnpm e2e:live` 全部通过。
3. 人工：`pnpm dev:live` 打开停车场满空地图，场内有车、空车位数随时间变化；告警页有当天的告警，确认一条后刷新状态保持；运营统计有今天和昨天的对比。

## R5b 博物馆（待细化）

方向和停车场相同：温湿度、照度、CO₂ 传感器按真实时钟上报，带标签的来馆者位置，巡更打卡、藏品移动和安防事件作为事件；保存环境的曲线和累计光照量来自 MongoDB 的历史。R5a 验收后在这里写成和上面同样的需求表和测试表。
