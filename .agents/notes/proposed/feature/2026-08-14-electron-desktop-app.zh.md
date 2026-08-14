# Agent Note: 内置 DSH 运行时的 Electron 桌面应用

[English](2026-08-14-electron-desktop-app.md) | 中文

Status: proposed

## 问题

### 问题陈述

DeepSeek Harness 已有 React 客户端和本地 Node.js Host，具备文件系统、子进程、PTY、持久化、插件和语言服务器能力。通过浏览器使用该产品时，操作者仍需单独启动和管理 Host，也无法获得完整集成的 macOS 窗口、应用生命周期、原生模糊和安装体验。

桌面产品必须内置 DSH，不能假设用户已单独安装 CLI 或 Node.js 运行时。它必须保留现有客户端与 Host 约定，同时将 Electron 窗口生命周期与模型执行、插件、PTY 和进程树隔离。首个版本优先实现原生的 macOS 体验，不要求第一天就与 Windows 和 Linux 完全一致。

## 提案

### 解决方案

发布一个复用已构建 React 客户端并包含生产级 DSH 运行时的 Electron 应用。选择 Electron，是因为 Host 及其原生依赖已经使用 TypeScript 和 Node.js 实现；采用 Tauri 仍需保留 Node sidecar，或进行 Rust 迁移，却不能消除困难的打包和生命周期工作。

Electron main 进程负责窗口、菜单、系统对话框、路径打开、与签名相关的应用元数据，以及监管一个应用级 DSH 子进程。DSH 子进程负责真实 Cordis 组装、会话、模型调用、工具、插件、PTY、持久化和子进程树。Host 故障可以结束或重启 DSH 子进程，但不得阻塞或终止 Electron main 的事件循环。

renderer 从打包文件加载现有生产客户端，并通过现有客户端连接接口的 Electron adapter 通信。一个窄 preload bridge 通过 Electron IPC 传递经过校验的一元请求和长生命周期事件流。开发环境的 Web 构建继续使用 HTTP 和 WebSocket adapter；桌面打包产物不启动面向浏览器的 HTTP 服务器。

第一个产品目标是适用于 Apple silicon 和 Intel Mac、经过签名和公证的 macOS 应用。窗口使用 macOS inset title bar、原生 traffic lights、Electron 基于 AppKit 的 vibrancy，以及透明客户端表面。除非 Electron 支持的接口无法提供所需的分区视觉效果，否则推迟原生 addon。

### 用户故事

1. As a macOS 用户, I want 安装并打开一个已签名的应用而无需安装 Node.js 或 DSH CLI, so that 我能像使用普通桌面产品一样开始使用 harness。
2. As a macOS 用户, I want 应用自动启动内置 DSH 运行时, so that 我无需管理后台终端进程或本地服务器。
3. As a 回访用户, I want 我的工作区、会话、设置、凭据引用和 transcript 沿用现有 DSH 持久化行为, so that 从 Web 客户端迁移不会产生第二套产品模型。
4. As an agent 用户, I want prompt、工具调用、审批、提问和流式模型输出与现有客户端一致, so that 桌面 shell 不会削弱 harness 能力。
5. As a 终端工具用户, I want 交互式 shell 及其流式输出能在打包应用内工作, so that 打包不会破坏 `node-pty` 或其 macOS helper。
6. As a 工作区用户, I want 文件夹选择和路径打开操作使用 macOS 原生对话框与应用, so that 特权桌面操作能与操作系统自然集成。
7. As a macOS 用户, I want inset traffic lights、可拖动的自定义标题区域和半透明表面后的原生 vibrancy, so that 应用观感与当前 macOS 软件一致。
8. As a 用户, I want 关闭应用时停止内置 DSH 运行时、PTY 和后代进程, so that 退出后不会残留不可见的 agent 或 shell 命令。
9. As a 用户, I want 内置 Host 启动失败时看到清晰且可恢复的状态, so that 错误配置或原生依赖故障不会只留下空白窗口。
10. As a 用户, I want 桌面 shell 检测 Host 意外退出并提供受控重启, so that 插件或运行时故障不要求强制退出应用。
11. As a 重视安全的用户, I want Web 内容不能直接访问 Node.js 或不受限的 Electron 能力, so that 渲染模型生成内容时无法绕过 DSH 协议调用本地能力。
12. As a 客户端维护者, I want Web 与 Electron 共享同一连接接口和 React 模块, so that 产品行为修复不会分叉成两个前端。
13. As a Host 维护者, I want 桌面系统集成留在 agent loop 之外, so that 窗口职责不会成为模型运行时职责。
14. As a 发布工程师, I want 针对架构的打包冒烟测试以及签名／公证检查, so that DSH 运行时或原生 PTY addon 安装后失效的构建无法发布。
15. As a 贡献者, I want 开发模式保留现有 Web 工作流，并允许 Electron shell 指向本地开发构建, so that 桌面开发不会拖慢无关客户端开发。

