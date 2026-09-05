# Agent Note：macOS 紧凑桌面窗口呈现

Status: implemented

[English](2026-08-16-macos-compact-window-presentation.md) | 中文

## 问题

已发布的 DeepSeek Harness 客户端面向浏览器形态的框架。它在侧栏收起后保留一条窄轨道，也没有 Electron traffic lights、原生 vibrancy、macOS“减少透明度”、窗口焦点或原生全屏的契约。DeepSeek Harness Desktop 需要这些平台行为，但不应复制并长期维护官方侧栏或布局包。

## 决策

Electron shell 负责原生窗口策略，只向 renderer 发布呈现所需的事实。在 macOS 上，`BrowserWindow` 请求 `1280×840` 初始尺寸并设置 `900×640` 最小尺寸，同时使用 `hiddenInset` 标题栏、位于 `(16, 14)` 的 traffic lights、窗口下层 vibrancy 材质与透明背景。启用 context isolation 的 preload bridge 暴露经过校验的浅色、深色和跟随系统偏好，以及实际外观、“减少透明度”、焦点和全屏状态。main process 只接受来自当前窗口 renderer 的消息，并在窗口关闭时移除 IPC、原生主题、焦点和全屏监听器。

子进程 connection 只在 IPC listener 安装后发送 `connection-ready`。supervisor 收到该信号后才发出 `host.describe`，因此较慢的 Client graph 不会在进程启动期间丢失唯一一次 readiness 请求。

桌面 UI 包保持为增量 Client 与 Host contribution。它在 `shell.overlay` 注册窗口控件，在 `settings.general.item` 注册玻璃材质偏好；官方侧栏继续渲染标签、计数、会话和操作。第一行 chrome 把已发布的 panel primitive 放在原生 traffic lights 旁，第二行渲染已发布的鲸鱼、deepseek 与 HARNESS 完整 wordmark。稳定的 slot 属性与桌面拥有的 body 属性驱动一小层 CSS：标题行可以拖动，所有控件保持 no-drag，并在侧栏关闭时为 conversation header 保留避让空间。侧栏变为零宽后，展开按钮仍位于侧栏之外；原生全屏中也是如此。

Client 与 Host 只共享不带运行时依赖的设置契约。Client 入口不导入 Host plugin 及其 Settings、Schemastery 依赖，因此浏览器 bundle 保持产品的 capability 边界。

Host 负责 `ui-sidebar-glass-macos.enabled` 设置。该设置默认开启，并且只在原生 bridge 报告 macOS 且 namespace 可写时提供。renderer 将该偏好与实际主题和“减少透明度”组合：启用玻璃时使用原生材质；偏好关闭或无障碍覆盖生效时，选择明确的浅色或深色不透明表面。无障碍覆盖不会回写已保存的偏好。

两个精确版本 UI 补丁保留已发布包的所有权。`@deepseek-ai/dsh-client-ui-layout@0.1.0-rc.8` 补丁把已收起侧栏的轨道从 56 像素改为零，保留最后一次拖动宽度，并发布稳定的收起状态与解析后宽度。`@deepseek-ai/dsh-client-ui-sidebar@0.1.0-rc.8` 补丁只增加一个稳定 header 属性，使桌面 chrome 无需位置选择器即可只替换该行。runtime manifest 记录每个补丁的摘要、上游来源、测试和移除条件；对应已发布包提供同等契约后即可删除各自补丁。

## 考虑过的替代方案

**复制官方侧栏与布局包。** 否决：这会重复标签、计数、交互行为和未来的上游变更。已发布 primitive、稳定 slot 与框架状态，再加一个最小版本化 header hook，已经足以承载桌面行为。

**保留官方 56 像素收起轨道。** 否决：桌面展开控件可以保持可用，不需要继续占据侧栏宽度。

**让 renderer 代码直接读取 Electron 状态。** 否决：原生主题与窗口生命周期属于 main process。窄 preload bridge 可以保留 context isolation，并让 host 在一个位置完成消息校验和监听器清理。

