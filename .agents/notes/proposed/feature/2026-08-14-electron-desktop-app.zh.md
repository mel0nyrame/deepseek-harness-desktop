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

第一个产品目标是适用于 Apple silicon 和 Intel Mac、经过签名和公证的 macOS 应用。窗口使用 macOS inset title bar、原生 traffic lights、Electron 基于 AppKit 的 vibrancy，以及透明客户端表面。除非 Electron 支持的接口无法提供所需的分区视觉效果，否则推迟原生 addon。已批准的呈现细节由[紧凑 macOS 窗口决策](../../implemented/feature/2026-08-16-macos-compact-window-presentation.md)负责。

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
- macOS 使用 `hiddenInset` title bar、可配置 traffic-light 位置、活动窗口 vibrancy 和透明 CSS 表面。文字和控件必须保持足够不透明度，以满足对比度和无障碍要求。紧凑窗口提案负责呈现专用的布局、设置和平台边界决策。
- 分区 `NSVisualEffectView` addon 是经过测量后才启用的 fallback。只有原型证明 Electron 支持的 vibrancy 控制无法实现所需布局时才引入它。
- 当运行时加载或执行需要真实文件系统路径时，将原生模块和 helper 可执行文件放在归档外。确定生产 Electron 版本前，先验证 Electron ABI 兼容性。
- 产出 arm64 和 x64 的已签名、已公证 macOS artifact。可选择 universal 打包，但两个架构都必须通过相同的已安装应用冒烟测试。

### 测试决策

主要验收 seam 是已安装的桌面应用。一个无密钥测试启动打包后的 Electron 应用，等待真实内置 DSH 子进程就绪，通过 renderer 创建 Session，运行由终端支持的场景，在 conversation 中观察流式输出，退出应用，并验证 DSH 进程、PTY 和后代进程树均已退出。这是现有最高产品 seam，能够覆盖新 shell，又不会用 mock 替代 DSH 行为。

支撑性测试把可复用的 Client Connection 载体约定（`packages/client/connection/tests/carrier-contract.client.ts`）应用于 Electron 适配器。传输无关的 harness 控制逻辑流投递、断线和存活订阅计数，不导入浏览器或 Electron primitive。它通过 React 调用方所使用的同一 `IApiClient` 接口覆盖一元成功与失败信封、Client 对 Host 请求的响应、有序 mux 与 Host 流、就绪、取消、畸形消息、断线、有界订阅生命周期及清理；Electron 专属测试另行覆盖 IPC 机制。

supervisor 测试覆盖成功启动、启动超时、配置失败、子进程意外退出、一次受控重启、启动期间退出应用，以及先终止再等待退出的清理。对于 mock 无法证明的生命周期声明，进程树断言在 macOS 上使用真实子进程。

macOS GUI 验收针对真实 Electron 窗口运行，并按仓库 GUI 策略记录用户可见工作流。它检查 title bar 控件、拖动和交互区域、明暗外观、减少透明度时的 fallback、焦点、键盘访问和稳定渲染。截图可以记录 vibrancy，但自动断言必须检查配置的原生窗口状态，因为像素本身无法区分原生模糊和半透明颜色。紧凑窗口提案补充呈现专用的 GUI 验收要求。

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

独立交付的 connection provider 结构由[桌面 IPC connection provider 决策](../../implemented/architecture/2026-08-25-desktop-ipc-connection-provider.md)记录。本提案继续拥有应用监督、renderer 资源交付、原生反向操作、安装态应用验收与发布证据。

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
- macOS 窗口具有 inset traffic lights、正确拖动区域、受支持的原生 vibrancy、明暗外观行为，以及无障碍的减少透明度 fallback。紧凑窗口提案补充已批准的呈现要求。
- 现有 Web 客户端继续使用当前 HTTP/WebSocket 开发和部署路径，Electron 依赖不得进入浏览器 bundle。
- 打包应用验收测试、carrier 约定测试、supervisor 生命周期测试、GUI 证据和签名／公证检查全部通过。

## 风险

Electron 会增加应用体积和内存使用。该决策接受此成本，因为保留现有客户端和 Node Host 可以降低实现风险，避免重复产品逻辑。

原生依赖可能因 Electron ABI、架构、归档位置、hardened runtime 或签名规则而失败。纵向原型和各架构 artifact 冒烟测试必须在功能扩展前解决这些故障。

两层 IPC 会增加生命周期和背压复杂度。流 channel 需要有界队列、取消和确定性关闭，以免缓慢或断开的 renderer 无限期保留 Host 资源。

