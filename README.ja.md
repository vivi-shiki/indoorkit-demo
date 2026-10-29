# IndoorKit Demo

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

[IndoorKit](https://github.com/vivi-shiki/IndoorKit) のデモアプリです。IndoorKit は MapLibre GL JS をベースにした、ブラウザで動く屋内地図 SDK です。このリポジトリには React + MUI のデモアプリ、シナリオごとの業務パッケージ、シミュレーター、架空の施設と 3D キャンパスモデルの生成ツールがあります。SDK 本体は IndoorKit リポジトリにあります。

**オンラインデモ：<https://vivi-shiki.github.io/indoorkit-demo/?lang=ja>**

## 活用例

各シナリオに**デジタルツイン**画面を追加しました。編集可能な 3D キャンパス、ローカル敷地図、屋内の階切替、ライト／ダークテーマ、モバイル用レイアウトに対応します。低画質モードで描画負荷を抑えられます。キャンパスのモデルは GLB としてリポジトリに含まれ、Blender で編集できます。[素材・ライセンス・編集ガイド](docs/digital-twin.md)も参照してください。

オンラインデモでは、SDK を使った 3 つの活用例を紹介しています。それぞれ独立した業務パッケージ（`domains/hospital`、`domains/parking`、`domains/museum`）とシミュレーターを持ち、互いに依存しません。施設、人物、車両、会社、作品はすべて架空です。

- **病院の位置情報システム**：「さくら総合病院」、5 階建ての 3 棟。最大 5,000 人の所在確認、医療機器の所在・稼働状況、移動履歴の再生、部門エリアとジオフェンスによるアラート、測位ヒートマップ。
- **駐車場管理**：「みなと中央パーキング」、4 層の立体駐車場と平面駐車場で計 331 台。センサーとカメラによる満空マップ、入出庫と料金、3 種類の異常アラート、予約と車路に沿った誘導ルート、運営分析。
- **博物館**：「みなと市立美術博物館」、地上 3 階と地下の収蔵庫で展示ケース 59 台。展示室・展示ケースの温湿度と照度の監視と 24 時間の推移、作品ごとの積算露光量と公開日数、作品移動と RFID の照合、来館者の混雑と滞在時間、3 種類のアラートと警備巡回の照合、おすすめルート付きの館内ガイド。

| 病院 | 駐車場 | 博物館 |
| --- | --- | --- |
| ![所在確認](docs/images/tracking.png) | ![満空マップ](docs/images/parking-availability.png) | ![保存環境](docs/images/museum-environment.png) |

デモアプリは `apps/playground`（React と MUI）にあり、日本語・英語・中国語、ライトとダークのテーマ、スマートフォンに対応しています。

## 開発

Node.js 22 と pnpm が必要です。SDK は git サブモジュールとして `sdk/`（[IndoorKit](https://github.com/vivi-shiki/IndoorKit) リポジトリ）に置き、npm に公開されるまでは pnpm workspace でリンクして使います。

```bash
git clone --recurse-submodules https://github.com/vivi-shiki/indoorkit-demo.git
pnpm install
pnpm build                         # データ生成とデモのビルド
pnpm verify                        # Lint、型チェック、単体テスト
pnpm e2e                           # E2E テストとメモリテスト
pnpm --filter playground preview   # http://localhost:4173/indoorkit-demo/
pnpm sdk:update                    # sdk/ を IndoorKit の最新 main に更新してからコミット
```

設計上の判断は [docs/adr](docs/adr) にまとめています。2 つのリポジトリの分け方は [ADR 0007](docs/adr/0007-sdk-and-demo-repositories.md) を参照してください。

TypeScript（strict）· MapLibre GL JS · IMDF · zod · Web Worker + Comlink · KDBush · Flatbush · Turf · Vite · pnpm workspaces · Vitest · Playwright · Biome · GitHub Actions + GitHub Pages
