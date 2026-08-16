# Agent Note: 桌面窗口验收以操作系统实际授予的 bounds 为基线

Status: implemented

[English](2026-08-16-desktop-window-granted-bounds-baseline.md) | 中文

## Problem

无密钥打包应用冒烟测试在 Desktop 发布矩阵的 arm64 通道（macos-26）上失败，而同样的断言在 x64 上通过。两个窗口旅程测试都断言记录的窗口 bounds 在合成拖拽尝试及后续交互中保持不变，但证据行把 window.getBounds() 与作为 initialBounds 保存的请求矩形 { x: 120, y: 120, width: 960, height: 700 } 比较。macOS 会把 setBounds 约束到显示器的工作区内：arm64 runner 的工作区只有 677px 高（y 31..708），请求的 700px 窗口放在 y=120 处放不下，于是操作系统授予 { x: 120, y: 31, width: 960, height: 677 } —— 是「请求值对比授予值」，而不是窗口真的被移动了。x64 runner 的工作区更高，请求被原样授予，所以那条通道一直是绿的。

## Decision

- 在 acceptNativeWindow 与 recordNativeWindow（apps/desktop/src/main.ts）中，initialBounds 在合成拖拽输入即将发生前从 window.getBounds() 读取 —— 即 macOS 在 show 之后实际授予的 bounds —— 而不再用请求字面量。请求矩形仍然通过 setBounds 应用，但证据基线是授予后的现实。
- 打包冒烟断言把 draggedBounds / dragAttemptBounds / controlBounds 与该授予基线比较，因此产品主张仍然是「合成拖拽输入无法移动原生窗口」，并且在任何工作区高度下都成立。
- 旅程本身由[交互对等场景笔记](../testing/2026-08-16-desktop-interaction-parity-scenario.md)所有；本笔记只改变窗口 bounds 证据字段的含义：initialBounds 现在报告拖拽开始时操作系统授予的位置，而不是录制时请求的位置。

## Alternatives considered

**请求一个刚好装进当前 arm64 runner 的矩形（例如 640px 高、更低的 y）。** 拒绝：能解当前 runner，但录制对任何更矮的显示器仍然脆弱；授予基线则与显示器无关。

**只比较 width 与 x，跳过 y 与 height。** 拒绝：恰好削弱了平台可能合法产生差异的那一维上的「未移动」主张。

**在 setBounds 之前把应用窗口钳制到工作区。** 拒绝：为了纯测试关切改变产品行为 —— 用户仍可请求更大或恢复更大的窗口，操作系统钳制是平台契约，录制应当观察而非推翻它。

## Consequences

- 打包冒烟测试在两类 runner 上都不再依赖工作区高度；在足够高的显示器上授予矩形等于请求矩形，保持了此前的严格性。
- 证据字段名 initialBounds 不变，但其契约现在是「拖拽开始时授予的值」；测试注释与两个录制调用点记录了这一钳制契约，让下一个调试者不必再从 CI 差异里重新推导。
