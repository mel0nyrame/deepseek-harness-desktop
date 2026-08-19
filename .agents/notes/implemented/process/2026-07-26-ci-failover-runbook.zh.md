# Agent Note: CI 执行与恢复手册——GitHub 标准托管容量

Status: implemented

[English](2026-07-26-ci-failover-runbook.md) | 中文

## 问题

必需检查需要一份与现状一致的恢复流程。旧拓扑依赖 enterprise 标签、自托管热备池和仓库变量切换；当前工作流已经没有这些选择器、变量或热备 lane，继续照旧手册操作不会改变任何 job，反而会耽误诊断。

## 决策

<<<<<<< HEAD
[CI](../../../../.github/workflows/ci.yml) 只使用显式的 GitHub 托管容量，并分成两个事件层级：
=======
三个必需的 Linux 工作作业、独立的原生 Windows 作业，以及 `all checks passed` 判定作业（若不随切换，即使全部工作作业通过，它仍会滞留在故障池的队列中）——各自通过仓库变量解析运行器池，且开关按平台拆分，使一个平台的故障不会重定向另一个平台。三个 Linux 工作作业与 `all checks passed` 判定作业（其 `needs` 是必需的 Linux 工作作业，且运行在 `vm-backup` 池上）通过 `DSH_CI_FAILOVER_LINUX` 解析；原生 Windows 作业通过 `DSH_CI_FAILOVER_WINDOWS` 解析。变量不存在（正常）时它们运行在托管企业池上；由任何具备写权限的协作者设为 `selfhosted` 时，对应作业切换到公司自有的自托管池：`DSH_CI_FAILOVER_LINUX` 下，Linux 作业与判定作业切到 `vm-backup` 池，快照并发降到共享虚拟机上限，并跳过托管路径的 pnpm 缓存恢复；`DSH_CI_FAILOVER_WINDOWS` 下，原生 Windows 作业切到 `dsh-win-ci` 池。每个开关都是写者可管理的仓库状态而非一次合并，因此在所有检查都是红色时仍然有效。自有池的就绪状态由 `serial / linux (self-hosted standby)` 与 `serial / windows (self-hosted standby)` 通道持续验证——每次 master 推送都在其上运行完整的未分片聚合流程。
>>>>>>> upstream/master

- 拉取请求运行 `pr-node`、`pr-python-sdk` 和 `pr checks passed` 聚合，保持快速评审约定。
- 推送的 `v*` 标签运行八个穷尽式 job——static、coverage、snapshots、artifacts、Node compatibility、Python SDK、Python runtimes 与原生 Windows——随后运行 `tag checks passed`。

工作流没有 `master` push lane、仓库变量 runner 选择器、enterprise 标签或自托管热备。Wine 只供本地使用。必须依赖原生 Windows 的平台行为在 `windows-2025` 上运行；macOS DMG 工作只会在标签聚合成功后，由独立发行工作流启动。

### 恢复流程

1. 从 Actions run 判定故障类型：排队、镜像或 provisioning 失败属于 runner 容量问题；命令退出属于产品、测试、依赖或工作流问题。
2. 对短暂的托管 runner 故障，重跑失败 job。若 job 从未启动，取消该 run 后重跑全部 job，让 GitHub 重新分配 runner。
3. 对可复现的命令失败，通过拉取请求修复，并让常规 PR 检查通过。绝不跳过必需聚合，也不人工替代其结果。
4. 发行标签失败时，只对短暂故障重跑。若必须修改仓库内容或工作流逻辑，合入修复并在新 commit 上创建下一个版本标签；不得移动可能已经标识已发布 Release 的标签。
5. 更换容量提供方属于工作流变更，必须经过拉取请求评审、信任边界审查和工作流结构测试更新；不存在带外 failover 开关。

<<<<<<< HEAD
发行工作流仅在产品标签 push 对应的 CI `workflow_run` 成功后获得写权限。它会先确认 checkout 的标签解析到 CI run 的精确 commit，再读取发行说明、构建 DMG 或创建 Release。
=======
`vm-backup`：一台 64 核虚拟机，6 个常驻 systemd 管理的运行器实例。其镜像必须预装 Playwright Chromium 的 Linux 系统软件包；CI 会下载锁文件选定的浏览器，但绝不在这台持久化共享主机上运行 `apt`。切换前先看 `serial / linux (self-hosted standby)` 最近一次运行：其聚合流程包含浏览器回放，因此绿色热备同时验证常规容量和这项浏览器先决条件。

#### Windows 池

`dsh-win-ci`：公司内部 Windows CI 服务器（一台 96 核 / 580 GB 机器）上 32 个常驻运行器实例（计划任务 `GH-Runner-01`…`GH-Runner-32`）。标签：`[self-hosted, dsh-win-ci, windows]`。镜像必须预装 Node 24、pnpm、Git（Git Bash 在 `PATH` 上，即 `C:\Program Files\Git\bin`——`bash` 工具按名称 spawn `bash`）、PowerShell 7，并为符号链接支持启用开发人员模式。切换前先看 `serial / windows (self-hosted standby)` 最近一次运行：绿色热备验证该池能端到端执行 `check:ci:windows-complete`。

### 切换步骤（任何具备写权限的协作者，约 1 分钟，无需合并）

两个开关相互独立：只切换发生故障的那个平台。

