# Agent Note: 解耦 1/10 —— 独立桌面工作区边界

Status: proposed

[English](2026-08-20-desktop-workspace-decoupling.md) | 中文

## Problem

仓库把完整的 DeepSeek Harness monorepo 与 Electron 桌面产品合并在了一起：`apps/desktop` 依赖工作区依赖图，打包流程调用仓库级构建与闭包工具，桌面载体为了无 WebServer 运行时修改了共享客户端包，原生 UI 工作横跨多个上游 UI 包。因此，上游同步始终携带巨大且用途混杂的冲突面，桌面产品也被官方仓库的源码布局与发布流程所捆绑。产品需要成为一个独立开发、独立发布的桌面应用，同时仍从精确的官方 DSH 运行时获得 agent、模型、工具、Session、持久化与插件能力（[父决策](../../implemented/process/2026-08-16-desktop-fork-identity-and-upstream-readme-preservation.md)保留 fork 身份；[桌面应用提案](../feature/2026-08-14-electron-desktop-app.md)描述解耦前的架构）。

迁移按十个可独立验证的阶段推进；本记录持有第 1 阶段，该阶段只创建边界与验证。它不迁移运行时、IPC、原生行为或 UI 实现，也不包含任何无关清理或产品功能。

## Proposal

把解耦分支当作保留仓库历史的新产品工作区。仓库根目录成为桌面产品工作区；旧 monorepo 源码冻结在 `legacy/` 下；精确的官方 DeepSeek Harness 源码作为根级 `upstream/` 子模块固定，仅供检视与兼容性工作使用；产品级 agent 开发资源（技能、Agent Note、AGENTS.md 规则）与代码边界一样审慎迁移。

### 仓库布局

- 根工作区：`pnpm-workspace.yaml` 只声明 `apps/*` 与 `packages/*`。`legacy/` 树刻意不是工作区成员，因此常规 install、typecheck、test、build 与打包从不读取旧依赖图。
- `legacy/` 持有冻结的 monorepo：其自身的 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`AGENTS.md`、`.agents/`、`.github/`、`docs/`、`packages/`、`apps/`、`vendor/` 以及解耦前的所有根级文件，包括原始的 `README.md`/`README.zh.md`/`README.i18n.yaml` 三件组、`CLAUDE.md`、`LICENSE`、`SECURITY.md` 与 `assets/readme/` 树（作为冻结副本）。唯一未随迁的解耦前根级条目是过时的 `.codegraph/` 数据库与三张社区二维码图（`assets/community-*.png`），按产品决策作为废弃产物移除。它保留用于对比与恢复，直到解耦将其移除；`legacy` 分支是它的恢复归属。禁止从产品工作区编辑、构建或依赖它。
- `upstream/` 是固定到提交 `141eb6fef83422698aef7a981029e843e8161534`（`deepseek-ai/deepseek-harness` 上的 `dsh-v0.1.0-rc.8`）的子模块，在 `.gitmodules` 中声明并在索引中记录 gitlink。它服务于源码检视、兼容性对比与升级工作；常规开发从不依赖它，运行时装配（第 2 阶段）消费精确的已发布包，而非该子模块。
- 视觉资产保持内容、名称与位置不变：`assets/readme/*` 留在根目录（README 引用它），应用图标留在新 shell 包内的 `apps/desktop/build/icon.{png,svg}`。

### 包角色

五个包在 `@dsh-desktop/*` 命名空间下声明产品角色；任何桌面自有包都不得使用官方 `@deepseek-ai/*` 命名空间：

- `apps/desktop` → `@dsh-desktop/shell`：Electron 外壳——窗口、preload、上下文隔离、renderer 的 Node 限制、应用生命周期、DSH 子进程监管、原生 macOS 交接与打包。它不持有 DSH Session、工具、持久化、模型执行、PTY 或 Cordis 组合。
- `packages/bundle` → `@dsh-desktop/bundle`：桌面 bundle 与 profile 引导——在官方 base 与 Web bundle 之上组合 `desktop` profile，并修复产品自有 profile 条目（第 3 阶段）。
- `packages/connection` → `@dsh-desktop/connection`：IPC 连接 Provider，在经验证的 preload 桥上实现现有 Client/Host 连接契约（第 4 阶段）。
- `packages/native` → `@dsh-desktop/native`：原生能力 Provider——目录选择、路径打开及类似 macOS 操作，作为带反向请求的 Cordis Provider（第 6 阶段）。
- `packages/ui` → `@dsh-desktop/ui`：通过文档化的客户端扩展点提供 UI 贡献（第 7–8 阶段）。

依赖方向：桌面包之间使用 `workspace:*`；对官方包（`@deepseek-ai/*`）与第三方包的依赖一律是精确的已发布版本——绝不允许 `workspace:` 协议、`file:`/`link:` 引用，或任何经由 `legacy/` 解析的依赖。`@dsh-desktop/*` 之外不得依赖任何桌面包。每项能力都必须经由 Cordis 插件与已声明的能力缝（Service Definition / Provider / Consumer）进入；Electron 外壳是宿主边界，绝不是第二个 agent 运行时——**DSH 产品装配中的一切保持插件组合**。