Electron 的 `dialog.showOpenDialog` 没有程序化关闭或中止接口，因此取消只会让进行中的原生操作在逻辑上结算，已经显示的原生对话框会保留到用户主动关闭。

原生 vibrancy 可能降低对比度，并会随系统外观、非活动窗口、无障碍设置和未来 macOS 版本变化。产品必须提供足够不透明的 token 和减少透明度 fallback，不能把一张截图视为约定。

子进程隔离可以防止 Host 故障带崩 Electron main，但不会为 DSH 提供安全沙箱。工具权限和子进程沙箱策略仍由 DSH 负责；桌面 shell 不得暗示比 harness 配置更强的限制。

## 实施状态

解耦后的 workspace 现在已经交付集成运行时 tracer bullet。`apps/desktop` 是生产部署根与 Electron 生命周期 owner：编译后的主进程通过 Electron 可执行文件的 Node 模式 fork 精确发布的 `@deepseek-ai/dsh` CLI，经 desktop IPC 载体等待真实 `host.describe` 往返，路由 sandboxed preload 桥，并在正常退出、启动中退出、启动失败和受控重启时 join 自己持有的进程树。shell 不持有第二套 Cordis 或 agent runtime。

`desktop` profile 仍由插件组合。`packages/bundle/cordis.patch.yml` 禁用浏览器启动、WebServer、Web runtime、浏览器 client modules 与官方 Web connection，并挂载官方 native directory-picker provider 以及 desktop 自有的 connection、native 和 UI provider。profile bootstrap 校验嵌入组件版本，发布包提供的 profile module fallback 把同一应用闭包暴露给 workspace 外的 profile，应用启动时无需安装包。

`runtime/runtime-manifest.json` 与 `scripts/assemble-runtime.ts` 从 `@dsh-desktop/shell` 组装，除 official DSH 与原生制品外还核验 shell 和 bundle 入口，并把部署副本中的 `workspace:*` specifier 实化为已安装 desktop 包版本，同时不修改源码 manifest。`tests/desktop-runtime.e2e.test.ts` 在该组装闭包上启动真实 Electron 应用，创建 Session，观察运行真实 bash／PTY 路径的有序录制模型回合并显示 `TERMINAL_OK` 与 `DONE`，从 Session history 重建输入和工具结果，证明 DSH child 没有 TCP listener，并核验正常退出、启动中退出以及连续两次配置启动失败后的静止状态。在 `DSH_DESKTOP_PROCESS_EVIDENCE=1` 下，E2E 记录每个自有 root／descendant 的 PID 与 `lstart`，并在 Electron 退出后断言它们都不再存活；原始 keyless tracer 记录 DSH root，启动中退出场景记录启动 root，连续两次配置失败场景记录两代 root。启动页与 tracer 状态页使用桌面生命周期页面的居中系统字体层级；背景材质仍由 issue #69 的原生窗口任务负责。聚焦的 supervisor 与进程树测试钉住 readiness timeout、无效配置、意外退出、一次受控重启、SIGTERM／SIGKILL 进程树清扫及 terminate-and-join 行为。真实 macOS 进程测试覆盖优雅清理、强制升级、重挂的根进程组后代、存活 PTY，以及从退出前快照恢复独立进程组 PTY。

Issue #67 的验收结果已在 macOS arm64 上通过 `pnpm run check` 记录：typecheck、lint、全部 workspace build，以及 12 个文件中的全部 75 个测试均通过。该次运行包含聚焦的 supervisor、renderer-policy 与进程树套件、五场景真实 macOS 进程测试，以及三场景真实组合 Electron E2E。

问题 #1 与 #2 已通过开发路径交付第一个垂直切片：

- 可复用的 Client Connection 载体契约（[`carrier-contract.client.ts`](../../../../legacy/packages/client/connection/tests/carrier-contract.client.ts)）锁定了 unary、反向响应、mux 流和 host 流语义，以及就绪、顺序、取消、畸形消息、断连和订阅生命周期行为；HTTP/WebSocket 载体和新的 Electron 载体均原样通过该契约。
- 开发版 tracer bullet 通过 `pnpm run dev:desktop` 运行：Electron shell（[`apps/desktop`](../../../../legacy/apps/desktop)）监督一个专属 DSH 子进程（`--profile desktop`，即内置的 `base + web-app + desktop-app` overlay）。该 overlay（[`packages/bundle/desktop-app`](../../../../legacy/packages/bundle/desktop-app)）禁用全部浏览器传输行（`web-startup`、`webserver`、`web-runtime`、`client-hmr`），挂载原生选择器 client half，并通过子进程运行时提供选择器和路径打开器——路径中不参与任何 loopback HTTP 监听。
- renderer 只能通过沙箱化、context-isolated 的 preload 桥访问 DSH；[`DesktopApiClient`](../../../../legacy/packages/client/connection/src/client/desktop-api-client.ts) 在其上实现现有 `IApiClient` 接口。Host 侧 Connection 与 client-modules 插件仅在存在 WebServer 时才挂载 Web 传输，因此 Web 开发工作流保持不变。
- 一个 keyless 真实组合 e2e（[`apps/desktop/tests/real-composition.e2e.ts`](../../../../legacy/apps/desktop/tests/real-composition.e2e.ts)）fork 真实的 desktop profile，创建 Session，重放一段已录制的 `bash` 工具回合，断言 mux 流中按序流式到达的 `TERMINAL_OK` 结果，并验证 terminate-and-join 退出后没有残留后代进程。

