# Agent Note: 通过桌面传输组合官方 Client

Status: implemented

[English](2026-08-31-official-client-desktop-composition.md) | 中文

## 问题

桌面运行时需要已发布 DeepSeek Harness 的 conversation、workspace、input、settings 与 primitive Client contribution，但不能启动已发布 WebServer 或浏览器启动路径。停用这些浏览器自有条目时，已发布 Client module registry 也无法存在，因为其 Host plugin 静态依赖 WebServer。另做一套桌面前端会复制产品行为，而通过 loopback listener 暴露已发布前端则会破坏桌面传输边界。

## 决策

- desktop profile 组合已发布 `modules` 条目与完整的已发布 Client roster，同时停用 `web-startup`、`webserver`、`web-runtime`、`client-hmr` 与已发布 `connection` 条目。显式的 `@deepseek-ai/dsh-client-ui-directory-picker-native` 条目通过不变的 workspace API 消费桌面 Host picker；`@dsh-desktop/ui` 提供桌面设置与资产路由。
- 精确版本的 `@deepseek-ai/dsh-client-modules@0.1.0-rc.8` 补丁让 WebServer 挂载变成可选：module registry 只依赖 Loader，路由与 index 注入则安装在 `ctx.inject(['webServer'], ...)` 内。存在 WebServer 时，Web profile 保持既有路由。发布版本提供等价的可选 Host 行为后删除此补丁。
- `@dsh-desktop/ui` 读取已发布 `@deepseek-ai/dsh-web-frontend` distribution 与已发布 Client module graph 广告的路径。其 `/ui/asset` 逻辑 RPC 经现有 loopback-authority Host connection registrar 返回有界、类型化的 base64 资产响应；它既不开 socket，也不拥有第二套 module registry。
- Electron 在 app ready 前把 `dsh` 注册成 standard、secure、fetch-capable scheme。`dsh://app` protocol handler 只接受这个精确 authority 的 GET 与 HEAD，把路径请求经受监督的 child connection 转发，校验完整响应 envelope，并在导航取消时取消 Host 请求。正常产品窗口加载 `dsh://app/index.html`；只有这个根文档可作为受信 main frame。
- 桌面自有 Client 源码编译为已发布 `window.__ModuleLoader__` factory 格式。桌面 connection 产物先放入精确发布的 `@deepseek-ai/dsh-client-connection` Client factory，再注册 `@dsh-desktop/connection`；因此已发布浏览器 controller 保持唯一实现，其依赖 WebServer 的 Host 条目仍不进入图。UI 产物依赖官方图中已有的 React factory。
- 资产源拒绝畸形编码、遍历 segment、未知 plugin id 与已发布前端根目录之外的路径。产品文档为资产与连接设置 self-only content policy；官方前端的 Client 表达式 evaluator 需要 inline boot script 与 `unsafe-eval`，所以两者保持启用。Electron 仍以 sandbox、context isolation、无 Node integration 与窄 preload bridge 运行该文档。
- `SettingsProvider.register()` 把桌面 namespace 绑定到被注入 contribution 的 Cordis fiber，显式 effect 则拥有 `/ui` RPC registration。Electron 随窗口生命周期移除 protocol handler；既有 supervisor cancellation 与 shutdown bound 管理未决资产请求。

## Verification

- 资产与协议测试覆盖 boot manifest 注入、CSP 位置、前端及 plugin content type、遍历和未知路径拒绝、authority 与 method 过滤、畸形 Host envelope、取消及 HEAD 响应。
- Profile 与 module 测试钉住已发布 roster、可选 WebServer injection、显式 native picker Client contribution、浏览器安全 Client bundle 与 disposer 行为。真实内存 `SettingsProvider` 测试会卸载 UI Host fiber，并验证其 namespace 随之消失。
- darwin 打包运行时测试在无 API key、无 listener 下启动真实 Electron app。它验证 native picker 返回的精确 basename，打开 input-trigger suggestion，在 paced replay 尚处于 streaming 时观察中间态，观察完成的 Bash row 与 answer，再提交第二个 turn 以确定性耗尽 replay 并渲染 terminal error，最后修改桌面 settings contribution。
- 该旅程写入七张不同的 PNG 与一份 `evidence.json` manifest，后者包含每个文件名、字节数与 SHA-256 digest。测试把 manifest 与文件逐一核对，并检查持久 settings 文档和 child process 完整静默。运行时测试直接组装 root test build 已生成的产物，因此不会在并行测试检查 Client factory 时覆盖它们。聚焦 macOS gate `pnpm run build && pnpm exec vitest run tests/desktop-runtime.e2e.test.ts -t "composes the official Client"` 的结果为一个测试通过、五个测试被过滤。
- runtime manifest 钉住 package patch 与 lockfile digest，因此 dependency update 无法静默丢掉可选 WebServer seam。

## 已考虑的替代方案

**在 loopback 上启动已发布 WebServer。** 拒绝：打包应用已经有经过认证且支持取消的 IPC carrier。listener 只为在本机进程之间搬运字节，却会引入 port ownership、origin、rebinding 与 shutdown 问题。

**构建桌面特有的 conversation 前端。** 拒绝：conversation ordering、tool row、workspace adoption、settings section、input trigger 与 primitive rendering 会获得第二套实现。已发布 Client contribution 就是产品表面；桌面代码只提供 transport、native capability、chrome 与 settings seam。

**让 Electron main 直接读取所有前端文件。** 拒绝：Host 的 Client module registry 拥有权威 graph 与 plugin artifact path。经其逻辑 RPC 路由可把 package resolution 与 Cordis disposal 留在组合运行时中，也阻止 shell 变成第二个 runtime assembler。

**只为 Client artifact 保持已发布 Connection 条目启用。** 拒绝：该条目同时声明依赖 WebServer 的 Host plugin。把精确发布的 Client factory 放入桌面产物，既保留该浏览器代码，也不会让未解析或意外的 Host transport 进入桌面图。

## 后果

桌面产品通过一个 custom origin 与现有 IPC connection 渲染精确发布的 Client 表面，没有 loopback listener，renderer 也无法访问文件或 Electron API。上游 Client 新增项经已发布 profile 与 module graph 流入，无需复制桌面组件。该设计增加一个精确版本的 client-modules 补丁与有意的 `unsafe-eval` CSP 例外；两者都是可见的维护义务，在已发布前端或 module host 变化时必须重新验证。
