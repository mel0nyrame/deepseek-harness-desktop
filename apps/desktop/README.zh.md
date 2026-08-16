# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 是 `deepseek-harness-desktop` 仓库内 DSH Desktop 的 Electron 应用包。Electron 主进程监管一个专用的应用级 DSH 子进程，后者承载 [`desktop` profile](../../apps/cli/README.md)（base + Web 产品 + 关闭全部浏览器传输行的桌面覆盖层）；上下文隔离的 preload 桥承载现有 Connection 协议，打包好的 React 客户端在本地渲染。整个链路不参与任何面向浏览器的 HTTP 监听。

## 开发

`pnpm run dev:desktop`（仓库根目录）先构建工作区，再以开发模式启动 Electron 主进程：DSH 子进程通过 `apps/cli/lib/bin.js` 从源码树启动并运行在环境 Node 上，Web 前端由构建产物 `dist` 提供，退出时终止整个自有进程树。无密钥的开发版交互等价场景（`apps/desktop/tests/real-composition.e2e.ts`）在不打开窗口的情况下驱动同一链路：一个持久 Workspace、三个 Session——有序终端流、经载体作答的提问、经载体作答的沙箱升级审批——以及从持久 Session 日志重建全部模型可见输入。

## 载体安全与生命周期

`BrowserWindow` 保持 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`。preload 只暴露启动、unary 请求／取消、流订阅／取消以及流通知操作。Electron main 只接受来自精确 `dsh://app` frame 的调用，并校验每个 payload；子进程到 main 的消息以及 main 到 preload 的生命周期通知会在关联请求或交付 renderer 前再次校验，就绪握手中的 bundle 路径还必须解析为配置的开发或打包运行时根目录下的真实 `.js` 文件。随后由现有 Connection zod schema 在客户端分发前校验 RPC envelope 与 mux／Host frame。

每个 renderer 订阅最多保留 256 个已解析 frame。消费方客户端只在取走每个已交付 frame 之后才确认它（生命周期 open／end 事件在到达时即确认），Electron main 把该确认转发给子进程，同时限制每条流 relay 的 in-flight 与排队状态——frame 上界是安全网，真实 renderer 消费才是节制有序 source 的节流。溢出或重复的 open 通知会取消物理订阅，并按顺序发出 error／end 关闭；renderer 溢出会清空队列、取消物理订阅，并以错误终止 iterator。调用方取消会立即丢弃排队 frame。子进程流泵会在读取下一条 frame 前等待每次 IPC send callback 以及逐 frame 确认，因此原生 channel 背压会暂停有序 source，不会把已经接受的消息误判为丢失。main-frame reload／导航、renderer 崩溃或 renderer 销毁时，Electron main 会取消 renderer 持有的请求与流；子进程 IPC 断连、退出或报错会关闭所有活跃请求与流，应用退出或启动失败则会停止并等待子进程退出。

## 原生桌面操作

renderer 继续使用现有任务级 Workspace 与路径打开 API，不获得对话框、shell、文件系统、Node.js 或通用 Electron primitive。DSH 子进程内的桌面 overlay 提供 `directoryPicker` 与 `nativePathOpener` 服务，只向 Electron main 发送封闭的 `pick-directory` 和 `open-path` 反向请求。main 校验请求与绝对路径，调用 `dialog` 或 `shell.openPath`，并持有可操作的原生失败对话框。请求取消会从 renderer 经 Host 载体传播到 main；子进程断连、generation 移除和应用关停都会中止待处理操作并忽略迟到的原生结算。

## Host 恢复

`DesktopLifecycle` 为受监管的 Host 维护一个显式状态机：`starting`、`running`、`recovering`、`failed`、`stopping` 与 `stopped`。启动超时或配置失败会进入状态页，展示子进程最近的 stderr 尾部以及 Restart/Quit 操作；运行中的 Host 意外退出会触发恰好一次自动重启，恢复失败则回到 failed 状态并保留同样操作。`restart()` 仅在 `failed` 状态可用，因此修复 profile 后无需重新启动应用即可恢复。Host 运行期间，supervisor 会持续刷新退出前的进程归属快照，因此崩溃恢复仍能识别随后被重设父进程到自身进程组的后代（包括 PTY session leader）。所有退出路径共享同一个停止 owner：先请求优雅关闭，再升级到 SIGKILL，清扫可观测进程树；只要仍有自有进程存活，就报告带存活 pid 的、可操作的 `cleanup-incomplete` 失败，绝不宣称关闭成功；清理不完整时会禁用 Restart，避免新 generation 让退出流程遗忘上一棵进程树。

