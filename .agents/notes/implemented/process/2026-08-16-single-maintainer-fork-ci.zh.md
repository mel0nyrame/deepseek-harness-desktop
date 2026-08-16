# Agent Note：单人维护 fork 的 CI 全部跑在标准托管 runner 上

Status: implemented

[English](2026-08-16-single-maintainer-fork-ci.md) | 中文

## Problem

继承来的 `ci.yml` 把四个 job 解析到上游组织专属的托管 16 核池（`dsh-ubuntu-24-04-16core`、`dsh-windows-2025-16core`），每次 master push 还会排上自托管 standby 演练。这个 fork 既没有这些池也没有内网虚拟机，于是这些 job 永远排队，任何 pull request 都无法得出结论。另有三个工作流在此处无法使用或必然报错：`issue-policy.yml`（策略脚本调用上游仓库 API，必然 404）、`docs-pages.yml`（本 fork 未开启 GitHub Pages）、`e2b-e2e.yml`（手动触发，需要 E2B API key）。

## Decision

把工作流集合收敛到单人维护者真正需要的范围——检查与打包——并让每个保留的 job 都跑在 fork 实际拥有的 runner 上：

- **ci.yml** — 三个必跑 Linux job 与独立的 `windows-native` job 改用标准托管 runner（`ubuntu-latest`、`windows-2025`），并发按 2 核下调（`DSH_GATE_CONCURRENCY=2`、`DSH_COVERAGE_MAX_WORKERS=2`、`DSH_SNAPSHOT_MAX_CONCURRENCY=4`）。删除 master 串行演练与两个 runner 阶梯基准矩阵，`workflow_dispatch` 触发器一并移除。`desktop-packaged` lane 改到 `macos-26`——打包在该 runner 上已被验证（旧的 `macos-latest` 主机打包步骤失败）。wine 缓存种子 job 保留：master push 仍然产出每个 PR 都会恢复的 apt 缓存。
- **删除的工作流** — `issue-policy.yml`、`docs-pages.yml`、`e2b-e2e.yml`。`build-exe-for-python-sdk.yml` 保留：`ci.yml` 的 `python-runtime` job 在调用它。
- **desktop-release.yml** — x64 腿只跑制品门禁加 keyless 场景；完整 GUI 套件留在 arm64（见 release-signing note）。

## Alternatives considered

- **重建上游的 runner 池** — 不可能：larger-runner 池属于上游组织。
- **保留上游结构、只加仓库守卫** — 保留同步便利，但留下一堆单人维护者永远用不到的基准与演练死代码。否决：fork 就是维护者自己的项目，工作流本来就是本地文件。

## Consequences

- 每个 pull request 现在都在真实存在的 runner 上跑 node 矩阵、python lane、Wine Windows 门禁与打包桌面冒烟，`all-checks-passed` 可以真正完成。
- 三个 Linux job 在 2 核 runner 上比上游 16 核池慢；并发参数已相应下调。
- 上游工作流变更不再能机械同步进 `ci.yml`，需要手工引入。
