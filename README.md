# IndoorKit Demo

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Demo applications for [IndoorKit](https://github.com/vivi-shiki/IndoorKit), an indoor mapping SDK for the browser built on MapLibre GL JS. This repository holds the React + MUI demo app, the business packages for each scenario, the simulators and the generator for the fictional venues and their 3D campus models. The SDK itself lives in the IndoorKit repository.

**Live demo: <https://vivi-shiki.github.io/indoorkit-demo/?lang=en>**

## Examples

Each scenario also has a **Digital twin** cockpit with an editable 3D campus, local outdoor map, indoor floor switching, light/dark themes and a mobile layout. High/low quality controls support slower devices. The campus models are committed as GLB files and can be edited in Blender. See the [model, licence and editing guide](docs/digital-twin.md).

The live demo shows three use cases built on the SDK. Each has its own business package (`domains/hospital`, `domains/parking`, `domains/museum`) and simulator, and is independent of the others. All venues, people, vehicles, companies and collection objects are fictional.

- **Hospital RTLS**: "Sakura General Hospital", 3 buildings with 5 floors. Live tracking of up to 5,000 people, asset tracking, location history playback, alerts from department zones and geofences, and a location heatmap.
- **Parking management**: "Minato Central Parking", a four-level garage and a surface lot with 331 spaces. Space availability with sensors and cameras, entries and exits with fees, three tiers of alerts, reservations with routes along the lanes, and operations analytics.
- **Museum**: "Minato City Museum of Art and History", three public floors and basement storage with 59 display cases. Temperature, relative humidity and light monitoring with 24-hour curves, cumulative light exposure and display days for each object, object moves checked against RFID reads, visitor crowding and dwell time, three tiers of alerts with security patrol checks, and a visitor guide with suggested tours.

| Hospital | Parking | Museum |
| --- | --- | --- |
| ![Live People Tracking](docs/images/tracking.png) | ![Space Availability](docs/images/parking-availability.png) | ![Environmental Monitoring](docs/images/museum-environment.png) |

The demo app is in `apps/playground` (React and MUI), and supports Chinese, English and Japanese, light and dark themes, and phones.

## Development

Requires Node.js 22 and pnpm. The SDK is a git submodule at `sdk/` (the [IndoorKit](https://github.com/vivi-shiki/IndoorKit) repository), linked into the pnpm workspace until it is published to npm.

```bash
git clone --recurse-submodules https://github.com/vivi-shiki/indoorkit-demo.git
pnpm install
pnpm build                         # generate data and build the demo
pnpm verify                        # lint, typecheck and unit tests
pnpm e2e                           # end-to-end and memory tests
pnpm --filter playground preview   # http://localhost:4173/indoorkit-demo/
pnpm sdk:update                    # move sdk/ to the latest IndoorKit main, then commit it
```

Architecture decisions are in [docs/adr](docs/adr); [ADR 0007](docs/adr/0007-sdk-and-demo-repositories.md) explains the split between the two repositories.

TypeScript (strict) · MapLibre GL JS · IMDF · zod · Web Worker + Comlink · KDBush · Flatbush · Turf · Vite · pnpm workspaces · Vitest · Playwright · Biome · GitHub Actions + GitHub Pages
