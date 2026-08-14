# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

Web 产品组合之上的 Electron 桌面 overlay。[`cordis.patch.yml`](cordis.patch.yml) 叠加在内置 `desktop` profile（`dsh-base` + `dsh-web-app` + 本 bundle）的 [`dsh-web-app`](../web-app/README.md) bundle 层之上：禁用全部浏览器传输与运行时行（`web-startup`、`webserver`、`web-runtime`、`client-hmr`），清空 Connection 行的 `webServer` 注入使 Host 侧不挂载任何传输，固定原生目录选择器（auto 选择器的 Web-server 探测在没有服务器时永远无法就绪），并插入 `desktop-runtime` 行——即本包的插件（[`src/index.ts`](src/index.ts)）。这条路径上不会打开任何 HTTP 监听；现有 Web profile 与 Web 开发工作流保持不变。

插件运行在 Electron shell（[`apps/desktop`](../../../apps/desktop)）所监督的专属 DSH 子进程内，持有子进程 IPC 载体的另一端：等待 Loader 就绪后宣告 client-modules 图以及每个入口对应的 bundle 路径（[`ready`](src/protocol.ts)），经 Connection 服务的共享 `/api` fetch handler（与 Web 传输相同的分发逻辑）处理已验证的 unary 请求，将 API proxy 的 `mux` 与 `host` 事件流泵为有序的逻辑流并支持取消与确定性的 `stream-end` 关闭，disposal 时中止所有存活的请求与流。父端——Electron main——监督启动、就绪、异常退出与 terminate-and-join 关停（[`DshSupervisor`](../../../apps/desktop/src/supervisor.ts)）；renderer 只能通过沙箱化、context-isolated 的 preload 桥访问 DSH，其客户端半部（[`DesktopApiClient`](../../client/connection/src/client/desktop-api-client.ts)）实现现有 `IApiClient` 接口，并原样通过共享的 Connection 载体契约。

## 模型体验

### 桌面子进程载体

#### 模型看到什么

什么都看不到。该 overlay 只改变现有 API gateway 与事件流由哪种传输承载；不新增任何 prompt 段落、工具、shell 变量或模型可见事件。

#### Token 影响

无。相对于同一组合通过 HTTP 提供服务，不增不减任何 token。

#### KV Cache 影响

无。desktop profile 的 persona、工具面和事件语义与 Web 产品一致；在 Web 与桌面之间切换不会改变系统提示词。

## 已知限制与后续工作

- **目前仅限开发** —— tracer bullet 从源码树运行（`pnpm run dev:desktop`）；打包、签名与安装态冒烟测试是问题 #3，原生 macOS 窗口体验是问题 #4。
- **单子进程监督** —— 每个应用实例一个 DSH 子进程；首版不支持多窗口与多 Host 编排。
- **IPC 背压无界** —— 流泵以 Electron main 的消费速度全速转发；有界队列与 renderer 生命周期关闭是问题 #5。
- **renderer 无 CSP** —— 桌面 shell 与 Web 部署保持一致，不为客户端发送 Content-Security-Policy 头（客户端内核通过 `new Function` 求值 `!!js` 配置）；preload 桥与沙箱 renderer 才是安全边界，CSP 加固属于问题 #5。
- **目录选择器固定为原生** —— 桌面面挂载 `dsh-host-directory-picker-native`（在宿主显示器上打开系统选择器）；没有 Web server 时无法使用 Web browse 后端。
