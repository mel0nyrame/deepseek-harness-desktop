# Agent Note：侧边栏零宽度收起

Status: implemented

[English](2026-08-17-zero-width-sidebar-collapse.md) | 中文

## Problem

零宽度收起是已批准的[紧凑 macOS 窗口呈现](../../proposed/feature/2026-08-16-macos-compact-window-presentation.md)（Issue #32–#34）中侧边栏的一半。收起侧边栏时仍会留下一个固定的 56px 紧凑轨道：侧边栏材质、内容、缩放手柄与分隔线都留在屏幕上，对话区只收回轨道宽度，而收起开关本身也住在轨道里。紧凑 macOS 窗口框架（Issue #32）还让轨道几何与原生 traffic lights 行冲突——轨道有自己的收起几何，收起状态下开关无法与灯组共处同一行。

## Decision

收起的侧边栏解析为零宽度布局轨道（Issue #33）。让步求解器对关闭的侧边栏返回 0，侧边栏子树在 150ms 交叉淡化结束后卸载，列的分隔线被去掉，缩放手柄不再渲染——不再保留任何固定紧凑轨道。收起展开控件由布局框架（AppFrame）拥有，作为框架子节点渲染在零宽度侧边栏子树之外（`data-sidebar-reveal`），因此在任何收起状态（包括窄视口自动收起）下都保持可见可交互。在 macOS 上，桌面外壳通过 `DESKTOP_SURFACE_CSS` 把它放在原生 traffic lights 右侧（left 84px，与展开态开关左缘一致）或原生全屏时侧边栏左侧内容内缩位置（left 12px）。对话头部只避开这个左上角 chrome 簇（窗口态 120px，全屏 48px），以共享的 1.2px 垂直偏移让标题与展开控件保持对齐，并带动 Chat / Trajectory 行及分割线同步移动——绝不保留原侧边栏宽度。展开时恢复最后一次可用宽度：布局 store 保存 `sidebarLast`，拖拽写入会刷新它，手动开关关闭到 0 并重新打开到该宽度而非约定默认值；窄视口自动收起保持原有偏好语义（偏好不变，`narrowExpanded` 覆盖）。

## Alternatives considered

- **保留 56px 紧凑轨道。** 否决：轨道正是本 issue 要移除的东西——收起后仍占一条固定条带，其开关也无法进入原生 traffic lights 行。
- **把展开控件渲染在侧边栏子树内部（旧的轨道开关）。** 否决：零宽度子树放不下可交互控件；控件必须位于子树之外（验收标准 #3）。
- **重新打开到约定默认宽度。** 否决：恢复最后一次可用宽度是 issue 的明确要求（验收标准 #7），且 store 在关闭前本来就持有拖拽宽度。

## Consequences

- `columns.ts` 不再导出 `SIDEBAR_COLLAPSED`；关闭的侧边栏解析为 0，中栏吸收收回的宽度。
- 布局 store 新增 `sidebarLast`（最后一次可用宽度）；`toggleSidebar`（宽视口）关闭到 0 并记住它，再打开恢复到它；`setSidebar` 在每次打开态写入时刷新它。
- `AppFrame` 渲染 `data-sidebar-reveal`（框架自有 chrome，ui-layout 的 `layout` 语言命名空间），收起时移除侧边栏拖拽手柄，并去掉收起列的分隔线边框。
- `SidebarRoot` 在收起 settle 后不再渲染任何内容（只保留淡出式收起，无轨道）；展开态开关仍留在侧边栏第一行。
- 对话头部暴露 `data-conversation-header` 属性钩子；客户端 CSS 避开展开控件（48px），`DESKTOP_SURFACE_CSS` 对齐收起态标题行，并增加 macOS traffic lights 簇避让（窗口态 120px，全屏 48px）与共享的 1.2px 垂直偏移。
- `DESKTOP_SURFACE_CSS` 删除收起轨道规则，新增 `[data-sidebar-reveal]` 定位（窗口态 84px，全屏 12px），以及头部对齐与避让规则。
- 打包验收（`--accept-native-window`）现在会拖拽侧边栏、收起它，并断言零宽度轨道、被收回的对话宽度、两种窗口状态下的展开控件位置、头部避让与恢复的拖拽宽度；`--record-native-window` 还会在无密钥回合结束后录制 `session-sidebar-collapsed` 与 `session-fullscreen-collapsed`，让标题、标签与分割线可见。
- [Session 列表浏览与 Workspace 手动排序](2026-07-25-session-list-browsing-and-manual-order.md)定义的浏览归属边界保持不变：侧边栏子 slot 不携带收起状态 owner props，Workspace 浏览器、Settings 与页脚操作仅在外壳挂载期间渲染其展开形态。