## 打包（macOS）

`pnpm --filter @deepseek-ai/dsh-desktop run package` 会在 `apps/desktop/dist/` 产出主机架构的 ad-hoc 签名应用包与 dmg，过程分六步（[`scripts/package.ts`](scripts/package.ts)）：

1. **闭包** — `pnpm run verify-runtime-closure` 证明本包的依赖清单提供了所有必需的工作区 peer。
2. **部署** — pnpm legacy deploy 将生产运行时闭包（`dsh` CLI、所有内置插件构建出的 `lib`、Web 前端 `dist`、node-pty 以及无密钥回放提供器）物化到无符号链接的暂存目录。
3. **Electron 恢复** — 当固定版本的 Electron 发行物缺失时（全新安装会通过 Electron 经过审查的 postinstall 下载，`allowBuilds`），由包自带的安装脚本在重建与验证前恢复它。
4. **原生重建** — node-pty 按固定 Electron 版本的 ABI 重新编译（`@electron/rebuild`），随后在 Electron 二进制内加载验证；macOS 的 `spawn-helper` 与重建后的插件并排放置并保留可执行位。
5. **打包** — electron-builder（[`electron-builder.yml`](electron-builder.yml)）组装并 ad-hoc 签名（`identity: '-'`，无需 Apple 凭据）`.app` 与 `.dmg`：asar 只携带 `lib/main.js` 与沙箱化 preload，运行时闭包以真实文件形式放在 `Contents/Resources/runtime/` 下。
6. **证据** — 每个产出的制品都通过 [`scripts/artifact-evidence.ts`](scripts/artifact-evidence.ts)：`codesign --verify --deep --strict` 证明签名有效，`spctl --assess` 记录 Gatekeeper 的评估结果，`hdiutil verify` 校验 dmg 镜像。

安装后的应用不依赖系统 Node.js 或 DSH CLI 即可启动：Electron 主进程把应用二进制自身作为 DSH 子进程分叉（`ELECTRON_RUN_AS_NODE`），从 `Contents/Resources/runtime` 解析 CLI、Web dist 与 PTY helper，并把用户数据目录交给子进程作为工作目录（该布局由 [`src/packaged-runtime.ts`](src/packaged-runtime.ts) 定义）。因此原生模块与 PTY helper 永远不会位于归档内。harness 主目录仍为共享的 `~/.dsh`，打包应用与 CLI 看到相同的会话、profile 与配置。

ad-hoc 签名背后没有身份。Gatekeeper 只评估带 quarantine 属性的启动，因此本地构建的制品打开时不被评估，而 `spctl --assess` 本身会拒绝一切 ad-hoc 签名——打包管线把该结论记录为证据，接入 Developer ID 身份签名后它会变成硬门禁。下载的副本带有 `com.apple.quarantine`，会显示无法验证开发者的大门，需要一次性右键 → 打开（Homebrew cask 分发会剥离 quarantine）。要让下载副本也零警告，需要 Developer ID 签名与公证——即付费 Apple Developer Program 凭据；`electron-builder.yml` 记录了凭据到位后要填写的字段。打包脚本只构建主机架构，因为 node-pty 按主机 ABI 重建；x64 制品由 [`desktop-release.yml`](../../.github/workflows/desktop-release.yml) 的 CI 矩阵（`macos-26-intel`）产出。

## macOS 原生窗口

macOS `BrowserWindow` 使用 `hiddenInset` 标题栏、固定内嵌位置的 traffic lights、透明客户端表面，以及 Electron 基于 AppKit 的 `under-window` vibrancy，并将 `visualEffectState` 设为 `followWindow`。独立的 44 像素标题区域可拖动；链接、表单控件、按钮、可编辑内容与浮层保持为可交互的 no-drag 区域。客户端根节点以绝对定位位于该区域下方（`inset: 44px 0 0`），标题区域不会遮挡或推移内容。系统明暗外观变化通过 Electron `nativeTheme` 传入；macOS“降低透明度”启用时，客户端切换到接近不透明的明色或暗色表面，同时保留清晰的键盘焦点。Electron 支持的接口已满足布局要求，因此应用不包含自定义原生视觉效果 addon。

