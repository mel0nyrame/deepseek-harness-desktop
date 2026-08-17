# Agent Note：macOS 原生窗口拖动验收

Status: implemented

[English](2026-08-18-macos-native-window-drag-acceptance.md) | 中文

## 问题

声明或计算得到的 `app-region: drag` 值并不能证明 AppKit 可以移动原生窗口。renderer 内容可能覆盖声明区域，而 Electron 合成输入不会经过执行原生拖动的操作系统指针路径。紧凑窗口因此需要一种证据：既能区分 renderer 样式与可观察的原生移动，又不会把每台测试主机的 Accessibility 权限变成隐式要求。

## 决策

静态测试固定区域所有权边界：`body` 不是拖动区域，实际处于最上层的紧凑 chrome 拥有拖动行为，可交互内容拥有 no-drag 行为。标准模态框头部与 headless 引导标题发布语义化的 `data-window-drag-surface` hook，让桌面 CSS 能把同一契约扩展到浮层，而不耦合生成后的类名。

打包验收套件在正常装配应用和无密钥回放 provider 上增加选择性启用的 `--accept-native-window-drag` 旅程。设置 `DSH_DESKTOP_NATIVE_DRAG_REQUIRED=1` 后，测试要求 macOS Accessibility 权限，等待每个拖动表面报告屏幕坐标，再通过外部 CoreGraphics 指针 fixture 驱动该坐标。Electron main 观察 `BrowserWindow` 边界，而不接受 renderer 自报结果。旅程证明引导页、展开态侧栏和收起态对话 chrome 都能引发原生移动，随后证明拖动输入区不会移动窗口，并且 textarea 仍会获得焦点。旅程通过正常生命周期停止，测试还会检查是否存在残留的自有进程。

未设置 required 环境变量时，操作系统指针旅程会明确跳过。设置变量后，打包应用缺失、fixture 支持缺失或 Accessibility 权限关闭都会成为硬失败，不会静默降级。

## 考虑过的替代方案

**让整个 renderer body 都可拖动。** 否决：最上层的 no-drag 内容可能覆盖它，而宽泛的 drag 继承也会与可交互表面竞争。

**增加透明拖动浮层。** 否决：处于最上层的浮层会吞掉必须保持可交互的控件和内容。

**把计算样式或 `webContents.sendInputEvent` 当作原生移动证据。** 否决：这些路径可以验证区域配置与 renderer 交互，但不会执行操作系统拖动手势。

**无条件运行 CoreGraphics 通道。** 否决：Accessibility 权限属于主机能力。显式 required 通道让普通本地与 CI 运行保持确定，同时防止选择性启用的验收自行跳过。

## 后果

- 区域所有权由快速静态和组件测试覆盖，原生移动则拥有独立的打包 AppKit 验收边界。
- 无密钥录制旅程会捕获具名的装配态拖动表面帧；`capturePage()` 帧与计算样式仍是有用的 renderer 证据，但不承担原生移动声明。
- required 通道命令为 `DSH_DESKTOP_NATIVE_DRAG_REQUIRED=1 DSH_DESKTOP_SMOKE_REQUIRED=1 DSH_E2E_MAX_WORKERS=1 pnpm exec vitest run --config vitest.e2e.config.ts apps/desktop/tests/packaged-smoke.e2e.ts -t "moves the native window from assembled chrome but not from an interactive control" --retry=0`。
- 选择运行该通道的主机必须向运行 Vitest 的进程授予 Accessibility 权限；权限缺失时，通道会直接报告此前置条件。
