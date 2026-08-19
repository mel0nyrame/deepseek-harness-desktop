# Agent Note：PR/tag CI 分层

Status: implemented

[English](2026-08-19-pr-tag-ci-tiering.md) | 中文

## Problem

此前的 CI 在每个拉取请求上都运行覆盖率、快照、制品、Node 兼容性、Wine、原生 Windows、桌面打包和发布形态 Python 运行时检查。这导致必要的 PR 路径缓慢、消耗付费 runner 分钟，并让 Wine apt 依赖漂移在产品 gate 开始前阻塞合并。发布形态 Python 运行时在 pnpm 副作用缓存恢复无效 Makefile 路径时，还会复用陈旧的 node-pty 构建树。

## Decision

普通拉取请求现在只运行 [ci.yml](../../../../.github/workflows/ci.yml) 中的必要 PR lane：`pr-node` 安装一次并运行 `pnpm run check:ci:pr`（静态 gate 加完整单元测试），`pr-python-sdk` 运行 Python SDK pytest。`pr-checks-passed` 聚合这两个作业。

所有 exhaustive 检查移到 `v*` tag 推送。`ci.yml` 定义八个并行 tag 作业：静态、覆盖率、快照、制品、Node 22.19/26 兼容性、Python SDK、发布形态 Python 运行时（三个原生目标）和原生 Windows complete，由 `tag-checks-passed` 聚合。Wine 阻塞作业及其 master cache seeder 从自动 CI 中移除；本地 `check:windows-wine` 命令保留。

Python 运行时构建器现在仅 `workflow_call`，没有 `ci` 输入，也没有 manual/label 入口。其 Linux node-pty 步骤只删除已解析 addon 的 `build` 目录，然后直接调用 lockfile 解析出的 node-gyp，从而在容器构建前重新生成 manylinux Makefile。

其他全量工作流也仅 tag：`release.yml` 在 `v*` CI 成功后构建两种 macOS 架构；`sandbox.yml` 在 `v*` 上运行内核约束证明；`landlock-run.yml` 保留路径过滤的轻量 PR 原生作业，同时其完整原生矩阵和 darwin 证明在 tag 上运行。

## Consequences

PR CI 更快更便宜，必要结论不再等待覆盖率、快照、制品、Wine 或原生平台作业。Tag 验证是正式发布门，发布前必须运行。运行 32165982771 中的三个已确认故障已处理：Wine 不再阻塞 CI，快照有硬超时并与制品拆分，Python 运行时重建不再复用陈旧 Makefile。

## Alternatives considered

**在每个 PR 上保留 exhaustive 检查。** 已拒绝：这使常见路径缓慢且昂贵，Wine 故障也表明低保真模拟可能在未增加发布信心的前提下阻塞合并。

**保留 Wine 作为必需 PR 作业并延长超时。** 已拒绝：原生 Windows tag 作业保真度更高，且 Wine 的 apt 依赖闭包不足以支撑自动 CI。

**PR 只跑静态检查并把所有测试推迟到 tag。** 已拒绝：完整单元测试足够快，可以保留在 PR 必要 lane 中，并能在 tag 验证前捕获回归。
