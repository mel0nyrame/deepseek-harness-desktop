# Agent Note：macOS 紧凑原生窗口框架

Status: implemented

[English](2026-08-17-macos-compact-window-foundation.md) | 中文

## Problem

桌面 renderer 之前会注入一条合成的全宽 44 像素标题区域，并把客户端根节点向下偏移。这让应用看起来像是位于伪标题栏下方的 Web 客户端，既阻止对话内容到达窗口顶部，也让侧边栏开关停留在右侧，而不是与原生 traffic lights 共用第一行。

## Decision

桌面采用已批准的 A — Compact macOS 框架作为平台感知的窗口基础（Issue #32）。macOS 保留 `hiddenInset` 原生 traffic lights，并把原生窗口表面作为拖动区域；侧边栏第一行把侧边栏开关放在原生灯组右侧并留出明确间距，DeepSeek Harness 字标位于下一行。renderer 不再使用合成的全宽标题区域或全局顶部内缩。紧凑头部是仅 macOS 的呈现：`DESKTOP_SURFACE_CSS` 在 `body[data-dsh-platform='darwin']` 下应用它，而 Web、Windows 与 Linux 保留原有侧边栏外壳，只保留现有 `desktopWindowOptions` 扩展边界，不提供占位式窗口 chrome。原生全屏中，AppKit 负责 traffic lights 的自动隐藏与屏幕顶端悬停显示；应用只借助 `data-dsh-fullscreen` 将侧边栏控制行与字标行移到侧边栏左侧内容内缩位置。

## Alternatives considered

- **保留 44 像素合成标题区域。** 否决：它把对话内容与窗口顶部隔开，也无法让侧边栏开关与原生 traffic lights 共用第一行。
- **在 Windows 与 Linux 上绘制类似 macOS 的窗口控制。** 否决：非 macOS 平台尚未有批准的设计；平台边界保持为明确的扩展点，不提供占位式 chrome。

## Consequences

- `DESKTOP_SURFACE_CSS` 现在把 drag/no-drag 规则限定到 `body[data-dsh-platform='darwin']`，并保持可交互 shell 区域为 no-drag。
- `RendererSurfaceState` 增加 `platform`，让 renderer 启动事实携带平台边界。
- 侧边栏 shell 默认把字标保留在第一行，并提供隐藏的 `data-sidebar-control-row` / `data-sidebar-brand-row` / `data-sidebar-brand-inline` 接缝；macOS 桌面 CSS 将头部切换为紧凑控制行与字标行。
- 窗口态控制行与原生 traffic lights 灯组留出明确间距（`MACOS_CONTROL_ROW_INSET_PX`）；全屏时两行回到侧边栏左侧内容内缩位置，且应用不强制控制原生窗口按钮显隐。
- 打包验收现在断言 root top 为 0 且内容为全高，而不是 44 像素标题区域。
