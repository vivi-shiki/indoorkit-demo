# 实时数据后端

把浏览器里的模拟器搬到后端，组成一条真实的数据链路：

```
device-sim ──MQTT──▶ Mosquitto ──▶ ingest ──▶ Redis（现在） ──▶ gateway ──WebSocket──▶ 浏览器
                                      └──────▶ MongoDB（历史）◀── gateway REST
```

- 设备只认 MQTT，浏览器只认 gateway。ingest 是唯一的写入方，gateway 只读，两边各自扩容。
- 浏览器连不上后端时自动退回原来的浏览器模拟器，Pages 上的 demo 任何时候都能看。
- 部署目标是 Oracle Cloud 永久免费的 Ampere A1 虚拟机（2 OCPU、12 GB）上的单节点 k3s。

规划原文见「IndoorKit 实时数据后端规划」文档；架构决定见 [ADR 0008](../adr/0008-live-backend.md)。

## 需求文档

每份需求文档都有四部分：需求（带编号）、不做的事、测试（每个需求编号对应的测试）、验收方式。测试名里带需求编号，例如 `R2-04`，方便从失败的测试找回需求。

| 编号 | 需求 | 状态 |
| --- | --- | --- |
| [R1](R1-contract-and-skeleton.md) | 消息契约与服务骨架，`docker compose up` 全部健康 | 完成 |
| [R2](R2-hospital-position-stream.md) | 医院人员位置走后端链路，前端自动选择数据源并显示连接状态 | 完成 |
| [R3](R3-reliability.md) | 可靠性：序号、去重、断线续传、心跳、背压、设备离线、故障注入 | 完成 |
| [R4](R4-storage-and-alarms.md) | MongoDB 历史、服务端告警、REST 查询，医院五个页面都能连后端 | 完成 |
| [R5](R5-parking-and-museum.md) | 停车场和博物馆接入后端 | R5a 停车场完成；R5b 博物馆待细化 |
| [R6](R6-k3s-on-oracle.md) | k3s 清单、本地集群验证、Oracle 免费机部署手册 | 待开发 |

## 本地运行

需要 Docker Desktop（或 Docker Engine + Compose v2）和 Node 22，Windows、macOS、Linux 命令相同。

```bash
pnpm install
pnpm backend:up      # 构建镜像并起 Mosquitto、Redis、MongoDB 和三个服务，等全部健康
pnpm dev:live        # 前端开发服务器，连 ws://localhost:8080/ws
```

打开 <http://localhost:5173/indoorkit-demo/#/hospital/tracking>，标题栏显示「数据源：后端 · 已连接 · 延迟」，2000 个标签在动。

可以当场试的故障：

| 操作 | 页面上看到的 |
| --- | --- |
| `docker compose -f deploy/compose.yaml restart gateway` | 短暂「重连中」，接着「补发 N」，不会退回模拟数据 |
| `docker compose -f deploy/compose.yaml stop gateway` | 约 4 秒后「后端不可用，正在使用模拟数据」；`start` 后自动切回 |
| `docker compose -f deploy/compose.yaml stop device-sim` | 「设备端已断开」，标签停在最后的位置 |

故障注入（device-sim 不对宿主机开放端口，在容器里调用）：

```bash
# 10% 的标签停止上报：约 10 秒后它们被判离线
docker compose -f deploy/compose.yaml exec device-sim wget -qO- --header "content-type: application/json" --post-data '{"silent":0.1}' http://127.0.0.1:8081/faults
# 丢包、重复、乱序；disconnectMs 让模拟器断开 MQTT 若干毫秒（触发遗嘱）
docker compose -f deploy/compose.yaml exec device-sim wget -qO- --header "content-type: application/json" --post-data '{"drop":0.05,"duplicate":0.1,"reorder":0.1,"disconnectMs":5000}' http://127.0.0.1:8081/faults
```

各服务的指标：`http://localhost:8080/metrics`（gateway），其余服务在容器内的 `/metrics`。

不用后端时什么都不用做：没有后端地址时页面和以前一样只用浏览器模拟器，不会发出任何连接。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm verify` | 原来的检查，也包含后端的单元测试（不需要 Docker） |
| `pnpm backend:up` / `pnpm backend:down` | 起停本地后端 |
| `pnpm backend:test` | 后端集成测试：对着 `backend:up` 起的环境跑，包括重启 gateway、故障注入 |
| `pnpm e2e:live` | 浏览器端到端测试：页面连真实后端（先 `pnpm build` 和 `pnpm backend:up`） |
| `pnpm dev:live` | 前端开发服务器，连本地后端 |

在需要额外根证书的网络里构建镜像（例如公司代理）：`docker build --secret id=ca,src=<证书文件> …`，见 `deploy/Dockerfile`。
