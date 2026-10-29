# IndoorKit Demo

[English](README.md) | **简体中文** | [日本語](README.ja.md)

[IndoorKit](https://github.com/vivi-shiki/IndoorKit) 的演示应用。IndoorKit 是基于 MapLibre GL JS、运行在浏览器中的室内地图 SDK。本仓库包含 React + MUI 演示应用、各场景的业务包、模拟器，以及生成虚构场馆和 3D 园区模型的工具；SDK 本身在 IndoorKit 仓库。

**在线演示：<https://vivi-shiki.github.io/indoorkit-demo/?lang=zh>**

## 示例

每个场景新增一个**数字孪生驾驶舱**：可编辑的 3D 园区、本地室外地图、室内楼层切换、亮暗主题和手机布局。支持高低画质；园区模型以 GLB 文件提交在仓库里，可在 Blender 中编辑。模型来源、授权和编辑方法见[数字孪生文档](docs/digital-twin.md)。

在线演示包含三个基于 SDK 的应用场景，各自有独立的业务包（`domains/hospital`、`domains/parking`、`domains/museum`）和模拟器，互不依赖。所有场馆、人员、车辆、公司和藏品都是虚构的。

- **医院实时定位**：「樱花综合医院」，3 栋楼、每栋 5 层。最多 5,000 人的实时定位、设备定位、轨迹回放、基于部门区域和电子围栏的告警、定位热力图。
- **停车场管理**：「港中央停车场」，4 层停车楼加一个平面停车场，共 331 个车位。基于传感器和摄像头的车位实况、车辆进出与停车费、三类异常告警、预约与沿车道的导航路线、运营分析。
- **博物馆**：「港市立美术博物馆」，3 层开放楼层加地下库房，共 59 个展柜。展厅与展柜的温湿度、照度监测和 24 小时曲线，每件藏品的累计光照量和公开天数，藏品移动与 RFID 核对，观众客流和停留时长，三类告警与安保巡逻核对，以及带推荐路线的参观导览。

| 医院 | 停车场 | 博物馆 |
| --- | --- | --- |
| ![人员实时定位](docs/images/tracking.png) | ![车位实况](docs/images/parking-availability.png) | ![保存环境](docs/images/museum-environment.png) |

演示应用位于 `apps/playground`（React 和 MUI），支持中文、英文、日文，浅色和深色主题，以及手机。

## 开发

需要 Node.js 22 和 pnpm。SDK 以 git 子模块的形式放在 `sdk/`（[IndoorKit](https://github.com/vivi-shiki/IndoorKit) 仓库），在发布到 npm 之前通过 pnpm workspace 链接使用。

```bash
git clone --recurse-submodules https://github.com/vivi-shiki/indoorkit-demo.git
pnpm install
pnpm build                         # 生成数据，构建演示
pnpm verify                        # 代码检查、类型检查和单元测试
pnpm e2e                           # 端到端测试和内存测试
pnpm --filter playground preview   # http://localhost:4173/indoorkit-demo/
pnpm sdk:update                    # 把 sdk/ 更新到 IndoorKit 最新的 main，然后提交
```

架构决策见 [docs/adr](docs/adr)；两个仓库的拆分见 [ADR 0007](docs/adr/0007-sdk-and-demo-repositories.md)。

TypeScript（strict）· MapLibre GL JS · IMDF · zod · Web Worker + Comlink · KDBush · Flatbush · Turf · Vite · pnpm workspaces · Vitest · Playwright · Biome · GitHub Actions + GitHub Pages
