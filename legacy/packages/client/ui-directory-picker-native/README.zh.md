# @deepseek-ai/dsh-client-ui-directory-picker-native

[English](README.md) | 中文

原生目录选择器的客户端界面。它通过 ui-workspace 的两个 directory-flow 洞（`conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`）装入一个无渲染占位者，每次收到 `open` 请求就通过 `ctx.workspaces.pickDirectory()` 作答，然后经 owner 会话回报恰好一个结果——选中的路径、取消或失败。实际选择器归组合的 Host 能力所有：普通本地 Web 部署可以使用 [`dsh-host-directory-picker-native`](../../host/directory-picker-native/README.md)，Electron 桌面产品则通过类型化反向请求提供同一种能力。客户端代码不按提供方分支。

两处注册通过嵌套的 `slots.inject()` 作为一个事务性 effect 安装，因为任一声明方条目都可能稍后激活或替换其声明。占位者在每个 `open` 上升沿只武装一次，所以重渲染（包括采纳期间 `busy` 而 `open` 仍为真）都不会再开第二个选择框；owner 撤回 `open` 会为下一次请求重新武装。结果经由 ref 回报，因此答案落到 owner 最新的处理器上，而不是打开选择框时捕获的那一套。卸载或 owner 撤回会中止请求并丢弃其结算；仅 injected face 身份变化会保留当前操作，因为它仍属于同一个 owner 任务。

node 半边是一个空 `apply`：它的存在只为让插件出现在 host 的 cordis.yml 与 Loader 中，浏览器半边经 `exports["./client"]` 出货，并通过 `dsh.client` 清单声明被发现。

## 模型体验

无，因为目录选择器属于浏览器界面；本包中的任何内容都不会进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **物理对话框能否关闭取决于提供方** —— owner 撤回会立即中止 wire 请求并忽略迟到结算，但若提供方的操作系统 API 无法关闭已经显示的选择器，它可能继续可见，直到用户主动关闭。
- **仅限本地 Host 载体** —— 系统对话框开在运行 Host 的机器上，所以进程内与远程浏览器部署需要改用 `-browse` 组合。平台失败通过 owner 的可重试文件夹对话框呈现。
