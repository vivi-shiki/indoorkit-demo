# R4 MongoDB 历史与服务端告警

## 目标

Redis 管「现在」，MongoDB 管「过去」。告警不再在浏览器里算，改由 ingest 用 `domains/hospital` 的同一套规则计算并推送；医院的五个页面（人员定位、设备定位、轨迹回放、告警中心、热力图）在后端模式下都能用。

## 现状与取舍

浏览器模拟时，每个页面各自生成一批人和设备：定位和热力图是种子 `playground` 的 2000 人，设备页是种子 `assets` 的 400 台设备，告警页是种子 `alerts` 的 600 人加 200 台设备，轨迹页在浏览器里离线跑一小时的模拟。

后端只有一家医院、一批人和设备，所有页面看到的是同一个「现在」。所以：

- **后端模式下五个页面共用一批对象**：2000 人（`P0001`～`P2000`）加 400 台设备（`A0001`～`A0400`），种子 `playground`。名册的编号只和序号有关，和种子无关，所以名字、角色、科室和浏览器里一致。
- **浏览器模拟保持原样**：没有后端地址时每个页面还是自己的那一批，Pages 上的行为不变。

## 需求

### 设备与存储

| 编号 | 需求 |
| --- | --- |
| R4-01 | device-sim 同时模拟 2000 人和 400 台设备（`HOSPITAL_TAGS`、`HOSPITAL_ASSETS` 写在 `@indoorkit/protocol`）。设备的运行状态（使用中、待机、充电、离线等）随位置一起上报 |
| R4-02 | ingest 把每秒合成的位置批量写入 MongoDB 时序集合 `telemetry`：timeField `ts`，metaField `{ site, deviceId }`，字段 `levelId`、`coord`、`status`；7 天后自动过期。用 `insertMany` 不逐条写 |
| R4-03 | 设备状态变化（求助按下、设备离线等）作为事件 `ik/v1/{site}/event/{deviceId}` 以 QoS 1 上报，带唯一的事件 id。ingest 按事件 id 去重（同一 id 只处理一次，包括 ingest 重启后），写入 `events` 集合 |

### 服务端告警

| 编号 | 需求 |
| --- | --- |
| R4-04 | 告警页的三个预设围栏（ICU 禁入、出口防盗、病房停留）从页面移到 `domains/hospital`，浏览器和 ingest 用同一份定义；围栏名称仍是文案键，由浏览器翻译 |
| R4-05 | ingest 用 `domains/hospital` 的 `createAlarmEngine`、`DEPARTMENT_RULES` 和预设围栏检查每秒的位置，产生的告警写 MongoDB `alarms`（`(site, alarmId)` 唯一）、Redis `ik:{site}:alarms:open`，并作为 `alarm` 帧写进 Stream |
| R4-06 | `alarm` 帧不受背压影响，断线续传时和其他帧一样补发；网关重启期间产生的告警，客户端恢复后一条不少 |
| R4-07 | 订阅时的快照带上未处理的告警（最多最近 200 条），新打开的告警页立刻有内容 |

### REST 接口（gateway）

| 编号 | 需求 |
| --- | --- |
| R4-08 | `GET /api/{site}/history?deviceId=&from=&to=`：一个对象在时间段内的轨迹，按时间排序；时间段最长 1 小时，最多 3600 个点 |
| R4-09 | `GET /api/{site}/alarms?state=open|all&limit=`：告警列表，新的在前 |
| R4-10 | `POST /api/{site}/alarms/{id}/ack` 和 `/resolve`：改告警状态并推送 `alarm-state` 帧。环境变量 `ALARM_WRITES=session` 时（公开部署）不改共享数据，只返回成功，状态留在浏览器里 |
| R4-11 | 所有参数用 zod 校验，错误返回 400 和出错的字段名；带 CORS，允许的来源和 WebSocket 相同 |

### 前端

| 编号 | 需求 |
| --- | --- |
| R4-12 | 后端模式下五个页面使用后端那一批对象：定位和热力图只取人员，设备页只取设备，告警页取全部 |
| R4-13 | 告警页在后端模式下不在浏览器里算告警，列表、地图标记和弹窗来自 `alarm` 帧；确认、解决调用 REST |
| R4-14 | 轨迹回放在后端模式下从 `/history` 取最近一小时，回放控件和停留点照常工作 |
| R4-15 | 每个页面都显示 R2 的数据源状态，后端不可用时退回各自原来的浏览器模拟 |

## 不做

- 不做账号和多人协作：「谁处理的」只记一个固定的演示用户名。
- 不做历史数据的统计报表；热力图仍按浏览器收到的实时位置累计。

## 测试

| 编号 | 测试 | 位置 |
| --- | --- | --- |
| R4-01 | 设备模拟同时上报人员和设备，设备带状态 | `services/device-sim/test/publish.test.ts` |
| R4-03 | 事件 id 去重：重复的 id 只处理一次 | `services/ingest/test/events.test.ts` |
| R4-04, R4-05 | 同一批位置在服务端引擎和浏览器引擎得到相同的告警 | `services/ingest/test/alarms.test.ts` |
| R4-08..11 | 参数校验与错误信息 | `services/gateway/test/api.test.ts` |
| R4-12 | 按对象种类过滤批次 | `apps/playground/test/live-source.test.ts` |
| R4-02, R4-08 | 集成：几秒后能从 `/history` 查到一个人的轨迹，点在时间段内且有序 | `services/test/history.spec.ts` |
| R4-05..07, R4-10 | 集成：告警出现在帧、`/alarms` 和快照里；确认后状态变化；重启网关后客户端收到的告警 id 与 MongoDB 一致 | `services/test/alarms.spec.ts` |
| R4-03 | 集成：注入重复事件后 `events` 集合里没有重复 id | 同上 |
| R4-12..15 | 浏览器：五个页面在 `?source=live` 下打开、显示后端状态、有数据；告警页的告警来自后端；轨迹页能回放 | `apps/playground/e2e-live/hospital-live.spec.ts` |

## 验收方式

1. `pnpm verify`、`pnpm build`、`pnpm e2e` 通过（浏览器模拟的行为不变）。
2. `pnpm backend:up` 后 `pnpm backend:test`、`pnpm e2e:live` 通过。
3. 人工：`pnpm dev:live` 依次打开医院五个页面，标题栏都是「后端 · 已连接」；告警页里确认一条告警，刷新后状态保持（本地 `ALARM_WRITES` 默认写库）。
