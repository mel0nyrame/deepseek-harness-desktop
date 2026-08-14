# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

内置 DeepSeek Harness 运行时的 Electron 桌面应用外壳。Electron 主进程监管一个专用的应用级 DSH 子进程，后者承载 [`desktop` profile](../../apps/cli/README.md)（base + Web 产品 + 关闭全部浏览器传输行的桌面覆盖层）；上下文隔离的 preload 桥承载现有 Connection 协议，打包好的 React 客户端在本地渲染。整个链路不参与任何面向浏览器的 HTTP 监听。

## 开发

`pnpm run dev:desktop`（仓库根目录）先构建工作区，再以开发模式启动 Electron 主进程：DSH 子进程通过 `apps/cli/lib/bin.js` 从源码树启动并运行在环境 Node 上，Web 前端由构建产物 `dist` 提供，退出时终止整个自有进程树。无密钥的开发版 tracer bullet（`apps/desktop/tests/real-composition.e2e.ts`）在不打开窗口的情况下覆盖同一链路。

## 打包（macOS）

`pnpm --filter @deepseek-ai/dsh-desktop run package` 会在 `apps/desktop/dist/mac<可选架构后缀>/DSH Desktop.app` 产出主机架构的无签名应用包，过程分五步（[`scripts/package.ts`](scripts/package.ts)）：

1. **闭包** — `pnpm run verify-runtime-closure` 证明本包的依赖清单提供了所有必需的工作区 peer。
2. **部署** — pnpm legacy deploy 将生产运行时闭包（`dsh` CLI、所有内置插件构建出的 `lib`、Web 前端 `dist`、node-pty 以及无密钥回放提供器）物化到无符号链接的暂存目录。
3. **Electron 恢复** — 当固定版本的 Electron 发行物缺失时（全新安装会通过 Electron 经过审查的 postinstall 下载，`allowBuilds`），由包自带的安装脚本在重建与验证前恢复它。
4. **原生重建** — node-pty 按固定 Electron 版本的 ABI 重新编译（`@electron/rebuild`），随后在 Electron 二进制内加载验证；macOS 的 `spawn-helper` 与重建后的插件并排放置并保留可执行位。
5. **打包** — electron-builder（[`electron-builder.yml`](electron-builder.yml)）组装 `.app`：asar 只携带 `lib/main.js` 与沙箱化 preload，运行时闭包以真实文件形式放在 `Contents/Resources/runtime/` 下。

安装后的应用不依赖系统 Node.js 或 DSH CLI 即可启动：Electron 主进程把应用二进制自身作为 DSH 子进程分叉（`ELECTRON_RUN_AS_NODE`），从 `Contents/Resources/runtime` 解析 CLI、Web dist 与 PTY helper，并把用户数据目录交给子进程作为工作目录（该布局由 [`src/packaged-runtime.ts`](src/packaged-runtime.ts) 定义）。因此原生模块与 PTY helper 永远不会位于归档内。harness 主目录仍为共享的 `~/.dsh`，打包应用与 CLI 看到相同的会话、profile 与配置。

## macOS 原生窗口

macOS `BrowserWindow` 使用 `hiddenInset` 标题栏、固定内嵌位置的 traffic lights、透明客户端表面，以及 Electron 基于 AppKit 的 `under-window` vibrancy，并将 `visualEffectState` 设为 `followWindow`。独立的 44 像素标题区域可拖动；链接、表单控件、按钮、可编辑内容与浮层保持为可交互的 no-drag 区域。系统明暗外观变化通过 Electron `nativeTheme` 传入；macOS“降低透明度”启用时，客户端切换到接近不透明的明色或暗色表面，同时保留清晰的键盘焦点。Electron 支持的接口已满足布局要求，因此应用不包含自定义原生视觉效果 addon。

## 打包产物验收

`apps/desktop/tests/packaged-smoke.e2e.ts` 以两种模式启动安装后的应用包。`--inspect-native-window` 创建真实 `BrowserWindow`，并报告标题栏、traffic lights、透明度、vibrancy、焦点、拖动区域、外观与降低透明度状态，供自动化断言。`--smoke --smoke-replay <file>` 断言完整的无密钥 tracer bullet——创建 Session、由终端执行的 `echo TERMINAL_OK` 工具回合及其有序流式事件、无 TCP 监听、干净退出——并确认没有残留的自有进程。应用包缺失时该用例自跳过；macOS CI 任务会先打包并设置 `DSH_DESKTOP_SMOKE_REQUIRED=1`，把缺失变成硬失败。

## 限制

- tracer bullet 目前无签名、未公证；发布级的签名、公证与跨架构（x64）产物属于后续工单。
- `--smoke` 在未显式指定 `DSH_HOME` 时拒绝运行，因此绝不会触碰机器主人的真实 `~/.dsh`。