问题 #3 已交付打包应用切片：

- `pnpm --filter @deepseek-ai/dsh-desktop run package` 通过六个阶段（[`scripts/package.ts`](../../../../legacy/apps/desktop/scripts/package.ts)）产出主机架构的 ad-hoc 签名 macOS 应用包与 dmg：闭包校验（`verify-runtime-closure` 现在同时检查两个部署清单）、将生产运行时闭包 pnpm legacy deploy 到无符号链接的暂存目录、按 Electron ABI 重建 node-pty 并在 Electron 二进制内加载验证、electron-builder 组装与 ad-hoc 签名（[`electron-builder.yml`](../../../../legacy/apps/desktop/electron-builder.yml)），以及签名／Gatekeeper／镜像证据门禁（[`artifact-evidence.ts`](../../../../legacy/apps/desktop/scripts/artifact-evidence.ts)）。跨架构产物由 [`release.yml`](../../../../legacy/.github/workflows/release.yml) 的 CI 矩阵产出。
- 安装布局把 shell 放在 asar 内，整个运行时闭包以真实文件放在 `Contents/Resources/runtime/` 下；Electron 主进程把应用二进制自身作为 DSH 子进程分叉（`ELECTRON_RUN_AS_NODE`），从该闭包解析 CLI、Web dist 与 PTY helper，并把用户数据目录交给子进程（[`packaged-runtime.ts`](../../../../legacy/apps/desktop/src/packaged-runtime.ts) 定义该契约）。全程不依赖系统 Node.js 或 DSH CLI。
- keyless 打包应用冒烟测试（`apps/desktop/tests/packaged-smoke.e2e.ts`）以 `--smoke` 启动安装后的应用包，在捆绑运行时上重跑 tracer bullet，断言零退出码与自有进程树的静默；失败路径用例给它一个缺失的 replay 文件，断言场景以非零退出码判负时同样静默。macOS CI 任务先打包，并把应用包缺失变成硬失败。
- 桌面包清单兼任部署根清单：其依赖列表即打包运行时闭包，由 `verify-runtime-closure` 强制校验。
- CI 触发 PR 暴露了两个分支级缺陷并在此修复：Connection 与 client-modules 的可选 WebServer 挂载改用捕获的 `ctx.get()` 值传递（Node 22 下直接属性访问会在 fiber 边界抛出 "cannot get property webServer without inject"）；`electron` 加入 `allowBuilds`，并新增打包恢复步骤，保证全新安装始终携带管线所校验的固定版本发行物。

问题 #4 已交付 macOS 原生窗口切片：

- 真实 `BrowserWindow` 使用 `hiddenInset` chrome、固定内嵌位置的 traffic lights、透明客户端表面，以及 Electron 基于 AppKit 的 `under-window` vibrancy，并将 `visualEffectState` 设为 `followWindow`。客户端根节点以绝对定位位于 44 像素区域下方（`inset: 44px 0 0`），标题区域不会遮挡或推移内容列。
- 独立的 44 像素标题区域可拖动，链接、控件、可编辑内容与浮层保持为 no-drag 区域。Electron `nativeTheme` 更新系统外观与“降低透明度”状态；无障碍 fallback 使用接近不透明的明色或暗色表面，并保留清晰的键盘焦点。
- 打包验收通过 `--inspect-native-window` 启动真实 `BrowserWindow`，检查配置选项、实际原生背景与焦点状态、计算后的拖动区域，以及全部 renderer 外观／透明度组合。`--accept-native-window` 在可见窗口中打开装配好的渲染器，断言 active → inactive → active 焦点切换、最小化／恢复、标题区域拖动输入尝试、44 像素标题区域布局且内容不被遮挡、计算得到的 drag/no-drag 区域，以及真实输入框的键盘路径。`--record-native-window --smoke-replay <file>` 配合 `DSH_DESKTOP_FRAMES_DIR` 录制真实渲染器帧：启动、焦点切换、标题区域拖动尝试、键盘操作、最小化／恢复、明暗外观与装配 UI 中回放的 tracer 回合，并在 `finally` 中把 `nativeTheme.themeSource` 恢复为进入录制模式时的值；同一验收套件中的打包冒烟测试另行证明无窗口 tracer-bullet 工作流。
- 本机 macOS 缺少屏幕录制与辅助功能自动化权限，因此录制帧来自 `webContents.capturePage()`：帧不含原生 traffic lights 图形，合成输入也无法像操作系统指针拖拽那样移动原生窗口。证据由帧与受检的已配置／已观测原生窗口状态共同构成；具备权限的机器可以用系统级捕获替换帧，而断言无需改动。
- Electron 支持的接口已满足所需布局，因此未加入原生视觉效果 addon。

