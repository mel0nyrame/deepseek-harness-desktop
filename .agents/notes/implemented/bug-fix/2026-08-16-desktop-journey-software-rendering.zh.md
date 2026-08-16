# Agent Note：桌面证据旅程禁用硬件加速渲染

Status: implemented

[English](2026-08-16-desktop-journey-software-rendering.md) | 中文

## Problem

issue #9 发布矩阵的 x64 腿在打包应用的 acceptance 旅程中挂起：应用打印 "Host phase: running" 后停止输出，直到测试的 120s 杀定时器触发。捕获的输出里有 GPU 进程的 `ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer`。Intel runner 是没有可靠 GPU 的虚拟机：command-buffer 握手瞬时失败时，渲染器的脚本通道被卡死，每个 `executeJavaScript` 等待都会无限期挂起。arm64 runner 与本地机器极少复现，因此抖动看起来只发生在 x64。被 SIGKILL 的旅程随后把 DSH 子进程与 PTY 变成孤儿，残留进程又污染了后续每个测试的干净退出断言。

## Decision

证据旅程改用软件合成渲染：只要出现任一旅程 flag（`--inspect-native-window`、`--accept-native-window`、`--record-native-window`、`--record-native-actions`、`--record-recovery`、`--smoke`、`--smoke-reopen`），`main.ts` 就在模块顶层、`ready` 之前调用 `app.disableHardwareAcceleration()`。软件渲染让每个旅程的绘制与 `capturePage` 帧在任何机器上都确定——这本来就是旅程需要的性质，它们的证据主张比较的是边界、区域与帧，而不是 GPU 吞吐。交互式产品启动保留硬件加速。

## Alternatives considered

- **只在 CI 加 `--disable-gpu` 开关** — 产品代码不动，但 flag 要穿过测试启动器，而且任何人在无 GPU 机器上录制证据时旅程仍然依赖 GPU。否决：旅程模式存在的意义就是产出确定性证据，开关应该放在产品的模式处理里。
- **给 `executeJavaScript` 等待加超时** — 超时能把挂起变成快速失败，但无法让证据在 Intel runner 上跑通。否决作为修复；现有的 30s `waitForRenderer` 截止时间已经约束了轮询循环，约束不了被卡死的脚本通道。

## Consequences

- 旅程启动不再让 GPU 进程参与合成；瞬时 command-buffer 失败模式无法再卡死脚本通道。
- 打包冒烟现在能在 Intel 矩阵 runner 上通过 acceptance 与 recording 旅程——这是唯一实际跑 x64 的通道。