**持久化可见材质而不是用户偏好。** 否决：“减少透明度”是临时系统事实。持久化其结果会在无障碍设置变化时丢失用户的玻璃选择。

## 后果

- BrowserWindow 创建、外观变化、焦点、原生全屏、缩放和退出继续走 Electron 原生窗口生命周期。
- 浅色、深色、跟随系统、玻璃和不透明状态投影为稳定的 body 属性，shell 无需依赖生成后的 CSS module 类名。
- 侧栏展开时恢复最后一次拖动宽度；收起时网格轨道与原生材质解析为零，同时保留官方侧栏注册。
- 窄窗口会自动收起侧栏并允许手动重开，缩放回宽窗口后恢复保留的宽屏偏好。窗口与全屏状态下的展开控件都保持可达，conversation header 与 view tab 会避开原生 chrome。
- 证据流程同时记录 display bounds 与 work area，但依据显示器几何验证 `BrowserWindow` 外框。初始尺寸与后续宽窗 resize 必须达到请求宽度或显示器限制宽度，高度则位于平台最小值与请求高度或显示器限制高度之间；work area 排除了系统 UI，而窗口边界包含原生 chrome，因此不能用 work area 限制原生外框。
- 每个 Client registration、样式表、主题订阅、设置订阅和原生 bridge 订阅都有明确的 disposer。
- 原生 tracer 在输出 `NATIVE_WINDOW_EVIDENCE` 前，验证真实 macOS 窗口能力、traffic-light 位置、缩放、active → inactive → active 焦点切换、主题、“减少透明度”投影和全屏切换。它还检查计算后的 drag/no-drag 区域，并分别发送输入尝试。带权限门禁的验收路径向父级 driver 发布绝对坐标；外部注入的 CoreGraphics 指针事件必须移动 drag 表面，并且不得移动 no-drag 控件。
- 可见 tracer 表面投影与 contribution 相同且经过校验的原生事实。它在 compositor 稳定后捕获深色、浅色和跟随系统的 PNG 帧，并要求深浅图片不同。另一个离屏 Electron fixture 运行正式桌面注册、加载精确发布版 sidebar 组件与样式，并记录深色玻璃展开、浅色玻璃收起和不透明展开帧。`webContents.capturePage()` 有意不包含原生 traffic-light 图形；这些图形由原生窗口断言覆盖。
- 聚焦测试覆盖原生 bridge 校验与清理、表面投影、主题与无障碍转换、Host 与 Client contribution、contribution disposal 和已安装的布局补丁。侧栏集成测试加载精确的已发布 sidebar Client，操作其 toggle，并保留官方标签、子 slot 与 workspace/count occupant。仓库布局测试按路径和内容保护应用图标与视觉资产。

## 验证

2026-09-05 的 `pnpm run check` 通过 typecheck、lint、全部 workspace build，以及 31 个文件中 182 个测试里的 178 个；3 个缺少打包应用的已安装产品用例与 1 个需要 Accessibility 权限的 OS-pointer 用例被跳过。`pnpm run package` 生成通过完整性验证的 arm64 app 与 DMG，`pnpm run test:package` 通过全部 10 项已安装产品检查。`DSH_DESKTOP_REQUIRE_OS_DRAG=1 pnpm exec vitest run tests/desktop-runtime.e2e.test.ts -t 'moves only the computed drag surface'` 单独覆盖真实 drag/no-drag 用例。`pnpm run test:layout` 覆盖仓库布局边界。聚焦行为由 `tests/desktop-native-window.test.ts`、`tests/desktop-ui-surface.test.ts`、`tests/desktop-ui-runtime.test.ts`、`tests/desktop-ui-host.test.ts`、`tests/desktop-ui-client.test.ts`、`tests/desktop-layout-patch.test.ts`、`tests/desktop-sidebar-integration.test.ts`、`tests/desktop-ui-visual.e2e.test.ts`，以及 `tests/desktop-runtime.e2e.test.ts` 和 `tests/desktop-packaged.e2e.test.ts` 中的真实 Electron 流程覆盖。
