# 主干晋升：parity 证据、真实 API 验收与清单

[English](promotion.md) | 中文

本文档是解耦议题 #72 的晋升记录：一次经过评审的 pull request，完成解耦后的桌面产品并通过普通合并接管仓库默认分支。它记录分级 CI 设计、最终的无密钥行为 parity 证据及精确结果、受保护的手动真实 API 验收流程，以及晋升清单。它不合并晋升 PR、不发布 release、不改写历史。分级设计的理由见[分级 CI Agent Note](../../.agents/notes/implemented/process/2026-09-02-staged-ci-and-main-promotion.zh.md)。

## 分级 CI

| 层级 | 工作流 | 运行时机 | 凭据 |
| --- | --- | --- | --- |
| 普通 PR | `ci.yml` | 每个 pull request 与推送 | 无 |
| 打包 | `packaging.yml` | 改动应用产物输入的 pull request（`apps/**`、`packages/**`、`runtime/**`、`scripts/**`、`patches/**`、`tests/fixtures/**`、锁文件、工作流自身）；每次 `master` 推送；手动触发 | 无（ad-hoc） |
| Release | `release.yml` | 带 `release` 标签的 pull request（ad-hoc 预览）；`v*` 标签与手动触发（签名、公证） | 仅签名层，经 Actions secrets |

`tests/ci-staging.test.ts` 在普通套件中锁定分层契约。签名 release 层需要六个仓库 secrets——`MAC_SIGNING_IDENTITY`、`MAC_CERTIFICATE_P12`、`MAC_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`——任一缺失时守卫步骤使 job 失败；标签构建绝不默默交付 ad-hoc 产物。工作流从不发布 GitHub release；它按架构上传产物、SHA-256 校验和与打包日志作为证据。

## 行为 parity 证据（无密钥）

全部证据来自无密钥套件：真实的 Electron 外壳、真实的内嵌 DSH 子进程、真实的 bash/PTY 工具、回放的模式轮次——任何环节都不使用模型 API 密钥。记录环境：macOS 26.6.2 arm64、Node 26.8.1、pnpm 11.7.0、Electron 43.4.0，位于晋升 PR 分支。

| 表面 | 证据 |
| --- | --- |
| 浅色 / 深色 | `tests/desktop-ui-visual.e2e.test.ts` 以 `glass-light` 与 `glass-dark` 渲染已发布的侧边栏并捕获互不相同的帧；`tests/desktop-native-window.test.ts` 从原生状态推导渲染器外观并校验主题桥（`light`、`dark`） |
| 跟随系统 | `tests/desktop-native-window.test.ts` 接受 `auto` 主题偏好，并把原生 `nativeTheme` 更新重新发布给渲染器 |
| 降低透明度 | `tests/desktop-ui-visual.e2e.test.ts` 渲染不透明的辅助功能回退（`transparency: opaque`、材质 `opaque`） |
| 窗口镶边与拖拽 | `tests/desktop-native-window.test.ts` 锁定紧凑 macOS 镶边；已安装应用旅程断言 `desktopChrome: true` 与 `data-desktop-window-chrome` 区域，并捕获真实渲染器帧（`01`–`07`） |
| 侧边栏 | `tests/desktop-sidebar-integration.test.ts` 保留官方标签、工作区计数、插槽与开合交互；视觉证据覆盖折叠与展开状态 |
| 会话流式输出 | `tests/desktop-runtime.e2e.test.ts` 在真实内嵌 DSH 子进程上渲染一个有序的 keyless 终端轮次；已安装旅程捕获 `04-conversation-streaming.png` 与 `05-conversation-complete.png`，`streaming: true` |
| 工具 | 已安装旅程断言 bash 工具到达 `data-state="ok"`，并输出 `TRACER_OK official-client-ui` |
| 终端 / PTY | 真实 bash/PTY 路径在 `tests/desktop-runtime.e2e.test.ts` 与已安装应用冒烟中运行；`tests/desktop-process-tree.e2e.test.ts` 在五个进程场景中覆盖真实 PTY 清理 |
| 工作区 / 目录选择 | `tests/desktop-runtime.e2e.test.ts` 经完整的原生反向请求旅程采纳目录并打开路径；已安装旅程捕获工作区选择器、采纳所选目录并记录 `workspacePath`/`workspaceLabel` |
| 设置 | `tests/desktop-runtime.e2e.test.ts` 组合设置贡献；已安装旅程打开真实设置对话框，切换桌面玻璃设置，并验证 `settings.yaml` 中的持久投影（`ui-sidebar-glass-macos: enabled: false`） |
| 重启 / 会话行为 | `tests/desktop-supervisor.test.ts` 锁定就绪、意外退出与恰好一次受控重启；`tests/desktop-runtime.e2e.test.ts` 在配置失败后重启一次；已安装冒烟在启动期间退出外壳时回收内嵌子进程 |
| 干净关停 | `DSH_DESKTOP_PROCESS_EVIDENCE=1` 的旅程记录每个自有 PID 并断言 Electron 退出后无一存活；冒烟前后运行时树摘要不变；五个真实进程清理场景在 `tests/desktop-process-tree.e2e.test.ts` 中运行 |

