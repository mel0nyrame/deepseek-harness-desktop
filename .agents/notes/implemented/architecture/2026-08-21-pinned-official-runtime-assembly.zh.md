# Agent Note: 固定的官方运行时装配

Status: implemented

[English](2026-08-21-pinned-official-runtime-assembly.md) | 中文

## Problem

桌面应用需要完整的官方 DSH 运行时，同时不能构建官方源码树、读取冻结 monorepo 依赖图、要求用户安装 Node.js，或在应用启动时下载产品组件。已发布 DSH 包使用兼容版本范围，因此仅直接依赖 CLI 不能证明同一套连贯版本及其原生 helper 和必要补丁会一同交付。

## Decision

提交的 `runtime/runtime-manifest.json` 是嵌入式运行时的机器可读权威。它记录 DSH 版本、上游源码提交、官方入口包及文件、目标平台原生产物、受控补丁与可复现构建输入。根 lockfile 记录完整的已发布闭包；`scripts/assemble-runtime.ts` 将该闭包装配到被忽略的 `.artifacts` 目录的直接子目录，并拒绝不安全输出、入口缺失、版本漂移、不支持的平台、原生产物缺失、未声明补丁与 `workspace:` 依赖。装配子进程不会收到含凭据的环境变量。

首个运行时以 `@deepseek-ai/dsh@0.1.0-rc.8` 为官方入口。`node-pty@1.2.0-beta.15`、其按架构区分的 addon 与 `spawn-helper`，以及 `koffi@3.1.0` 都是显式平台依赖。node-pty 补丁随摘要、理由、上游引用、测试归属与删除条件一起提交。Electron 43.4.0 通过 `ELECTRON_RUN_AS_NODE=1` 运行 CLI；后续阶段会把生成闭包作为真实应用资源嵌入安装包。

## Verification

`tests/runtime-assembly.test.ts` 把 manifest 作为一个整体契约检查，在上游子模块未初始化时装配闭包，验证所有声明的入口和当前平台产物，并从源码树外通过 Electron 的 Node 行为启动已装配 CLI。源码契约、已装配运行时与未来打包应用的证据保持分离。

聚焦运行时套件通过 `pnpm exec vitest run tests/runtime-assembly.test.ts` 的全部七项检查，工作区也通过 `pnpm run typecheck`。

## Alternatives considered

**从 `upstream/` 或 `legacy/` 构建运行时。** 源码构建会重新引入本产品正在移除的仓库布局和发布流程耦合；两棵目录都只作为检视输入。

**首次启动时安装官方包。** 运行时下载会要求用户机器具备包管理器与网络，并可能解析出不同于已发布产品的闭包。

**把 lockfile 当作完整运行时契约。** lockfile 能证明包解析，但不表达入口义务、源码来源、原生 helper 位置、补丁理由或补丁删除条件。

**只打包 CLI JavaScript 入口。** 动态插件、Web 资产、原生 addon 与可执行 helper 都属于运行时，必须被显式记录并验证。

## Consequences

每个桌面版本都映射到一个可审计的 DSH 运行时，并能在不依赖两棵源码树的情况下完成装配。运行时升级必须同时更新 manifest、精确的 deploy-root 依赖、补丁记录与 lockfile。生成闭包体积较大且与平台相关，因此刻意作为可复现构建产物而非提交源码。受控的 node-pty 补丁仍是发布债务，直到官方包提供所需的 helper 路径 seam。
