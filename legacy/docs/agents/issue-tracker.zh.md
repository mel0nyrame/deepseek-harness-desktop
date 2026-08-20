# Issue 跟踪系统：GitHub

[English](issue-tracker.md) | 中文

本仓库的 issue 与规格说明存放在 GitHub Issues 中。所有操作均使用 `gh` CLI。

## 约定

- **创建 issue：**`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue：**`gh issue view <number> --comments`，同时读取其标签与相关评论。
- **列出 issue：**`gh issue list --state open --json number,title,body,labels,comments`，并按需设置标签与状态过滤条件。
- **评论 issue：**`gh issue comment <number> --body "..."`。
- **添加或移除标签：**`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`。
- **关闭 issue：**`gh issue close <number> --comment "..."`。

根据 `git remote -v` 推断仓库；在克隆目录内运行时，`gh` 会自动完成该推断。

## 将 PR 纳入 triage

**将 PR 作为请求入口：否。**

改为 `yes` 后，外部 PR 使用与 issue 相同的 triage 标签与状态：

- **读取 PR：**`gh pr view <number> --comments` 与 `gh pr diff <number>`。
- **列出外部 PR：**使用 `gh pr list`，只保留作者关联为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的 PR。
- **评论、添加标签或关闭：**使用对应的 `gh pr` 命令。

GitHub 的 issue 与 PR 共用一套编号空间。遇到含糊的 `#42` 时，先运行 `gh pr view 42`，再回退到 `gh issue view 42`。

## 当 skill 要求“发布到 issue 跟踪系统”时

创建一个 GitHub issue。

## 当 skill 要求“获取相关 ticket”时

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

`wayfinder` skill 使用一个 issue 表示工作地图，并使用其子 issue 表示 ticket。

- **地图：**一个带有 `wayfinder:map` 标签的 issue，包含 Notes、Decisions-so-far 与 Fog 三节。
- **子 ticket：**通过 GitHub 子 issue 关联的 issue。如果无法使用子 issue，则将其加入地图的任务列表，并在正文开头写入 `Part of #<map>`。应用一个 `wayfinder:<type>` 标签：`research`、`prototype`、`grilling` 或 `task`。
- **阻塞关系：**使用 GitHub 原生 issue 依赖关系。如果无法使用依赖关系，则在子 issue 正文开头写入 `Blocked by: #<n>, #<n>`。
- **可执行前沿：**按地图顺序检查尚未关闭的子 issue，选择第一个没有未关闭阻塞项且未分配负责人的 ticket。
- **认领：**运行 `gh issue edit <number> --add-assignee @me`，将其作为本次会话的首次写操作。
- **完成：**评论处理结果、关闭子 issue，并在地图的 Decisions-so-far 一节添加简洁的结果链接。
