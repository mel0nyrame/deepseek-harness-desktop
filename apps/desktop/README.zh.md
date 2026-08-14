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

## 打包产物冒烟测试

`apps/desktop/tests/packaged-smoke.e2e.ts` 以 `--smoke --smoke-replay <file>` 启动安装后的应用包，断言完整的无密钥 tracer bullet——创建 Session、由终端执行的 `echo TERMINAL_OK` 工具回合及其有序流式事件、无 TCP 监听、干净退出——并确认没有残留的自有进程。失败路径用例给它一个缺失的 replay 文件，断言场景以非零退出码判负时同样静默。应用包缺失时该用例自跳过；macOS CI 任务会先打包并设置 `DSH_DESKTOP_SMOKE_REQUIRED=1`，把缺失变成硬失败。

## 限制

- tracer bullet 目前无签名、未公证；发布级的签名、公证与跨架构（x64）产物属于后续工单。
- 冒烟启动是无窗口的；针对真实窗口的 GUI 验收属于窗口体验工单。
- `--smoke` 在未显式指定 `DSH_HOME` 时拒绝运行，因此绝不会触碰机器主人的真实 `~/.dsh`。
