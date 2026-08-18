# Agent Note: 原生浅色侧栏材质跟随应用主题

Status: implemented

[English](2026-08-18-native-light-sidebar-material.md) | 中文

## Problem

macOS 玻璃侧栏让 renderer 表面保持透明，以显示 Electron 基于 AppKit 的窗口材质。当应用偏好显式设为 Light、但 macOS 为 Dark 时，Electron 原生主题仍为 `system`，因此底层材质保持深色。增加半透明白色 renderer tint 只能改变像素，不能产生原生浅色材质：提高不透明度会遮住模糊效果，降低不透明度则会暴露更多深色底层材质。

## Decision

应用主题偏好通过专用的 context-isolated preload bridge 镜像到经过校验的 main-process IPC。Electron main 把通过校验的 `light`、`dark` 或 `system` 值赋给 `nativeTheme.themeSource`，不接受其他协议值。主题插件发送持久化偏好，而不是解析后的配色，并抑制重复发送，因此 `system` 会保留跟随操作系统的语义，原生外观更新也不会形成反馈循环。

`glass-light` 与 `glass-dark` 都让侧栏表面在现有 `under-window` vibrancy 上保持透明。因此 AppKit 会提供由 `nativeTheme` 选择的浅色或深色原生材质，而深色材质配置保持不变。“减少透明度”仍选择明确的不透明 fallback，不改变保存的玻璃偏好或主题偏好。

这项决策部分取代[macOS 紧凑桌面窗口呈现 Agent Note](../feature/2026-08-16-macos-compact-window-presentation.md)中的局部浅色 tint 选择；原 Note 仍负责紧凑 chrome、零宽收起、材质偏好与平台边界。

## Alternatives considered

**调整半透明浅色 CSS 填充。** 否决：不透明度只能在模糊可见度与暗度之间取舍，无法改变 AppKit 材质的外观。

**更换 macOS vibrancy 材质。** 否决：现有深色 `under-window` 效果正确，缺陷跟随原生外观，而非材质类型。

**只发送解析后的浅色或深色配色。** 否决：这会抹去用户的 `system` 选择，还可能把操作系统驱动的外观变化反弹成应用覆盖。

**由 Electron main 直接读取 Host 主题设置。** 否决：renderer 主题运行时已经负责偏好采纳与变更事件；第二个设置消费方会重复同步与生命周期行为。

## Consequences

- 显式 Light 与 Dark 偏好现在会同时影响 macOS 绘制的窗口 chrome、Electron UI 和 renderer 配色；System 会移除该覆盖并跟随 macOS。
- 侧栏在两种配色中共用一条透明原生材质路径，因此 renderer 填充不会再压暗或压平浅色玻璃。
- 聚焦测试覆盖 preload 转发、IPC 校验、偏好去重与透明玻璃 CSS。安装包的三次启动旅程还会从 Electron main 读取 `nativeTheme.themeSource`，固定验证 Dark、Light、System、持久化与“减少透明度”行为。当 macOS 在启用“减少透明度”的状态下启动该旅程时，验收会先验证不透明 fallback 与可见的覆盖提示，然后只在验收窗口中恢复透明度，使同一次运行仍会覆盖原生玻璃材质。在关闭窗口前，验收会等待最终的 Light 选择写入 Host 设置文档，避免重开流程与异步设置写入发生竞态。
