# Agent Note: CI 执行与恢复手册——GitHub 标准托管容量

Status: implemented

[English](2026-07-26-ci-failover-runbook.md) | 中文

## 问题

必需检查需要一份与现状一致的恢复流程。旧拓扑依赖 enterprise 标签、自托管热备池和仓库变量切换；当前工作流已经没有这些选择器、变量或热备 lane，继续照旧手册操作不会改变任何 job，反而会耽误诊断。

## 决策

[CI](../../../../.github/workflows/ci.yml) 只使用显式的 GitHub 托管容量，并分成两个事件层级：

- 拉取请求运行 `pr-node`、`pr-python-sdk` 和 `pr checks passed` 聚合，保持快速评审约定。
- 推送的 `v*` 标签运行八个穷尽式 job——static、coverage、snapshots、artifacts、Node compatibility、Python SDK、Python runtimes 与原生 Windows——随后运行 `tag checks passed`。

工作流没有 `master` push lane、仓库变量 runner 选择器、enterprise 标签或自托管热备。Wine 只供本地使用。必须依赖原生 Windows 的平台行为在 `windows-2025` 上运行；macOS DMG 工作只会在标签聚合成功后，由独立发行工作流启动。

### 恢复流程

1. 从 Actions run 判定故障类型：排队、镜像或 provisioning 失败属于 runner 容量问题；命令退出属于产品、测试、依赖或工作流问题。
2. 对短暂的托管 runner 故障，重跑失败 job。若 job 从未启动，取消该 run 后重跑全部 job，让 GitHub 重新分配 runner。
3. 对可复现的命令失败，通过拉取请求修复，并让常规 PR 检查通过。绝不跳过必需聚合，也不人工替代其结果。
4. 发行标签失败时，只对短暂故障重跑。若必须修改仓库内容或工作流逻辑，合入修复并在新 commit 上创建下一个版本标签；不得移动可能已经标识已发布 Release 的标签。
5. 更换容量提供方属于工作流变更，必须经过拉取请求评审、信任边界审查和工作流结构测试更新；不存在带外 failover 开关。

发行工作流仅在产品标签 push 对应的 CI `workflow_run` 成功后获得写权限。它会先确认 checkout 的标签解析到 CI run 的精确 commit，再读取发行说明、构建 DMG 或创建 Release。

## 曾考虑的替代方案

**保留休眠的 failover 变量。** 不采用：未经持续演练的选择器会制造误导性运维接口；目标没有持续证明的开关不构成恢复机制。

**让自托管 runner 留在必需路径。** 不采用：当前仓库没有受维护的自托管信任或镜像约定。标准托管 runner 让必需路径可由仓库状态复现。

## 后果

- 短暂容量故障通过 GitHub 重跑恢复，确定性故障通过常规评审修复。
- GitHub 托管容量大范围中断时没有即时切换提供方的路径；检查会等待容量恢复，或等待经过评审的拓扑变更合入。
- `scripts/ci-workflow.spec.ts` 钉住两个事件层级及其聚合，因此拓扑变化会同时更新手册与可执行结构约定。
