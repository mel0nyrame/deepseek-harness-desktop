# Agent Note: 基于已发布约定的桌面 IPC connection provider

Status: implemented

[English](2026-08-25-desktop-ipc-connection-provider.md) | 中文

## 问题

打包后的桌面运行时必须在不打开 loopback server 的情况下，把 context-isolated renderer 连接到 DSH Host。已发布的 `@deepseek-ai/dsh-client-connection@0.1.0-rc.8` 拥有权威的 Client controller、就绪握手、逻辑 RPC 约定和 Host service，但其物理适配器固定为浏览器 fetch、WebSocket 流和 WebServer 路由注册。把完整 Client 包复制到桌面命名空间会分叉重连与协议行为。

## 决策

`@dsh-desktop/connection` 是已发布 Client 与 Host connection 约定的桌面 Service Provider。其 Client 适配器只通过继承已发布的 `AbstractApiClient` 来提供基于 IPC 的 fetch 与流。就绪、重连、Host description 发布与通用 RPC 关联仍由已发布 Connection controller 拥有。Host 适配器用 IPC channel registrar 构造已发布的 `HostConnectionService`，并通过已发布的 `toFetchHandler()` gateway 路由 `/api`。

profile 停用官方 Connection 条目，因为它的 Host plugin 依赖 WebServer。桌面 Client build 先放入精确发布的 `@deepseek-ai/dsh-client-connection` 浏览器 factory，再注册桌面 factory；后者的 external 通过已发布 ModuleLoader contract 解析到前者。`desktop-connection` 条目在两端提供 `ctx.connection`，同时不让依赖 WebServer 的官方 Host plugin 进入图。

preload 只导出一个 `dshDesktop` 对象，包含 request、取消、订阅、确认和 stream listener 操作。调用只接受 `dsh://app` authority 与固定 IPC channel。Host 与 preload 会在分发前解析不可信消息形状；stream payload 必须通过已发布的 mux 或 Host schema。Renderer 设置为 `sandbox: true`、`nodeIntegration: false` 与 `contextIsolation: true`。

每个 Client 订阅最多保留 256 个已解析 frame。只有在上一条 frame 通过进程 send callback 并收到 renderer 确认后，Host 才读取下一条 source frame；提前到达的确认保留为一个 credit。abort、断连与 Cordis disposal 会释放 request、subscription、listener 与 channel registration。

## 已发布包补丁

workspace 补丁只应用于 `@deepseek-ai/dsh-client-connection@0.1.0-rc.8`：

- `createFetchConnectionRpc(fetcher)` 接受 fetch-shaped unary transport，现有 Web 实现委托给它。
- `createConnectionHandle(transport)` 接受官方 API、RPC 与 loopback aspect，现有 Web 插件委托给它。
- `ConnectionChannelRegistrar` 允许 `HostConnectionService` 在没有 WebServer 时注册 fetch-shaped logical channel；省略它会保留已发布 Web 行为。

上游目的地是 `deepseek-ai/deepseek-harness` 中的 `packages/client/connection/src/client/rpc.ts`、`packages/client/connection/src/client/index.ts` 与 `packages/client/connection/src/rpc-host.ts`。当精确的已发布版本提供等价 Client transport factory 与 Host channel registrar 时删除补丁。`tests/connection-carrier.test.ts`、`tests/connection-host.test.ts` 与 `tests/connection-composition.test.ts` 钉住该 seam。

## Verification

carrier contract 覆盖 unary 成功与业务失败、Client 对 Host request 的响应、独立 mux 与 Host 顺序、就绪、取消、畸形 frame、断连、队列上限、重复订阅生命周期及清理。preload 与 Host 套件覆盖边界校验、固定 channel、提前确认、通用 RPC 注册、同步 stream source 失败与 disposal。真实组合测试经 ModuleLoader registry 加载装配后的桌面 Client artifact，解析其中预置的已发布 connection factory，再通过内存 Electron relay 在 app-boot Loader tree 中激活实际 Client 与 Host package export，完成 unary、逻辑 RPC 与就绪调用，同时观测不到 WebServer service 或 network listener。

独立 workspace 尚无该组件的单独产物构建。问题 #67 拥有 Electron 与已发布运行时的构建集成；该组件由 workspace typecheck、lint、聚焦测试、全量测试与运行时补丁 manifest 检查门禁。

## 曾考虑的替代方案

**复制官方 Client connection 包。** 否决：就绪、重连、parser 与逻辑 RPC 行为会获得第二份实现，并与 Web consumer 漂移。

**在 loopback 上运行已发布 Web carrier。** 否决：打包应用不需要 network authority、port 生命周期、DNS rebinding fence 或 WebSocket server。

**把桌面 IPC 协议放入官方包。** 否决：Electron process message、preload exposure 与 renderer 安全设置属于桌面 provider，而不是共享 Service Definition。

**用更大队列替代 acknowledgement backpressure。** 否决：有限队列只改变失败阈值，仍会让慢速 renderer 被无界 Host stream 超越。逐 frame 确认能保持已接受 frame 的顺序，并限制两个 IPC hop 上的工作量。

## 后果

Web 部署保留已发布的 HTTP/WebSocket 行为，桌面 Host 则在无 WebServer 或 listener 的情况下提供相同 service。Renderer 不会收到 Node.js 或通用 Electron 对象。桌面包只增加物理 transport 代码与共享边界校验；官方 controller 与 API 行为继续保持单一来源。

精确版本补丁会带来 release maintenance obligation。升级 `@deepseek-ai/dsh-client-connection` 前必须重新验证或删除补丁，之后 lockfile 才能移动。Electron main 仍必须中继已校验消息并拥有进程监督；问题 #67 集成该应用生命周期。