### 实现决策

- 首个桌面实现采用 Electron，而不是 Tauri。这让现有 Node.js Host 和原生模块继续运行在其支持的执行环境中，也避免仅为 shell 集成层引入 Rust。
- DSH 随应用分发，并在专用子进程中运行。长期运行的 Cordis Host、模型循环、插件运行时或 PTY 不得放入 Electron main 进程。
- 首个版本中，一个应用实例拥有一个 DSH 子进程。main 进程控制启动、就绪、意外退出报告、重启和先终止再等待退出的关闭流程。
- 复用现有 React/Vite 客户端，不创建桌面专用分支。桌面专用行为通过已有客户端插件 slot 和连接 adapter 进入。
- renderer 从本地加载打包资源。打包应用使用 Electron IPC carrier，不暴露 loopback HTTP 服务器；Web 开发和部署继续使用 HTTP 与 WebSocket carrier。
- 协议语义保留在现有抽象客户端中。Electron adapter 只实现传输操作：一元请求／响应、客户端对 Host 请求的响应、复用 Session 流和 Host 事件流。
- 事件流使用专用长生命周期 IPC channel 或转移的 message port，不得把流建模为重复的一元 IPC 调用。
- preload 只暴露请求、响应、订阅、取消和连接生命周期所需的小接口。启用 context isolation，关闭 renderer Node integration，并在分发前通过现有 wire parser 校验消息。
- Electron main 只作为 router 和 supervisor，不得成为 ApiProxy 的第二套实现。DSH 子进程继续作为会话、工具、持久化、设置、凭据和 agent 行为的权威。
- 原生目录选择与路径打开在 Electron main 中实现。DSH Host 通过显式反向请求访问这些操作，不向 renderer 暴露通用 Electron 能力。
- 保留现有「模型可见内容必须写入日志」规则。经 Electron IPC 移动消息只改变 carrier，不改变 Session event 或重建行为。
- macOS 使用 `hiddenInset` title bar、可配置 traffic-light 位置、活动窗口 vibrancy 和透明 CSS 表面。文字和控件必须保持足够不透明度，以满足对比度和无障碍要求。
- 分区 `NSVisualEffectView` addon 是经过测量后才启用的 fallback。只有原型证明 Electron 支持的 vibrancy 控制无法实现所需布局时才引入它。
- 当运行时加载或执行需要真实文件系统路径时，将原生模块和 helper 可执行文件放在归档外。确定生产 Electron 版本前，先验证 Electron ABI 兼容性。
- 产出 arm64 和 x64 的已签名、已公证 macOS artifact。可选择 universal 打包，但两个架构都必须通过相同的已安装应用冒烟测试。

### 测试决策

主要验收 seam 是已安装的桌面应用。一个无密钥测试启动打包后的 Electron 应用，等待真实内置 DSH 子进程就绪，通过 renderer 创建 Session，运行由终端支持的场景，在 conversation 中观察流式输出，退出应用，并验证 DSH 进程、PTY 和后代进程树均已退出。这是现有最高产品 seam，能够覆盖新 shell，又不会用 mock 替代 DSH 行为。

支撑性测试把可复用的 Client Connection 载体约定（`packages/client/connection/tests/carrier-contract.client.ts`）应用于 Electron 适配器。传输无关的 harness 控制逻辑流投递、断线和存活订阅计数，不导入浏览器或 Electron primitive。它通过 React 调用方所使用的同一 `IApiClient` 接口覆盖一元成功与失败信封、Client 对 Host 请求的响应、有序 mux 与 Host 流、就绪、取消、畸形消息、断线、有界订阅生命周期及清理；Electron 专属测试另行覆盖 IPC 机制。

supervisor 测试覆盖成功启动、启动超时、配置失败、子进程意外退出、一次受控重启、启动期间退出应用，以及先终止再等待退出的清理。对于 mock 无法证明的生命周期声明，进程树断言在 macOS 上使用真实子进程。

macOS GUI 验收针对真实 Electron 窗口运行，并按仓库 GUI 策略记录用户可见工作流。它检查 title bar 控件、拖动和交互区域、明暗外观、减少透明度时的 fallback、焦点、键盘访问和稳定渲染。截图可以记录 vibrancy，但自动断言必须检查配置的原生窗口状态，因为像素本身无法区分原生模糊和半透明颜色。