### 精确记录结果

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | typecheck 通过；oxlint 0 警告、0 错误（76 个文件）；vitest 30 个文件、176 通过 + 1 跳过（177 测试），50.87 s |
| `pnpm run package` | 产物 `DSH Desktop-0.1.0-arm64.dmg`（+`.blockmap`）与 `mac-arm64/DSH Desktop.app`；签名 `adhoc`；Gatekeeper 评估按证据记录：拒绝（ad-hoc 的预期结果）；运行时闭包、原生 ABI 与身份证据通过 |
| `DSH_DESKTOP_PACKAGE_REQUIRED=1 pnpm run test:package` | 2 个文件、10 个测试通过，40.88 s——已安装应用在网络守卫下于源码树之外运行，自有进程零存活 |
| `shasum -a 256 'apps/desktop/dist/DSH Desktop-0.1.0-arm64.dmg'` | `d542664356e2886b1f3e8dfda8d4b3b2b3b63b6eb35221d7e2dfdc10eb12dd6a` |

## 受保护的手动真实 API 验收

上文的 keyless 套件在不使用模型凭据的情况下证明承载、外壳与工具路径。带标签的 release 之前必须手动完成一次真实模型轮次验收；密钥保持本地且绝不进入 CI（没有任何工作流引用 `DEEPSEEK_API_KEY`——由 `tests/ci-staging.test.ts` 锁定）。

1. 把密钥放进被 gitignore 的根 `.env`（`DEEPSEEK_API_KEY=…`，可选 `DEEPSEEK_BASE_URL`）。
2. 以该环境启动打包应用：
   ```sh
   set -a; source .env; set +a
   "apps/desktop/dist/mac-arm64/DSH Desktop.app/Contents/MacOS/DSH Desktop"
   ```
3. 选择工作区、创建会话、发送一条真实提示、运行一次终端支持的轮次，确认有序流式输出与干净退出。
4. 把验收证据（窗口截图与 `~/.dsh` 下的会话记录）复制到 `.artifacts/real-api-acceptance/`——被 gitignore、仅限本地——并在本文件的晋升 PR 中记录日期、产物版本与所用模型。

绝不提交密钥、绝不在证据中引用密钥、绝不把密钥传入工作流环境。

## 晋升清单

- **`legacy` 分支** — `origin/legacy` 位于 `0971b9f0e3`，在 `legacy/` 子树中保留冻结的解耦前 monorepo；`tests/repository-layout.test.ts` 拒绝任何被跟踪的 `legacy/` 路径并锁定同一快照提交。
- **迁移基线标签** — `migration-baseline` 指向 `0971b9f0e3`（`legacy` 分支切出时的 master 提交）；解耦前的发行标签 `v0.1.0-rc.5` 与 `v1.0.0-rc.1` 均为其祖先。
- **基于 revert 的回滚** — 晋升 PR 以普通合并提交落地；`git revert -m 1 <merge>` 无需 force-push 即可恢复先前的默认分支状态。晋升过程不改写历史。
- **精确运行时清单** — `runtime/runtime-manifest.json` 锁定 `@deepseek-ai/dsh` `0.1.0-rc.8`、上游提交 `141eb6fef83422698aef7a981029e843e8161534`、Electron `43.4.0`、`node-pty` `1.2.0-beta.15`（已打补丁、锁定哈希）、`koffi` `3.1.0`、四个带版本的官方补丁，以及锁文件摘要 `9594e9b8b7a4e51af2d08d77d4083cfb526b65d2c301ff54250025598b2a03c3`。
- **无 force-push 要求** — 晋升经由评审 pull request 进入现有默认分支；晋升与回滚都不需要 force-push。
- **已记录结果** — 上文精确命令结果附于晋升 PR 描述；晋升合并提交上 CI（工作区 + 打包层）必须为绿。
