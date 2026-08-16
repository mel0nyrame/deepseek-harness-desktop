# Agent Note：DSH Desktop 以官方鱼 logo 配浅色圆角底作为应用图标

Status: implemented

[English](2026-08-16-desktop-app-icon.md) | 中文

## Problem

桌面 bundle 此前没有任何应用图标：`electron-builder.yml` 没有声明 `mac.icon`，产出的 `DSH Desktop.app` 一直携带 Electron 默认图标（`CFBundleIconFile` → `electron.icns`）。issue #9 的发布制品因此在 Dock、Finder 与 dmg 里都没有产品标识。DeepSeek Harness 的官方标识是鱼 logo（`packages/client/ui-primitives/src/FishLogo.tsx`，与 Web favicon 同一几何）。macOS 的 icns 是静态的——favicon 在暗色模式下的黑→白翻转无法在 Dock 里复现——纯黑透明底的图标在深色壁纸与深色 Dock 下会几乎不可见。

## Decision

以官方鱼 logo 配浅色圆角底交付，维护者在三个候选方案中选定：

- **官方几何** — `build/icon.svg` 内嵌精确的 FishLogo path（viewBox `0 0 23.16 17.04`），放大到 600×441，置于 1024×1024 的浅色圆角底上（白→#F1F4F8 渐变，圆角半径 230px）。
- **确定性栅格化** — `scripts/icon.ts` 用 sharp（apps/desktop 的 devDependency）渲染出 1024×1024 的 `build/icon.png`；SVG 源文件与 PNG 都提交进仓库，CI 直接消费 PNG、从不现场栅格化。
- **构建器接线** — `electron-builder.yml` 设置 `mac.icon: build/icon.png`；electron-builder 把 PNG 转成 `Contents/Resources/icon.icns` 并让 `CFBundleIconFile` 指向它。
- **证据门禁** — `scripts/artifact-evidence.ts` 里的 `hasCustomBundleIcon`：产出的 bundle 必须同时包含 `Contents/Resources/icon.icns` 与精确的 `<string>icon.icns</string>` plist 引用（整标签匹配避免 `electron.icns` 以子串方式蒙混过关）。仍携带默认图标时打包管线直接失败。`apps/desktop/tests/package.spec.ts` 有单元测试覆盖。

## Alternatives considered

- **纯黑鱼配透明底** — 与官方 favicon 完全一致，但 macOS 没有暗色模式图标变体，深色 Dock 下会隐身。否决。
- **品牌蓝底配白鱼** — 使用徽章蓝 #4D6BFE；最醒目，但离官方黑图标最远。否决。
- **打包时用 qlmanage/sips 现场栅格化** — qlmanage 的渲染随 macOS 版本变化；提交 sharp 渲染的 PNG 让管线保持确定性与可审查性。否决。

## Consequences

- `pnpm --filter @deepseek-ai/dsh-desktop run icon` 可重新生成 PNG；打包管线拒绝仍携带默认 Electron 图标的 bundle。
- 开发模式实例（`pnpm run dev:desktop`）仍显示 Electron 默认 Dock 图标：bundle 图标只对打包后的应用生效。
- sharp 加入 `apps/desktop` devDependencies；它已通过 `@deepseek-ai/dsh-attachment-local` 在工作区解析过，不引入新的解析面。
