# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

Web 产品组合之上的 Electron 桌面 overlay。[`cordis.patch.yml`](cordis.patch.yml) 叠加在内置 `desktop` profile（`dsh-base` + `dsh-web-app` + 本 bundle）的 [`dsh-web-app`](../web-app/README.md) bundle 层之上：禁用全部浏览器传输与运行时行（`web-startup`、`webserver`、`web-runtime`、`client-hmr`），清空 Connection 行的 `webServer` 注入使 Host 侧不挂载任何传输，禁用在此处无法完成 Web-server 探测的自适应目录选择器行，挂载无渲染的原生选择器 client half，并插入 `desktop-runtime` 行——即本包的插件（[`src/index.ts`](src/index.ts)）。这条路径上不会打开任何 HTTP 监听；现有 Web profile 与 Web 开发工作流保持不变。

插件运行在 Electron shell（[`apps/desktop`](../../../apps/desktop)）所监督的专属 DSH 子进程内。它只用 `pick-directory` 与 `open-path` 反向请求关联 Electron main，从而提供 `directoryPicker` 与 `nativePathOpener` 服务；取消和 disposal 会移除每项待处理关联、投递取消并忽略迟到结算。同一子进程 IPC 端点也承载普通桌面载体：等待 Loader 就绪后宣告 client-modules 图以及每个入口对应的 bundle 路径（[`ready`](src/protocol.ts)），在分发前校验每条父进程消息，经 Connection 服务的共享 `/api` fetch handler（与 Web 传输相同的 wire parser 和业务分发）处理 unary 请求，并泵送有序的 API proxy `mux` 与 `host` 流。每条流都会等待 IPC send 完成后再读取下一条 frame，因此背压会限制 in-flight 工作，而不会丢弃已经接受的消息；取消会中止 source，disposal 则会等待存活请求与流结算。父端——Electron main——校验子进程消息与 canonical bundle 路径、关联请求，通过有界 relay 确认 renderer 通知，并持有启动、就绪、renderer generation 清理、IPC 断连、异常退出与 terminate-and-join 关停（[`DshSupervisor`](../../../apps/desktop/src/supervisor.ts)）。renderer 只能通过沙箱化、context-isolated 的 preload 桥访问 DSH，其客户端半部（[`DesktopApiClient`](../../client/connection/src/client/desktop-api-client.ts)）实现现有 `IApiClient` 接口、限制每条已解析 frame 队列，并原样通过共享的 Connection 载体契约。

## 模型体验

### 桌面子进程载体

#### 模型看到什么

什么都看不到。该 overlay 只改变现有 API gateway 与事件流由哪种传输承载；不新增任何 prompt 段落、工具、shell 变量或模型可见事件。录制好的 `bash` 工具回合仍按相同顺序流式输出 `tool/result` 事件及其中的 `TERMINAL_OK` 标记，与 HTTP 承载时完全一致。

#### Token 影响

无。相对于同一组合通过 HTTP 提供服务，不增不减任何 token。

#### KV Cache 影响

无。desktop profile 的 persona、工具面和事件语义与 Web 产品一致；在 Web 与桌面之间切换不会改变系统提示词。

## 已知限制与后续工作

- **无签名的 macOS 发行物** —— 当前主机架构已有打包和安装态冒烟测试，但发布签名、公证与 x64 产物仍然暂缓。
- **单子进程监督** —— 每个应用实例一个 DSH 子进程；首版不支持多窗口与多 Host 编排。
- **renderer 无 CSP** —— 桌面 shell 与 Web 部署保持一致，不为客户端发送 Content-Security-Policy 头（客户端内核通过 `new Function` 求值 `!!js` 配置）；窄 preload 桥与沙箱 renderer 仍是安全边界。
- **原生操作依赖 Electron main** —— 子进程提供的选择器与路径打开器会在 IPC 端点断连后报告不可用；desktop profile 没有 Web server，因此不提供 Web browse 选择器。