1. 仓库 **Settings → Secrets and variables → Actions → Variables → New repository variable**：名称 `DSH_CI_FAILOVER_LINUX`（Linux 池故障）或 `DSH_CI_FAILOVER_WINDOWS`（Windows 池故障），值 `selfhosted`。
2. 重新触发必需作业，使其重新解析运行器池。已经为托管标签**排队**的作业不会重定向，也无法原地 re-run，因此对于本手册所述的无限排队故障，应取消卡住的运行并 re-run all jobs，或推送一个新提交；“Re-run failed jobs”只有在作业真正失败（而非仍在排队）时才有用。
3. 切换到此完成。Linux 故障切换状态下，工作流还会把 `DSH_SNAPSHOT_MAX_CONCURRENCY` 降为 12，以限制共享虚拟机上的争抢，并跳过托管路径的 pnpm 缓存恢复，因为虚拟机的持久 store 会直接提供热安装。覆盖率在两个 Linux 池上都使用 4 个单 worker 插桩分区与 2 个豁免 worker。Windows 开关没有并发或缓存分支；它只重定向原生 Windows 作业的运行器池。

#**Dependabot 例外。**两个开关的选择器都刻意排除了 `dependabot[bot]`：故障切换期间，Dependabot 拉取请求继续在托管池排队，而不是把依赖项提供的代码放到持久化虚拟机上执行。故障期间 Dependabot PR 持续排队是预期行为而非切换失败；托管池恢复后它会自行完成。

**谁能扳动这个变量。**GitHub 的 API 允许任何具有写权限的协作者管理仓库变量，因此每个开关实际是写者级而非严格的管理员级。在本仓库的信任模型下这并不构成升权：runner group 接纳本私有、禁 fork 仓库的全部工作流（这是让 PR 引用的故障切换得以成立的刻意取舍），因此任何写者本就可以通过推送分支工作流触达这台虚拟机。抵御不可信代码的边界是仓库成员资格；变量只是为成员路由工作。

## 切换期间的容量

6 个常驻实例可承接正常 PR 流量（该池平时唯一的稳态负载是每次 master 推送一个串行热备作业，故障切换时几乎全池可用）。若仍出现排队，用组织级注册 token（组织 Settings → Actions → Runners → New runner）追加注册实例。复制现有 runner 目录时**必须排除身份文件**——`rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/`（通配同时排除 `.runner_migrated`/`.credentials_migrated`——GitHub 会在迁移过的运行器上写入这些文件，它们同样会触发 already-configured 拒绝）——再跑 `config.sh`（原样拷贝 `.runner`/`.credentials` 会使其以 "already configured" 拒绝），然后**启动监听器**：`sudo ./svc.sh install ubuntu && sudo ./svc.sh start`。仅注册不会上线；只有启动了服务的 runner 才会增加容量。每个约一分钟。


### 切回

删除 `DSH_CI_FAILOVER_LINUX` 或 `DSH_CI_FAILOVER_WINDOWS` 变量（或改为 `selfhosted` 以外的任何值），新的运行即解析回托管企业池。若故障期间追加注册过实例，将其移除。

### 信任边界

这些变量是写者可管理的仓库状态；`pull_request` 事件本身既不能设置它们，也不能让不同的值生效，选择器表达式存在于工作流定义中。需要注意：故障切换期间，`pull_request` 运行执行的是 PR merge 引用自带的工作流定义——抵御不可信代码的边界是仓库成员资格（私有、禁 fork、选择器排除 Dependabot），而非该变量。关于 runner group 策略的说明：把 runner group 绑定到 master 引用的工作流与本故障切换机制**不兼容**——五个故障切换作业是从 PR merge 引用求值的 `pull_request` 运行，master 绑定的组会让它们持续排队（2026-07-27 实际故障中亲历；当时将组放宽为本仓库全部工作流才疏通了切换）。更严格的运行器侧策略以牺牲 PR 故障切换为代价；当前采用的形态是仓库范围、全工作流的组访问。
>>>>>>> upstream/master

## 曾考虑的替代方案

**保留休眠的 failover 变量。** 不采用：未经持续演练的选择器会制造误导性运维接口；目标没有持续证明的开关不构成恢复机制。

**让自托管 runner 留在必需路径。** 不采用：当前仓库没有受维护的自托管信任或镜像约定。标准托管 runner 让必需路径可由仓库状态复现。

## 后果

<<<<<<< HEAD
- 短暂容量故障通过 GitHub 重跑恢复，确定性故障通过常规评审修复。
- GitHub 托管容量大范围中断时没有即时切换提供方的路径；检查会等待容量恢复，或等待经过评审的拓扑变更合入。
- `scripts/ci-workflow.spec.ts` 钉住两个事件层级及其聚合，因此拓扑变化会同时更新手册与可执行结构约定。
=======
从托管池故障中恢复只需切换受影响平台的变量（任何写者可设）加一次重跑，关键路径上没有合并。代价是每个平台都要维护第二套运行器拓扑：热备通道在每次 master 推送时都运行它们，避免故障切换目标变得陈旧；而 `ci.yml` 中的快照并发与缓存恢复分支带有一条 `selfhosted` 支路（仅 Linux），必须与托管支路保持同步。按平台拆分开关多了一个需要管理的变量，但把每个开关的影响范围限定在单个平台的作业上。
>>>>>>> upstream/master
