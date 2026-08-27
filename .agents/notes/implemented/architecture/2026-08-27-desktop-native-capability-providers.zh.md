# Agent Note: 官方 Service Definition 之后的桌面原生能力 provider

Status: implemented

[English](2026-08-27-desktop-native-capability-providers.md) | 中文

## 问题

desktop profile 直接组合了官方 `@deepseek-ai/dsh-host-directory-picker-native` 后端：每次 workspace 目录选择都在 DSH Host 内跑 `osascript` 子进程，`host.openPath` 同样从该 child 派生原生命中命令。唯一拥有窗口与显示连接的 Electron shell 反而不是操作系统适配器——对话框没有窗口归属、取消无法在两层之间确定性传递，打包产品还背上了本不需要的 osascript/koffi 路径。目录选择与路径打开需要变成桌面自有的 Cordis provider（decoupling 6/10），同时不能分叉任何已发布 Service Definition。

## 决策

- **目录选择**走已发布的 `ctx.directoryPicker` seam，由 `@dsh-desktop/native` 默认导出实现：一个稳定的 `native` capability，其 `pick(signal)` 通过 DSH child IPC 边界发送恰好一条反向请求。
- **路径打开**由 `@dsh-desktop/native/gateway` 提供：它通过已发布的 `createApiProxy` 工厂挂载 `ctx.apiProxy`，只注入 `openPath` 闭包；因为存在 opener，`canOpenPath` 无需额外配置即为 true，其余 gateway 域保持官方行为。其导出的 `inject` 在加载时复制 `ApiProxyService.inject`，上游前置服务变化会原样继承。desktop bundle patch 停用 `api-gateway`（其默认 opener 会在 child 内派生命令）并插入该条目。
- **wire 族**：`capability-request` 从 child 发往 parent；`capability-response`/`capability-error` 反向返回。消息形状放在 `@dsh-desktop/connection` 的 protocol 模块里、与既有 request/stream 词表并列，两个方向各有一个校验解析器（`parseDesktopCapabilityRequest`/`parseDesktopCapabilityResponse`）。路径字段必须绝对、无 NUL 且上限 4,096 个 UTF-8 字节。
- **Electron main 保持为操作系统适配器**，入口是 `DshSupervisor.onNativeActions(handler)`：生产安装 `dialog.showOpenDialog(window, …)` 与 `shell.openPath`；适配器跨 child generation 存活，窗口关闭时由 disposer 移除。并发重复 id 立即回 `duplicate native action id`；未安装 handler 时以类型化错误答复而非悬挂。
- **关联所有权**位于两条 provider row 共享的 Host 侧 channel（每个 endpoint 一个实例，通过 Cordis effect 引用计数）。每条结算路径先移除自身关联，因此迟到或重复的 shell 回复永远无法复活已完成的请求；abort 以同样的本地移除表达（Electron 无法编程取消对话框）；disconnect/disposal 会一次性拒绝所有存活调用方。`openTextFile` 有意保留官方 child 实现：它是受支持的命令交接，没有需要接管的对话框交互。
- **renderer 没有任何新增面**：preload surface、bridge 方法、stream 种类或 capability 命名空间都不暴露给 renderer；反向腿只存在于捆绑 child 与 main 之间。
- **Web 部署不受影响**：`@dsh-desktop/native` 不导入任何 Electron API，只被 desktop bundle patch 挂载，组件版本在嵌入式闭包中被钉住；web profile 继续组合官方 auto/native/browse picker 行。

### 验证旅程

`--tracer-native <dir>` 扩展集成 tracer：真实 renderer 经真实 bridge 对真实组合的 child 先后调用 `host.pickDirectory` 与 `host.openPath`；只有 main 内的 OS 对话框与 shell 交接被确定性脚本替代，既有 capture 机制断言布局、状态推进（`starting → picked → opening → complete`）、可见输出像素、无 loopback listener 与完整进程静默。

## Verification

- 单元（`tests/desktop-native.test.ts`，15 例）：pick/open 关联、绝对路径校验、错误呈现、畸形结算丢弃、含“结算后再来”的取消尝试、断连扇出、异步 send 失败、共享 channel listener 生命周期、provider 映射、不匹配结算拒绝与 provider 销毁。
- Supervisor（`tests/desktop-supervisor.test.ts`，+6）：路由、重复 id、缺失/可移除 handler、畸形请求静默、跨 generation 的适配器持久化与不可投递回复的遏制。
- 真实组合（`tests/connection-composition.test.ts` 第二例）：官方 Client bundle 与真实 `createApiProxy` 经 relay 运行，脚本化的 main 回答证明 pick 成功、native capability 门控下的 `directory-picker-unavailable`、open 成功与 open 失败映射（`path open failed: …`）；`inject` 与 `ApiProxyService.inject` 相等被钉住。
- 打包 darwin E2E（`tests/desktop-runtime.e2e.test.ts`）：对装配运行时执行上述 tracer-native 旅程。
- workspace typecheck、oxlint、构建与全量 vitest 通过；新增依赖后重录了 runtime lockfile digest。

## 已考虑的替代方案

**保留 child 内的官方 `-native` 后端。** 拒绝：无窗口归属的原生对话框产生不一致的焦点与 sheet 表现，取消无法确定性送达，且父决策明确 Electron main 是操作系统适配器而非 agent child。

**扩展受控上游补丁，让 `ApiProxyService.Config` 接受注入 opener。** 拒绝：会把 `patches/@deepseek-ai__dsh-client-connection` 的发布维护义务扩大到第二个包。`createApiProxy` 本就是为 host 装配方注入设计的已发布导出；消费它无需任何补丁，而复用 `ApiProxyService.inject` 保证前置同步且不复制知识。

**为未决 native 动作增加 child→parent 取消消息。** 拒绝：`showOpenDialog` 无法编程取消，这条消息没有任何可执行语义；本地关联移除已经保证迟到结算被丢弃，这正是可观察契约。

**从 renderer 提供选择器（浏览器 File System Access）。** 拒绝：把选择能力暴露给不受信任的文档所有者，偏离 workspace API 的服务器信任模型，并让 seam 编码的「Host 驱动原生体验」组合倒退。

## 后果

每一次 workspace adoption 都会出现有窗口归属的原生对话框，deliverable/settings 的路径也改由 shell 交接给系统默认应用。DSH child 派生的平台命令严格少于 rc.8。IPC 协议长出第三族消息，但边界校验仍收敛在两端本就信任的唯一 protocol 模块内。当上游发布 gateway 行的可注入 opener 等价物时，桌面 gateway 会缩回零桌面特有代码；在此之前，钉住的组合让产品对「什么在哪里运行」保持诚实。
