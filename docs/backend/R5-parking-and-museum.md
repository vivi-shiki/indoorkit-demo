# R5 停车场与博物馆接入后端

## 目标

停车场和博物馆的设备也走后端：车位传感器、闸机、车辆定位，温湿度/照度传感器、来馆者标签、巡更。两个场景的告警和统计移到 ingest。

## 需求

| 编号 | 需求 |
| --- | --- |
| R5-01 | device-sim 用 `tools/parking-simulator` 和 `tools/museum-simulator` 的同一天数据按真实时钟循环，按设备发上报；主题沿用 `ik/v1/{site}/{kind}/{deviceId}`，`kind` 新增 `bay`、`gate`、`env` 等，全部在 `@indoorkit/protocol` 定义 |
| R5-02 | ingest 用 `domains/parking`、`domains/museum` 的规则算三级告警和统计 |
| R5-03 | 两个场景的 adapters 各有模拟和后端两个实现，页面不改 |
| R5-04 | 三个场景互不引用的分层测试仍然通过；服务里按场景分目录 |

## 测试与验收

- 单元：新主题和上报的解析；两个场景的告警在服务端和浏览器结果一致。
- 浏览器（`pnpm e2e:live`）：停车场 5 页、博物馆各页在 `?source=live` 下的现有断言通过。
- 验收：三个场景全部页面在后端模式下可用；`pnpm e2e` 不受影响。