发布验证安装或挂载每个架构的已签名 artifact，通过 Gatekeeper 评估，在源码树外启动，运行内置 Host 与 PTY 路径，并验证公证元数据。源码模式测试不能替代该 artifact 检查。

### 不在范围内

- 第一阶段发布 Windows 和 Linux 桌面版本。
- 使用 Rust 重写 DSH、子进程管理、PTY 处理或插件执行。
- 在 renderer 或 Electron main 进程中运行 Host。
- 远程 Host 连接模式，或通过网络暴露内置 Host。
- 移动应用、浏览器扩展或第二套桌面专用前端。
- 多窗口和多 Host 编排。
- 自动更新、登录时后台启动、仅菜单栏运行和云同步。
- 在 Electron vibrancy 原型证明具体限制前实现自定义原生 title bar 或 macOS addon。
- 仅为支持 Electron 而改变 Session 格式、模型可见 event、工具语义或 Web 部署行为。

### 补充说明

当前架构已经把 Electron IPC 指定为预期的非 Web carrier，并将浏览器安全协议类型与 Node Host 分离。桌面工作应深化现有连接模块，而不是增加平行的桌面协议。

第一个纵向原型刻意保持窄范围：启动内置 DSH 子进程、完成就绪握手、创建一个 Session、执行一条终端命令、流式传输结果，并在退出时完整清理进程。原生模块加载、helper 放置、代码签名和退出语义必须在此原型中得到证明，之后才能扩展窗口 chrome 或安装器工作。

桌面 shell 是一种产品组装，不是新的能力 seam。如果系统集成以后需要多种实现，可变部分应位于一个小型 Host-facing 接口后，由 Electron 和测试 adapter 实现；它不属于 agent loop。

## 考虑过的替代方案

**使用带 Node sidecar 的 Tauri。**首个实现不采用，因为它保留 Node 分发和进程监管工作，同时增加 Rust、第二层 IPC 和第二套桌面构建工具链。必须继续分发 DSH 运行时和原生依赖时，更小的 shell 二进制不会实质缩小产品。

**为 Tauri 使用 Rust 重写 Host。**不采用，因为这会重复现有插件运行时、进程管理、协议和原生集成，并会延迟桌面产品，却不能改善首个用户工作流。

**在 Electron main 中运行 DSH。**不采用，因为模型执行、插件故障、PTY 负载和 teardown 会与窗口及操作系统事件共享进程。卡住或崩溃的 Host 可能冻结或终止桌面 shell，清理责任也会变得不明确。

**启动现有 Web 服务器并让 Electron 访问 loopback。**打包产品不采用，因为这会打开不必要的网络 listener，并保留浏览器传输和 origin 问题。现有客户端接口支持直接 IPC adapter。Web 服务器仍用于开发和普通 Web 部署。

**构建独立的 macOS 原生前端。**不采用，因为这会分叉已有 React 客户端及其插件呈现模型。Electron 可以保留一套客户端实现，同时提供所需 macOS 窗口效果。

**把所有 renderer 和原生依赖嵌入单一归档。**不把它作为要求，因为原生模块和 PTY helper 可能需要可执行的文件系统路径。打包必须遵循运行时加载约束，而不是追求归档纯粹性。

## 验收标准

- 干净 macOS 机器无需单独安装 Node.js 运行时或 DSH CLI，即可安装并启动已签名、已公证的构建。
- renderer 只能通过 preload bridge 和现有类型化协议访问内置 Host；renderer Node integration 关闭，context isolation 开启。
- 应用可以通过 Electron carrier 创建和重新打开 Session、发送 prompt、处理 Host 交互，并显示有序流式 event。
- arm64 和 x64 artifact 均能通过打包 DSH 运行时执行由终端支持的无密钥场景。
- 正常退出、启动期间退出和 Host 崩溃恢复后，不得留下任何归应用所有的 DSH、PTY 或后代进程。
- 启动和运行时故障必须产生可操作的桌面状态，而不是空白或无限加载窗口。
- 原生文件夹选择和路径打开通过 Electron main 工作，不向 renderer 暴露通用 Electron 或 Node primitive。
- macOS 窗口具有 inset traffic lights、正确拖动区域、受支持的原生 vibrancy、明暗外观行为，以及无障碍的减少透明度 fallback。
- 现有 Web 客户端继续使用当前 HTTP/WebSocket 开发和部署路径，Electron 依赖不得进入浏览器 bundle。
- 打包应用验收测试、carrier 约定测试、supervisor 生命周期测试、GUI 证据和签名／公证检查全部通过。

## 风险

Electron 会增加应用体积和内存使用。该决策接受此成本，因为保留现有客户端和 Node Host 可以降低实现风险，避免重复产品逻辑。

