# Agent Note: 独立桌面工作区边界

Status: implemented

[English](2026-08-20-desktop-workspace-decoupling.md) | 中文

## Problem

仓库最初把完整的 DeepSeek Harness monorepo 与 Electron 桌面产品放在一起。因此，打包和开发继承了官方仓库的源码布局、工作区依赖图与发布流程，而桌面应用实际只需要一套精确的已发布 DSH 运行时及产品自有的宿主能力。

## Decision

仓库根目录是独立的 DSH Desktop 工作区。它包含 `apps/desktop` 中的 Electron 外壳、`packages/*` 中的 `@dsh-desktop/*` Cordis 包，且不包含解耦前的 monorepo 源码树。`legacy` 分支保留源码副本删除前的仓库快照，其中 `legacy/` 子树是冻结的旧 monorepo，用于历史对比与恢复。根级 `upstream/` gitlink 固定与运行时匹配的官方源码版本，仅供检视与兼容性工作；常规 install、build、test 和打包既不初始化也不读取它。

桌面包使用 `@dsh-desktop/*` 命名空间，且只有桌面自有包之间使用 `workspace:*`。官方与第三方运行时包均固定为精确的已发布版本。Electron 外壳仍是宿主边界，而不是第二个 agent 运行时：Session、模型、工具、持久化、PTY 与产品组合仍归插件组合的 DSH 子进程所有。

安装包中的 asar 只包含一个极小 bootstrap，它从 `Contents/Resources/runtime/` 加载完整且经过验证的闭包。运行时闭包拒绝源码相对依赖协议、缺失的包入口、逃出包的入口与 JavaScript import，以及指向闭包外的链接；它记录产品身份和 `desktop` profile，并包含原生 addon 与 helper。macOS CI 在不初始化子模块的检出上构建应用和 DMG，并从源码树外运行安装态应用；Node 网络守卫会让直接 socket 与 fetch 尝试失败。

现行 Agent Notes、保留的技能、仓库规则与产品身份资产继续位于根目录。现行指导引用历史文档时，使用固定到 commit 的快照 `legacy/` 子树路径，而不要求本地源码副本。

## Verification

`tests/repository-layout.test.ts` 拒绝任何被跟踪的 `legacy/` 路径，并固定 `upstream/` gitlink与产品工作区。`tests/runtime-assembly.test.ts` 验证闭包独立性、入口存在性、JavaScript import 包含关系及对不安全链接的拒绝。`tests/desktop-package.test.ts` 验证产品、打包、签名与运行时证据契约。`tests/desktop-packaged.e2e.test.ts` 按 macOS bundle 语义把应用复制到临时位置，验证内嵌运行时根与官方客户端 UI 写出的文件系统证据，阻断 Node 直接网络 API，验证运行时文件树保持不变，练习 Session 流、PTY 与原生 Provider，并要求确定性的进程清理。`.github/workflows/ci.yml` 把打包与安装态产品冒烟测试设为 macOS 硬门禁。

## Alternatives considered

**无限期保留 `legacy/` 下的解耦前源码。** 冻结的本地副本在行为移植期间有用，但运行时与 Provider seam 已交付后继续保留数千个无关文件，会维持对受支持构建输入的歧义，并扩大每次检出。

**从 `upstream/` 构建运行时。** 这会重新引入源码布局与发布流程耦合。子模块是兼容性工作的证据，而不是生产输入。

**把工作区依赖图打入 asar。** electron-builder 会发现暂存项目上层的依赖，并生成第二份不完整依赖图。无依赖 bootstrap 加一套真实文件系统运行时闭包，让每个 DSH import 与原生 helper 都只有一个解析根。

**首次启动时下载组件。** 在用户机器上安装运行时会要求网络与包管理器可用，还可能解析出不同于发布应用的闭包。

## Consequences

产品无需任一官方源码树即可 clone、检查、打包、安装和运行。发行产物会携带一套体积较大的平台专属运行时，并需为每个目标架构重新构建原生闭包。历史实现细节不再便于离线浏览，但仍可在 `legacy` 分支查阅；当前契约必须位于产品工作区，而不能依赖历史副本。
