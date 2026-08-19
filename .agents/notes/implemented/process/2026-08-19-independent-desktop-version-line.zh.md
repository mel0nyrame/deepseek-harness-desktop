# Agent Note: Desktop 独立产品版本线

Status: implemented

[English](2026-08-19-independent-desktop-version-line.md) | 中文

## 问题

Desktop fork 会从上游同步 core 运行时，同时把 Electron 外壳作为独立 macOS 产品分发。若只用一条共享版本线，每次 Desktop 发行都要改写根、CLI、Web 与全部包 manifest，持续与上游同步产生冲突。若 core npm 族与 Desktop 产品还共用朴素的 `v<semver>` tag，同一个 tag 也无法说明它命名的是哪条版本线。

## 决策

core dsh 族由 `packages/*/*`、`apps/cli` 与 `apps/web` 组成。其成员与 workspace 根保留一条共享运行时版本线，休眠的 npm 发布族使用 `dsh-v<semver>` tag。`release:dsh` 只改动这个 core 族与根。

`apps/desktop` 不属于 core dsh 发布族。它的 manifest 携带 Desktop 产品版本，供 Electron Builder、应用包、DMG 文件名、GitHub Release 元数据与 Homebrew 使用。由检查结果把关的产品流水线使用朴素的 `v<semver>` tag；发行资产准备从该 tag 推导预期 DMG 文件名，而 Electron Builder 从 Desktop manifest 推导实际文件名，因此版本不同会让发行失败。Desktop 发行只编辑 `apps/desktop/package.json` 与精确版本的双语发行说明；core manifest 保持在上游同步的版本线上。

发布族回归测试从真实 workspace 发现成员，并断言 CLI 与 Web 留在 core 族内、Desktop 留在族外；测试也固定独立的 core `dsh-v` tag 前缀。产品流水线中由 tag 推导的资产约定则独立固定 Desktop 的 `v` 权威。

## 曾考虑的替代方案

**每次 Desktop 发行都 bump 全部 core manifest。** 不采用：外壳版本并不描述内置运行时包；改写上游同步的 manifest 会制造可避免的冲突，却不改变运行时字节。

**保留 Desktop 在 core 族内，只在共享版本校验中豁免它。** 不采用：`release:dsh`、打包、发布顺序与 tag 校验仍会把外壳当作同一 npm 发布成员。校验豁免会掩盖归属拆分，而不是表达它。

**让两条版本线都使用 `v<semver>`。** 不采用：当版本不同，一个仓库 tag 无法同时明确授权 core npm 发行与 Desktop 产品发行。

## 后果

- core 与 Desktop 版本可以按设计不同；这不是 workspace 不一致。
- 产品发行 commit 保持小范围，上游同步无需处理 core manifest 中的产品版本 churn。
- 未来若发布 core npm 族，必须使用 `dsh-v<semver>`，且不会意外触发 Desktop Release 工作流。
- 新 app 不会隐式加入任何发布族；它的版本与 tag 归属需要显式决策。
