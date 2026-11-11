# R6 k3s 部署（Oracle Cloud 永久免费）

## 目标

同一套镜像部署到一台 Oracle Cloud 永久免费的 Ampere A1 虚拟机上的单节点 k3s，Pages 上的 demo 连这个公网后端。先在本地 k3s 容器里验证清单，机器由 Vivi 注册后再上线。

## 目标环境（2026-11 查证）

- Oracle 永久免费 Ampere A1：每月 1,500 OCPU 小时和 9,000 GB 小时，相当于一直开着 **2 OCPU、12 GB**；块存储共 200 GB；每月出站 10 TB。必须建在主区域；报「out of host capacity」是该区域暂时没有免费机型，换可用域或稍后再试。
- 回收规则：连续 7 天 CPU 95 分位、网络、内存（仅 A1）都低于 20% 可能被回收。设备模拟器常驻会产生持续负载，但仍要在手册里写明。
- k3s：服务端最低 2 核 2 GB，支持 arm64；安装 `curl -sfL https://get.k3s.io | sh -`。自带 Traefik（占用 80/443）和 ServiceLB。官方建议关闭 firewalld，或放行 6443/tcp 并信任 10.42.0.0/16、10.43.0.0/16。
- 来源：[Oracle Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)、[K3s Requirements](https://docs.k3s.io/installation/requirements)、[K3s Quick Start](https://docs.k3s.io/quick-start)、[K3s Networking Services](https://docs.k3s.io/networking/networking-services)。

## 需求

| 编号 | 需求 |
| --- | --- |
| R6-01 | `deploy/k8s/` 用 Kustomize：`base` 加 `local`、`oracle` 两个 overlay。ingest、gateway、device-sim 各一个 Deployment，带 readiness/liveness 探针（`/healthz`）和资源上限；Mosquitto、Redis、MongoDB 用 StatefulSet + PVC（k3s 自带的 local-path） |
| R6-02 | 资源预算：整套在 12 GB 机器上总内存上限不超过 6 GB，留一半给系统和 k3s；医院标签数在 `oracle` overlay 里可下调 |
| R6-03 | 对外只有 gateway：经 Traefik Ingress 暴露 `/ws` 和 `/api`，开 WebSocket。MQTT、Redis、MongoDB 只用 ClusterIP |
| R6-04 | TLS：首选 Cloudflare Tunnel（服务器不开入站端口，cloudflared 作为 Deployment，凭据放 Secret）；备选 cert-manager + Let's Encrypt |
| R6-05 | 公网保护：gateway 只接受 Pages 的 Origin；按 IP 限制连接数和请求频率；告警确认只影响自己的会话（R4-07） |
| R6-06 | gateway 滚动更新：2 副本、`maxUnavailable: 0`，关闭前发 `bye`（R3-10），更新期间地图不断流 |
| R6-07 | GitHub Actions 构建 amd64 + arm64 镜像推到 GHCR；部署用 kubeconfig Secret（由 Vivi 添加） |
| R6-08 | Pages 构建时设 `VITE_LIVE_URL=wss://<域名>/ws`，`auto` 模式默认连公网后端，连不上退回模拟器 |
| R6-09 | `docs/backend/oracle-runbook.md`：从注册、建机、开端口、装 k3s、配 Tunnel 到第一次部署的完整步骤 |

## 测试与验收

- 本地：用 `rancher/k3s` 容器起单节点集群，`kubectl apply -k deploy/k8s/overlays/local` 后所有 Pod Ready；`pnpm backend:test` 和 `pnpm e2e:live` 指向这个集群也通过。
- 滚动更新：更新 gateway 镜像期间，客户端只出现 `bye` 后立即重连，没有退回模拟数据。
- 上线后：Pages 上人员定位页显示「后端 · 已连接」；`/metrics` 可见；资源用量在 R6-02 的预算内。