上述 44 像素标题条是问题 #4 已实现的基线，而不是已经批准的目标呈现。[紧凑 macOS 窗口决策](../../implemented/feature/2026-08-16-macos-compact-window-presentation.md)负责通过问题 #32–#34 替换该基线、实现零宽侧栏行为和持久化侧栏玻璃偏好。问题 #33 与 #34 依赖问题 #32，并可在该基础工作完成后分别推进。

问题 #5 已交付载体加固切片：

- [`DesktopApiClient`](../../../../legacy/packages/client/connection/src/client/desktop-api-client.ts) 每条逻辑流最多保留 256 个已解析 frame。溢出会清空队列、取消物理订阅并以错误终止；调用方取消会先丢弃排队 frame 再关闭。共享 zod wire schema 仍会在 Connection 分发前解析每个 server-request envelope 与 mux／Host payload。
- desktop 子进程 runtime 会在业务分发前校验每条父进程命令。每条流都会等待子进程 IPC send callback 后再读取下一条 frame，因此原生 channel 背压会限制 in-flight 工作并保持已接受消息的顺序；传输故障会中止 source 并被报告，而不会被误称为背压。Electron main 会校验每条子进程消息，并且只接受解析为配置运行时根目录下真实 `.js` 文件的就绪握手 bundle 路径；preload 则会在交付 renderer 前再次校验生命周期通知。
- Electron main 通过有界 relay 确认 renderer 交付，每条流只保留有限的 in-flight／排队窗口；溢出或重复的 open 通知会取消子进程订阅，并按顺序发出 `error`／`end` 关闭。preload 使用一个通知 dispatcher，每条事件只发送一次确认。每种逻辑 `mux` 与 `host` 流最多允许一个活跃订阅。
- [`DshSupervisor`](../../../../legacy/apps/desktop/src/supervisor.ts) 持有 renderer 请求与订阅的关联关系。取消会立即释放关联；main-frame reload／导航、renderer 崩溃／销毁、子进程 IPC 断连／退出／报错、应用 stop 与启动失败都会结算各自持有的资源，不留下存活流或子进程。listener 异常由各自 dispatcher 内部隔离。
- 沙箱化、context-isolated 的 renderer 仍然只接收窄 preload 桥，Web 产品保留 HTTP/WebSocket 载体且不引入 Electron 运行时依赖。这次仅传输层变化不新增模型可见输入或输出；Electron／Web 共享载体约定、聚焦的 client／runtime／preload／supervisor 测试、真实 desktop 组合以及安装态窗口 tracer 场景共同钉住该行为。
- 安装态窗口录制场景在产品自身 seam 上暴露了驱动侧的三个竞态。其一，hero workspace 选择器的菜单在工作区基线与目录选择流程占位数挂载完成前不渲染任何内容，驱动脚本此前的重试点击实际上把已打开的选择器反复关掉了；现在驱动脚本会持续点击直到触发器的 `aria-expanded` 表明选择器确实已打开（绝不重复点击已打开的选择器），再等待可见菜单行出现。其二，`connectWorkspace` 只要其复用扫描暂时看不到空白会话就会现场新建一个会话，因此此前通过 wire 预创建会话的做法会与该扫描竞态，把回合写到驱动脚本从未轮询的那个会话里——提交的回合其实一直是 durable 的，只是落在选择器新建的会话中。驱动脚本不再预创建会话，而是通过 `workspace.list` 发现真实旅程打开的唯一会话（有界轮询，零个或多个都会响亮失败），聚焦的 `acceptance.spec.ts` 套件钉住了该行为。其三，驱动脚本的 select-all 加 `insertText` 替换在合成点击后会与应用自身的渲染帧竞态，偶尔把替换变成拼接；现在驱动脚本先冲刷动画帧再全选，并在发送前以重试验证草稿的精确内容。