### Agent 开发资源

- 技能：全部十四个非 `dsh-` 技能原样保留（`code-review`、`codebase-design`、`diagnosing-bugs`、`domain-modeling`、`implement`、`prototype`、`record-browser-gif`、`setup-matt-pocock-skills`、`tdd`、`to-spec`、`to-tickets`、`triage`、`wayfinder`、`writing-for-agents`）。七个 `dsh-` 技能经审慎筛选后保留——`dsh-archive-agent-notes`、`dsh-code-review`、`dsh-find-simplifications`、`dsh-merging-stacked-prs`、`dsh-pre-push-checks`、`dsh-prose-standard`、`dsh-trim-cot-leakage`——并更新了其仓库引用。三个不复制：`dsh-doc-site-sync`（文档站点已属 legacy）、`dsh-doc-standards`（其预算与门禁机制已属 legacy；编辑判断由保留的散文技能覆盖）、`dsh-translate-docs`（其 i18n 语料机制已属 legacy；配对规则位于 Agent Notes README）。
- Agent Note：保留生命周期目录树（`proposed/`、`implemented/`、`rejected/`、`archived/`）及其规则。十一份仍能指导桌面产品的记录以原生命周期状态迁移并更新引用；其余决策语料冻结在 `legacy/.agents/notes/` 下。
- 规则：根 `AGENTS.md` 与 `packages/AGENTS.md` 为产品重写；`CLAUDE.md` 符号链接到根文件。`docs/agents/` 保留本 fork 的 issue-tracker、triage-labels 与 domain 文档。
- 验证：repository-layout 测试（`tests/repository-layout.test.ts`）固定包归属、依赖方向、子模块声明与固定点、保留技能集合、笔记生命周期目录树与视觉资产位置。最小 CI 工作流在拉取请求上运行冻结安装以及 typecheck、lint 与测试套件。

## Alternatives considered

**把旧 monorepo 留在根目录，新工作区放入子目录。** 旧代码会原封不动，但仓库根目录仍是 monorepo，未来默认分支仍呈现官方布局，固定的 `upstream/` 子模块也会位于产品项目之外。这与「把桌面分支当作新产品工作区」相矛盾，并让第 9 阶段的移除变成根级重写而非限定删除。

**保留根目录的旧树，但用新工作区替换根清单。** 冻结副本将失去自身的 `package.json`/`pnpm-workspace.yaml`/lockfile 一致性，两个项目在同一根目录交错，安装与工具边界变得含糊。

**立即从分支删除 monorepo 源码。** `legacy` 分支保留了历史，但第 2–8 阶段仍要从旧实现移植行为；在第 9 阶段之前保留冻结副本可以随时对比，并让最终移除成为一次限定删除。

**逐字复制每个 `dsh-` 技能与每份 Agent Note。** 把已死的机制当作现行契约复制，正是迁移规则要拒绝的：被弃技能所依赖的机制在 `legacy/` 中，保留集合是经过筛选并记录在案的。

## Acceptance criteria

- 独立工作区声明 Electron 外壳与四个桌面自有插件/Provider 角色，且不把桌面自有包引入官方命名空间。
- repository-layout 测试验证包归属、允许的依赖方向、官方子模块声明与固定点，以及必需的 agent 开发资源。
- 全部非 `dsh-` 技能得到保留；保留的 `dsh-` 技能与适用的 `AGENTS.md` 规则是审慎筛选的结果，而非盲目复制。
- 本 proposed 记录载明新项目边界、替代方案、验收标准、风险，以及「DSH 产品装配中的一切保持插件组合」这一规则。
- 现有 README 图片、截图、应用图标及其他视觉资产保持内容、名称与位置不变。
- 布局测试、冻结安装、typecheck 与 lint 通过，且交接中记录精确命令与结果。
- 不包含任何无关清理或产品功能。

## Risks

- **并行 worktree 漂移：** 第 2–8 阶段在基于本基线的并行 worktree 中运行。布局测试固定边界，因此组件切片无法悄悄把 `workspace:` 链接重新引入 `legacy/`，或把桌面包移入官方命名空间。
- **lockfile 波动：** 每个切片都会增加真实依赖；合并后的 lockfile 由 tracer-bullet 集成（第 5 阶段）统一重新生成一次。切片只修改各自清单，不触碰共享锁状态。
- **迁移资源的引用漂移：** 技能与记录现在对冻结材料指向 `legacy/`。布局测试固定技能集合与生命周期树，迁移记录的链接在迁移时已检查；链接校验器由后续切片负责。
- **冻结副本混淆：** 开发者可能把 `legacy/` 误当作构建输入。`AGENTS.md` 与包规则写明了边界，第 9 阶段的闭包校验会拒绝任何来自 `legacy/` 的依赖。
- **推迟的机制：** note 格式、归档、配对与文档门禁未移植；布局测试提供第 1 阶段检查，自动化门禁随后续切片回归。
