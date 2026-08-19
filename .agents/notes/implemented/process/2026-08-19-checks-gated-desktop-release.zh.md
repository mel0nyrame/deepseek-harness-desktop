# Agent Note: 由检查结果把关的 DSH Desktop 发行

Status: implemented

[English](2026-08-19-checks-gated-desktop-release.md) | 中文

## 问题

产品标签可以在未证明仓库穷尽式检查通过时构建桌面产物，而且没有一条工作流统一负责双语说明、已验证下载、GitHub Release 状态与稳定版 Homebrew 交付。dsh 族提出的标签前缀也与产品工作流不同，发行权威并不明确。

## 决策

人工创建的 `v<semver>` 标签是产品发行权威。semver 形状为 `v<主版本>.<次版本>.<补丁版本>`，可带点分隔的预发布段；不接受 build metadata。dsh 发布族采用这个朴素前缀，vendor 与 native 族保留各自前缀，且无法通过 dsh 族校验。

CI 运行八个穷尽式标签 job 和 `tag checks passed` 聚合。[发行工作流](../../../../.github/workflows/release.yml)监听已完成的 CI，仅当其事件是产品标签 push 且结论成功时继续。resolve job checkout 该标签、校验形状，并确认它指向 CI run 的精确 head SHA。产品仓库的每次 checkout 都使用解析后的标签。

每个版本在 `.github/release-notes/<版本>.md` 有且只有一份已提交的双语亮点文件；缺失会让发行失败。英文与中文亮点保存在同一文件，GitHub 自动生成的拉取请求列表排在其后。在签名方式改变前，每个版本文件都必须说明 DMG 使用 ad-hoc 签名且未经公证。

DMG 矩阵在原生 macOS runner 上构建 arm64 与 x64。arm64 运行完整安装包 smoke；x64 运行 artifact gate 与 keyless 场景；两个架构都用 `codesign` 验证已挂载 DMG，并从挂载位置运行 keyless 场景。Release 只拥有四个资产：两份 DMG，以及每份旁边的一份 SHA-256 文件。重跑会编辑同一标签的 Release 并替换资产，不会创建第二个 Release。

稳定版通过 `ruby scripts/update-cask.rb <版本>` 更新 `mel0nyrame/homebrew-dsh`，并使用 `DSH_TAP_DEPLOY_KEY` 推送 Cask。预发布版跳过 Homebrew job。若 deploy key 缺失或 tap 不可用，会在 GitHub Release 已存在后以明确名称失败。

本 fork 不发布任何 npm 序列。artifact 门禁可以打包并安装 workspace tarball，但 CI 与发行工作流都不调用 registry 发布器。

发行就绪信息由启动器拥有：CLI 从自身包 manifest 读取版本，并在用户配置之后将其叠加到 API gateway，因此 `host.describe.version` 报告正在运行的产品。timeout 包保留精确名称 `@deepseek-ai/dsh-tool-call-timeout-policy`；备选名 `dsh-timeout-guard` 的范围比工具调用策略更宽，因此删除阻塞发行的改名标记，不改变已经确立的包名。

## 曾考虑的替代方案

**直接在标签 push 工作流中创建 Release。** 不采用：发行 job 可能在穷尽式 job 得出聚合结论前启动。`workflow_run` 把成功 CI run 设为显式前置。

**保留独立桌面产物工作流。** 不采用：两条 DMG lane 会在 smoke 覆盖、命名与签名方式上漂移。发行工作流是唯一所有者。

**把预发布版发布到 Homebrew。** 不采用：Cask 是稳定更新通道。GitHub Pre-release 承载排练构建，不移动稳定安装。

**把 timeout policy 改名为 `dsh-timeout-guard`。** 不采用：该包围绕 `tools/execute` 强制执行 `ToolDefinition.timeoutMs`，而非运行时中的所有超时。现名精确表达了这条边界。

## 后果

- 标签 CI 通过是任何发行副作用的必要条件。
- 发行重试在 GitHub Release 与 Homebrew Cask 边界保持幂等。
- 维护者必须在推送标签前，于版本 bump 变更中加入精确版本的双语说明文件。
- DMG 继续使用 ad-hoc 签名且未经公证；README 与每份发行说明都披露直接下载时的打开流程。