问题 #7 已交付 Host 恢复切片：

- [`DesktopLifecycle`](../../../../legacy/apps/desktop/src/lifecycle.ts) 拥有唯一显式状态机——`starting`、`running`、`recovering`、`failed`、`stopping`、`stopped`——并作为单一退出 owner。启动超时或配置失败会进入状态页，展示子进程最近的 stderr 尾部与 Restart/Quit 操作；运行中的 Host 发生一次意外退出时触发恰好一次自动重启，恢复失败则回到 failed 状态并保留同样操作。按代记录的 ready 标记可避免把启动失败已上报后的迟到退出误判为崩溃。
- [`process-tree.ts`](../../../../legacy/apps/desktop/src/process-tree.ts) 基于 `ps -axo pid=,ppid=,pgid=,lstart=,stat=,command` 实现 POSIX 关闭阶梯：快照为存活后代加进程组成员，`lstart` 用于识别 pid 复用，zombie 被排除，组信号去重并带有本组保护。[`DshSupervisor`](../../../../legacy/apps/desktop/src/supervisor.ts) 在子进程运行期间每秒刷新一次退出前的进程归属快照；停止时先请求 SIGTERM，在有界等待后升级为 SIGKILL，清扫并核验进程树；只要仍有进程存活，就以 `left N surviving process(es)` 列出 pid 与命令并拒绝成功，生命周期将其报告为可操作的 `cleanup-incomplete` 失败。
- 位于 `dsh://app/status.html` 的状态页只通过 preload 桥暴露 Restart 与 Quit，且该桥只在该精确 frame 上可用。手动 `restart()` 仅允许从 failed 阶段发起；清理不完整时不再提供 Restart，避免新 generation 让上一棵进程树成为孤儿。
- 实际覆盖：[`process-tree.spec.ts`](../../../../legacy/apps/desktop/tests/process-tree.spec.ts) 与 [`lifecycle.spec.ts`](../../../../legacy/apps/desktop/tests/lifecycle.spec.ts) 驱动确定性表与伪 spawn；[`process-tree.e2e.ts`](../../../../legacy/apps/desktop/tests/process-tree.e2e.ts) 在 macOS 上证明优雅终止、SIGTERM 免疫后的升级、被重设父进程的后代与孤儿清扫，以及真实 node-pty 清理；[`recovery.e2e.ts`](../../../../legacy/apps/desktop/tests/recovery.e2e.ts) 走通开发版恢复旅程；打包态 `--record-recovery` 验收记录 startup-failed、restarting、session-recovered 与 tracer-settled 帧，并断言没有残留的已安装应用进程。

问题 #8 已交付原生桌面操作切片：

- 桌面子进程现在通过一个封闭的反向请求联合提供 `directoryPicker` 与 `nativePathOpener`：`pick-directory` 和 `open-path`。Electron main 校验每条请求，只接受不含 NUL 字节的非空绝对路径，检查目标可用性，调用 `dialog` 或 `shell.openPath`，并持有可操作的原生失败对话框；renderer 仍然只接收现有任务级 Workspace 与 Host API。
- 取消会沿 owner 任务从 renderer 的 `AbortSignal` 传播至 `host.pickDirectory`、桌面子进程关联和主进程处理器。畸形请求、重复 id、不可用目标、子进程断连、处理器移除、组装 disposal 与应用关停都会确定性释放关联；迟到的原生结算不能复活已完成操作。
- desktop profile 挂载无渲染的原生选择器 client half，由子进程运行时提供能力，因此 Web 部署保留现有 native／browse 组合。ApiProxy 路径打开器接收产品 shell adapter，无需把 Host 路径解析或业务分发移入 Electron main。
- 聚焦的处理器、协议、supervisor、client runtime 与无渲染 flow 测试钉住校验和清理。安装态 `--record-native-actions` 旅程保留真实窗口、preload、ApiProxy、反向 IPC、Workspace 接纳与 Session 导航，只替换确定性的对话框／shell primitive，并记录选中的 Workspace、成功打开和不可用路径失败；Workspace 发现使用 Host 的 canonical realpath，而不是选择器返回的 macOS 原始别名。

问题 #6 已完成交互一致性并关闭。问题 #9 已交付 ad-hoc 签名这一档（[发布签名 note](../../implemented/process/2026-08-16-desktop-release-artifact-signing.md)）；Developer ID 公证由问题 #28 跟踪，受 Apple Developer Program 凭据阻塞。