## 打包产物验收

`apps/desktop/tests/packaged-smoke.e2e.ts` 以七种模式启动安装后的应用包。`--inspect-native-window` 创建真实 `BrowserWindow`，并报告标题栏、traffic lights、透明度、vibrancy、焦点、拖动区域、外观与降低透明度状态，供自动化断言。`--accept-native-window` 在装配好的渲染器上打开可见窗口，断言 active → inactive → active 焦点切换、最小化/恢复、标题区域拖动输入尝试、44 像素标题区域布局且内容不被遮挡、计算得到的 drag/no-drag 区域，以及真实输入框的键盘路径。`--record-native-window --smoke-replay <file> [--smoke-child-replay <file> …]` 配合 `DSH_DESKTOP_FRAMES_DIR` 录制真实渲染器帧：启动、焦点切换、标题区域拖动尝试、键盘操作、最小化/恢复、明暗外观、装配 UI 中回放的 terminal 回合，以及通过装配好的提问面板与审批面板作答的提问回合与审批回合，并在结束后把 `nativeTheme.themeSource` 恢复为进入录制模式时的值。`--record-native-actions` 配合 `DSH_DESKTOP_FRAMES_DIR` 保留真实安装态窗口、preload、ApiProxy、子进程反向 IPC、Workspace 接纳与 Session 导航，只替换为确定性的对话框／shell primitive；它会记录已接纳 Workspace 及结构化的成功与可操作失败证据，因为 renderer capture 无法包含原生对话框。`--record-recovery --smoke-replay <file>` 配合 `DSH_DESKTOP_FRAMES_DIR` 会植入损坏的 desktop profile，录制失败状态页、受控重启与恢复后装配 UI 中回放 terminal 回合的真实渲染器帧，随后干净退出。`--smoke --smoke-replay <file> [--smoke-child-replay <file> …]` 断言完整的无密钥交互等价场景——持久 Workspace 的创建与幂等重开、由终端执行的 `echo TERMINAL_OK` 工具回合及其有序流式事件、经载体作答的提问回合与沙箱升级审批回合、从持久 Session 日志重建全部模型可见输入、无 TCP 监听、干净退出——并确认没有残留的自有进程。第二次以 `--smoke-reopen --smoke-home <dir>` 启动同一持久主目录，断言 Workspace 与三个 Session 无需任何模型调用即从现有持久化中重建。应用包缺失时该用例自跳过；macOS CI 任务会先打包并设置 `DSH_DESKTOP_SMOKE_REQUIRED=1`，把缺失变成硬失败。

## 限制

- 制品目前为 ad-hoc 签名、未公证：下载的副本需要一次性右键 → 打开，直到接入 Developer ID 签名与公证（付费 Apple Developer Program）。
- `--smoke` 在未显式指定 `DSH_HOME` 时拒绝运行，因此绝不会触碰机器主人的真实 `~/.dsh`。
- 启动恢复本身不会修复 profile：`restart()` 会以同一配置重试，因此必须先修复损坏的 profile，Restart 才能进入 running 状态。
- 崩溃恢复的进程归属快照每秒刷新一次，因此完全在两次刷新之间创建并失去父进程的后代，只能在进程组仍可识别它时被清扫。
- `capturePage()` 只能看到渲染器像素：录制的帧不包含原生 traffic lights 图形，合成输入也无法像操作系统指针拖拽那样移动原生窗口。证据由两部分组成——帧与受检的已配置/已观测原生窗口状态；具备屏幕录制权限的机器可以用系统级捕获替换帧，而断言无需改动。
- **原生对话框无法程序化关闭** — Electron 的 `dialog.showOpenDialog` 没有关闭或中止接口，因此取消请求只会让操作在逻辑上结算并忽略迟到结算，已经显示的原生对话框会保留到用户主动关闭。
