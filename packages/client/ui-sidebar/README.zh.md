# @deepseek-ai/dsh-client-ui-sidebar

[English](README.md) | 中文

侧边栏外壳插件：负责字标、New Session 操作、布局持有的折叠开关、可感知滚动的区域 seat，以及固定在底部的 Settings seat。[ui-workspace](../ui-workspace/README.md) 持有渲染到 `sidebar.workspaces` 的 Workspace 与 Session 浏览器；本包既不派生其中的行，也不持有其视图偏好。收起解析为布局拥有的零宽度轨道：外壳在交叉淡化结束后卸载，由框架的展开控件（[ui-layout](../ui-layout/README.md) 所有，位于本子树之外）接管。约定：[slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md)。

New Session 会启动运行时的页面局部前端 Session Intent。运行时优先使用作用域操作明确指定的 Workspace，否则使用当前 Session 所属 Workspace，再否则使用最近活跃 Workspace；一个 Workspace 都没有时则清空选择，进入空白 New Session 页面。Workspace 专属控件与共享选择器由 ui-workspace 持有。

`SidebarRootComponentProps` 组合布局 owner share、全局 `useSessions` 和 `useWorkspaces` 钩子、已声明的 `sidebar.workspaces` 与 `sidebar.settings` 子 slot，以及注入的 `startSession` 与侧边栏切换回调。这里没有插件 store。

实时收起时，外壳会把展开内容固定在当前宽度（内联样式），并用 150ms 将其淡出；布局的 300ms 栏滑动把它裁剪到零宽度轨道，到 settle 时外壳整体卸载——不再保留任何紧凑轨道。页面初始即为收起状态时什么都不渲染（展开控件是框架的唯一可用入口）；减少动态效果模式会禁用这些过渡。展开时宽内容以 200ms wide-in 淡入重新挂载。

栏内的滚动条是一种指针可供性：只要指针不在栏内，外壳就把 ui-theme 的[滚动条间接层](../ui-theme/README.md)重新绑定为 `transparent`；指针离开后滑块再保留 2 秒，因此没人指向的列表不会带着滚动条。避免行位移的空间预留属于滚动区域本身（[ui-workspace](../ui-workspace/README.md)），所以显示滑块不会引起重排。

页脚包含固定在底部的 `sidebar.footer.action` 与 `sidebar.settings` seat。两个 seat 仅在展开态外壳挂载期间存在，因此 owner share 均为空；ui-cordis 与 ui-settings-general 分别在此注册各自的触发行和面板。

`/client` 导出表层只包含插件主体（`apply`／`inject`）及约定类型；SidebarRoot、行组件和树派生仍由 slot 注册封装在包内。

## 模型体验

无。侧边栏渲染浏览器会话列表；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包（package）既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **Session 状态点渲染由 [ui-workspace](../ui-workspace/README.md) 持有**：没有可用的 done/error 通知数据源。
- **Workspace 浏览行为由组合持有**：分组、排序、搜索与行状态都属于 [ui-workspace](../ui-workspace/README.md)，不属于此外壳。
- **「New task completed」未读标记是本地查看状态**：完成时间 > 上次查看时间这一事实永远不会到达宿主。
