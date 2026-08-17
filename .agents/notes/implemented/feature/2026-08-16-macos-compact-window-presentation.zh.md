# Agent Note：macOS 紧凑桌面窗口呈现

Status: implemented

[English](2026-08-16-macos-compact-window-presentation.md) | 中文

## 问题

macOS 桌面窗口曾在侧栏和对话区上方保留一条全宽 44 像素标题条，侧栏收起后仍保留固定轨道。这会把对话区与窗口顶端隔开，让原生控件无法进入产品框架，并在收起后浪费横向空间。侧栏还需要一个可持久化的材质偏好，其可见结果能够跟随 macOS 无障碍设置。

## 决策

紧凑原生窗口框架由[macOS 原生窗口基础 Agent Note](2026-08-17-macos-compact-window-foundation.md)实现，该 Note 负责问题 #32。本 Note 负责已完成的问题 #33 零宽侧栏呈现和问题 #34 侧栏材质偏好。

在 macOS 上，侧栏第一行与原生 traffic-light 区域共享空间，侧栏控制位于其右侧，字标位于下一行，对话表面延伸到窗口顶端。实际处于最上层的对话头部、侧栏控制行与字标行、以及模态框标题行是拖动区域；控件、对话内容、输入区与模态框正文保持为可交互的 no-drag 区域。侧栏收起后解析为零宽网格轨道；材质、内容、调整宽度的 handle 与分隔线一并消失，由框架拥有的展开控件恢复最后一次可用宽度。原生全屏时，traffic lights 的显隐交给 AppKit，展开控件移动到侧栏内容内缩位置。

展开后的侧栏使用一块连续的原生半透明材质，会话与详情表面保持不透明。两种玻璃变体都直接呈现该材质；[原生浅色侧栏材质 Agent Note](../bug-fix/2026-08-18-native-light-sidebar-material.md)负责由应用偏好选择匹配的 AppKit 外观。General → Appearance 根据 Host 设置 `ui-sidebar-glass-macos.enabled` 渲染仅 macOS 提供的 `Sidebar glass effect` 开关。默认值为开启，写入立即生效并跨重启保留。“减少透明度”只选择与主题匹配的不透明材质，不改写保存偏好；因此恢复系统透明度后，只要偏好仍开启就会再次显示玻璃。桌面 bundle 仅在 `process.platform === 'darwin'` 时插入 Host contribution，因此 Web、Windows 与 Linux 不会注册或显示该控件。

## 考虑过的替代方案

**保留全宽合成标题条。** 否决：它阻止对话区延伸到窗口顶部，并在原生控件集群之外继续占用 renderer 空间。

**保留紧凑的收起侧栏轨道。** 否决：收起后仍持续占用宽度。由框架拥有的展开控件可以保留入口，而不保留侧栏轨道。

**新建独立 Appearance 页面。** 否决：General → Appearance 已经拥有主题偏好，也是现有的平台感知设置表面。

**将玻璃状态保存在 renderer 存储中。** 否决：该偏好是全局偏好，必须跨重启保留。Host-backed settings 提供持久边界，并允许“减少透明度”只覆盖实际材质。

**根据 renderer 偏好覆盖 Electron 的全局原生主题。** 这项原始选择已由[原生浅色侧栏材质 Agent Note](../bug-fix/2026-08-18-native-light-sidebar-material.md)取代：局部 tint 无法把深色 AppKit 底层材质变成原生浅色材质，因此现在会有意让操作系统绘制的 chrome 与 Electron UI 匹配显式应用偏好。

**在每种组合中注册该偏好。** 否决：Web、Windows 与 Linux 不具备原生材质和 macOS 无障碍事实。专用 macOS Host contribution 让平台边界保持明确。

## 后果

- `AppFrame` 暴露 frame、sidebar、conversation 与 details 的稳定表面 hook，桌面 CSS 无需耦合 CSS module 生成的类名。
- 桌面 renderer 发布平台、主题与“减少透明度”事实；侧栏 runtime 负责即时投影与 Host 持久化，系统事实不会回写保存偏好。只有 macOS namespace 同时存在且可写时，控件才可用。
- `@deepseek-ai/dsh-client-ui-theme/sidebar-glass` 是依赖 settings 的 Host-only 导出。`cordis.patch.yml` 仅在 macOS 插入它，ApiProxy 将该 namespace 暴露给桌面 renderer。
- macOS 桌面 CSS 让侧栏后代保持透明，使 hover、选中与焦点继续作为统一原生材质上的覆盖层；明暗不透明 fallback 使用明确的 neutral 表面。
- 聚焦的客户端、Host 组合、窗口策略与打包测试覆盖默认开启、即时切换、重启持久化、主题切换、“减少透明度”覆盖、零宽收起和非 macOS 隔离。打包验收流程的三个阶段共用一个明确的测试 home。
