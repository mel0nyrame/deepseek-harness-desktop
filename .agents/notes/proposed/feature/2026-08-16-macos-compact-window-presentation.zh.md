# Agent Note: 紧凑 macOS 桌面窗口呈现

Status: proposed

[English](2026-08-16-macos-compact-window-presentation.md) | 中文

## 问题

当前 macOS 桌面窗口在侧栏和对话区上方都保留了一条横跨全窗的 44 像素标题条。这个由 Web 绘制的条带把对话区与窗口顶端分隔开，也使侧栏控件无法共享紧凑的原生控件区域。侧栏收起后仍会保留固定轨道，在侧栏已经隐藏时浪费横向空间。

窗口需要明确的 macOS 呈现方式：既保留原生 traffic lights 和 macOS 无障碍行为，又让对话区看起来延伸到应用顶端。侧栏需要一个统一的材质边界，并且该材质必须由可持久化的用户设置控制，而不是 renderer 独有的视觉状态。

## 提案

### 范围与所有权

本提案负责 Electron 桌面应用的 macOS 呈现。它细化[Electron 桌面应用提案](2026-08-14-electron-desktop-app.md)中的窗口基线，并且是[问题 #32](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/32)、[问题 #33](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/33)和[问题 #34](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/34)的决策所有者。44 像素标题条是现有基线，不是提议的呈现效果。

macOS 是首个实现的平台。Windows 与 Linux 保留明确的平台呈现扩展点，但不提供占位控件，也不仿制 macOS chrome。

### 紧凑窗口框架

在侧栏紧凑的第一行使用原生 macOS traffic lights，并在其右侧紧邻放置侧栏收起控件。DeepSeek Harness 商标位于侧栏下一行，并将侧栏与对话 header 内容上提至紧凑框架中。traffic lights 与控件所在行只为左上角原生控件预留空间；不透明的对话表面延伸到窗口顶边，其标题行大致与该行对齐。

移除横跨全窗的合成标题条及其全局 renderer 顶部 inset。空白 chrome 区域可拖动原生窗口。traffic lights、侧栏控件、标签页、Session log、可编辑元素和浮层仍是可交互的 no-drag 区域。

Chat / Trajectory 的活动指示线覆盖在 conversation header 分割线上，使蓝色下划线与分割线共用同一条边界，不留可见空隙。

### 零宽侧栏

收起侧栏时，其布局轨道解析为零宽。侧栏材质、内容、调整宽度的 handle 与竖向分割线一同消失。位于零宽侧栏之外的展开控件保持可见，并恢复上一次可用的侧栏宽度；它不保留永久的紧凑轨道。

在窗口化的 macOS 应用中，展开控件与左上角控件区域中的原生 traffic lights 共存。进入原生全屏时，traffic lights 消失，展开控件对齐左侧内容 inset，且不让其余侧栏内容发生垂直重排。手动收起和窄视口自动收起共享零宽渲染结果，同时保留现有的偏好语义。

### 侧栏玻璃偏好

展开后的 macOS 侧栏在原生控件、品牌、工作区、会话和设置区域后方使用一块连续且受支持的原生半透明材质。新会话和已选会话样式保持为该材质上清晰可读的覆盖层。对话表面保持不透明。

现有的 General → Appearance 表面在主题偏好下方提供仅限 macOS 的 `Sidebar glass effect` 开关。它默认开启、即时生效，并通过 Host-backed settings 全局持久化。它不会出现在 Windows 或 Linux 上。

“减少透明度”会强制使用符合当前主题的不透明侧栏 fallback，而不改变已保存的偏好。系统覆盖生效时，该设置会说明 macOS 正在覆盖可见效果。明暗外观下的文字、图标、边框和键盘焦点在任一实际材质中都保持清晰可辨。

### 验证

窗口策略测试覆盖 macOS 选项、traffic-light 位置、材质前提条件和非 macOS 隔离。客户端 shell 测试覆盖可见 header、拖动区域、交互、收起、宽度恢复和全屏关系，而不依赖偶然的 DOM 结构。设置测试覆盖默认值、写入、失效／重新加载后的收敛，以及系统覆盖生效时偏好的保留。

无密钥的真实打包 macOS 流程会记录紧凑窗口、原生控件、拖动行为、收起与展开、宽度恢复、全屏对齐、材质即时切换、重启持久化和“减少透明度” fallback。原生窗口状态会与视觉证据分开断言。

## 考虑过的替代方案

**保留横跨全窗的合成标题条。** 拒绝，因为它会把两个产品列都推到 renderer 绘制的条带下方，无法让对话表面延伸到窗口顶端，也无法只在需要的位置预留原生控件空间。

**保留紧凑的收起侧栏轨道。** 拒绝，因为它会在侧栏收起后继续占用横向空间。位于零宽侧栏外的展开控件可以保留入口，而不让侧栏布局轨道继续存在。

**新建独立的 Appearance 设置页面。** 拒绝，因为现有的 General → Appearance 表面已经负责外观偏好；第二个位置会拆分相关控件，却不会增加平台边界。

**将玻璃状态保存在 renderer 存储中。** 拒绝，因为该偏好是全局的，且必须在应用重启后保留。Host-backed settings 已经负责可持久化的用户偏好，并且允许系统无障碍设置覆盖实际材质而不改写用户意图。

**现在就在 Windows 与 Linux 上提供类似 macOS 的窗口控件。** 拒绝，因为这些系统尚未有获批准的平台设计。明确的扩展点可以保留各自的实现路径，而不展示非原生的占位效果。

## 验收标准

- renderer 不再使用横跨全窗的 44 像素合成标题条或等价的全局顶部 inset。
- macOS 在紧凑侧栏第一行使用真实系统 traffic lights，侧栏收起控件紧邻其右侧，商标位于下一行。
- 不透明的对话表面延伸到顶边；其标题与原生控件行对齐；Chat / Trajectory 的活动指示线与 conversation header 分割线共用边界，且没有可见空隙。
- 空白 chrome 区域能够拖动窗口，所有交互控件仍是 no-drag 区域。
- 收起会移除完整的侧栏布局轨道、材质、内容、调整宽度的 handle 和分割线；展开恢复上一次可用宽度，不保留紧凑轨道。
- 原生全屏会隐藏 traffic lights，并让展开控件左对齐，且不让剩余侧栏内容发生垂直重排。
- 展开后的 macOS 侧栏使用一块连续且受支持的原生半透明材质，而对话区保持不透明。
- General → Appearance 仅在 macOS 上提供默认开启的 `Sidebar glass effect` 开关；它即时生效，并通过全局设置跨重启持久化。
- “减少透明度”会强制不透明 fallback，而不改写已保存的偏好；所有实际外观组合都保持可读且支持键盘访问。
- Windows 与 Linux 保留明确的实现边界，但不出现推测性的平台 chrome 或无功能设置。
- 聚焦的策略、客户端 shell 和设置测试，以及无密钥的打包 macOS GUI 流程覆盖上述行为；中英文文档、本地化产物和文档门禁保持同步。

## 风险

原生 traffic-light 位置、vibrancy 与全屏行为会随 macOS 版本和无障碍设置而变化。因此产品会将原生窗口状态与截图证据分开测试，并保留不透明 fallback。

零宽布局会改变 header 几何、调整宽度行为和响应式收起。共享的渲染状态断言与打包流程会防止紧凑轨道或过期宽度预留通过任一路径重新出现。

玻璃偏好跨越 renderer、Host-backed settings 与平台事实。其实际材质规则必须保持用户偏好的持久性，同时允许“减少透明度”覆盖可见结果。