原生依赖可能因 Electron ABI、架构、归档位置、hardened runtime 或签名规则而失败。纵向原型和各架构 artifact 冒烟测试必须在功能扩展前解决这些故障。

两层 IPC 会增加生命周期和背压复杂度。流 channel 需要有界队列、取消和确定性关闭，以免缓慢或断开的 renderer 无限期保留 Host 资源。

原生 vibrancy 可能降低对比度，并会随系统外观、非活动窗口、无障碍设置和未来 macOS 版本变化。产品必须提供足够不透明的 token 和减少透明度 fallback，不能把一张截图视为约定。

子进程隔离可以防止 Host 故障带崩 Electron main，但不会为 DSH 提供安全沙箱。工具权限和子进程沙箱策略仍由 DSH 负责；桌面 shell 不得暗示比 harness 配置更强的限制。

## 实施状态

问题 #1 与 #2 已通过开发路径交付第一个垂直切片：

- 可复用的 Client Connection 载体契约（[`carrier-contract.client.ts`](../../../../packages/client/connection/tests/carrier-contract.client.ts)）锁定了 unary、反向响应、mux 流和 host 流语义，以及就绪、顺序、取消、畸形消息、断连和订阅生命周期行为；HTTP/WebSocket 载体和新的 Electron 载体均原样通过该契约。
- 开发版 tracer bullet 通过 `pnpm run dev:desktop` 运行：Electron shell（[`apps/desktop`](../../../../apps/desktop)）监督一个专属 DSH 子进程（`--profile desktop`，即内置的 `base + web-app + desktop-app` overlay）。该 overlay（[`packages/bundle/desktop-app`](../../../../packages/bundle/desktop-app)）禁用全部浏览器传输行（`web-startup`、`webserver`、`web-runtime`、`client-hmr`），固定原生目录选择器，并挂载子进程运行时，通过单一 IPC channel 提供现有 API gateway 和事件流——路径中不参与任何 loopback HTTP 监听。
- renderer 只能通过沙箱化、context-isolated 的 preload 桥访问 DSH；[`DesktopApiClient`](../../../../packages/client/connection/src/client/desktop-api-client.ts) 在其上实现现有 `IApiClient` 接口。Host 侧 Connection 与 client-modules 插件仅在存在 WebServer 时才挂载 Web 传输，因此 Web 开发工作流保持不变。
- 一个 keyless 真实组合 e2e（[`apps/desktop/tests/real-composition.e2e.ts`](../../../../apps/desktop/tests/real-composition.e2e.ts)）fork 真实的 desktop profile，创建 Session，重放一段已录制的 `bash` 工具回合，断言 mux 流中按序流式到达的 `TERMINAL_OK` 结果，并验证 terminate-and-join 退出后没有残留后代进程。

问题 #3 已交付打包应用切片：

- `pnpm --filter @deepseek-ai/dsh-desktop run package` 通过四个阶段（[`scripts/package.ts`](../../../../apps/desktop/scripts/package.ts)）产出主机架构的无签名 macOS 应用包：闭包校验（`verify-runtime-closure` 现在同时检查两个部署清单）、将生产运行时闭包 pnpm legacy deploy 到无符号链接的暂存目录、按 Electron ABI 重建 node-pty 并在 Electron 二进制内加载验证、以及 electron-builder 组装（[`electron-builder.yml`](../../../../apps/desktop/electron-builder.yml)）。
- 安装布局把 shell 放在 asar 内，整个运行时闭包以真实文件放在 `Contents/Resources/runtime/` 下；Electron 主进程把应用二进制自身作为 DSH 子进程分叉（`ELECTRON_RUN_AS_NODE`），从该闭包解析 CLI、Web dist 与 PTY helper，并把用户数据目录交给子进程（[`packaged-runtime.ts`](../../../../apps/desktop/src/packaged-runtime.ts) 定义该契约）。全程不依赖系统 Node.js 或 DSH CLI。
- keyless 打包应用冒烟测试（`apps/desktop/tests/packaged-smoke.e2e.ts`）以 `--smoke` 启动安装后的应用包，在捆绑运行时上重跑 tracer bullet，断言零退出码与自有进程树的静默；失败路径用例给它一个缺失的 replay 文件，断言场景以非零退出码判负时同样静默。macOS CI 任务先打包，并把应用包缺失变成硬失败。
- 桌面包清单兼任部署根清单：其依赖列表即打包运行时闭包，由 `verify-runtime-closure` 强制校验。

问题 #4（原生 macOS 窗口体验）和 #5（载体加固：有界背压与 renderer 生命周期关闭）仍然开放，其验收标准继续适用。#3 打包切片中发布级的签名、公证与跨架构产物延后到后续工单。
