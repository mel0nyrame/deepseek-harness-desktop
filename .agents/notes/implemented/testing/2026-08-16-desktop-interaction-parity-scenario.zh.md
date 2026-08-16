# Agent Note: 桌面端交互等价场景经 Electron 载体回放三个 Session

Status: implemented

[English](2026-08-16-desktop-interaction-parity-scenario.md) | 中文

## Problem

桌面 tracer bullet 只覆盖了 Session 创建与一个由终端执行的工具回合。Issue #6 要求桌面外壳经 Electron 载体保留 Web 交互模型——基于现有 Host 服务的 Workspace 与 Session、带有序流式输出的 prompt、审批与提问——并从现有持久化重建、经装配渲染器给出真实无密钥快照。既有场景还存在一个静默缺陷：组合中的 `session-title-llm` 行发出的 fire-and-forget 辅助标题调用消耗了一个 llm-replay 脚本条目，使该 Session 的游标在回合最后一次模型调用前耗尽，回合以错误结束而断言没有察觉。

## Decision

一个共享的无密钥场景（`apps/desktop/src/smoke.ts` 的 `runSmokeScenario`）同时驱动开发版 e2e 与打包 smoke，共八个有序阶段：就绪与无 TCP 监听探针；持久 Workspace 的创建与幂等重开；有序 terminal 回合；经载体 `/api/respond` 端点作答的提问回合；同样方式作答的沙箱升级审批回合；以及从持久 Session 日志重建全部模型可见输入。阶段结果写入 reopen 状态文件，第二次打包启动（`--smoke-reopen --smoke-home <dir>`）据此断言：Workspace 与三个 Session 无需任何模型调用即从现有持久化重建。

- **回放 profile patch 禁用组合后的 `session-title-llm` 行**（`- id: session-title-llm / disabled: true`），理由与 Web scaffold 相同：其辅助标题调用会与 agent loop 争抢该 Session 的回放游标。每个回合现在断言 `turn/end` 的 reason 为 `completed`，回放欠载将响亮失败而不是带着错误回合通过。
- **三个录制 fixture 按 llm-replay 的首次模型调用顺序绑定到三个 live Session**：主 `bash-tool-turn` fixture，`question-composer` 与 `approval-composer` 作为 `childFiles`。直接复用 Web fixture，不手工派生新的录制会话。
- **提问与审批的作答是驱动方经载体发出的真实手势**：`client-response` 回显 server-request 的 rpcId，经 `POST /api/respond` 发送——与用户在 renderer 作答时的 wire 行为完全一致。
- **权限切换走 `commands/execute` Typert remote**（`/permission read-only`）——即 Web 客户端 `session.command` 发出的同一 remote 调用。以斜杠命令行调用 `session.prompt` 在此载体上不是命令：实测它会被送入模型。
- **录制旅程（`--record-native-window`）现在覆盖装配渲染器的交互路径**：terminal 回合后经 wire 再创建两个工作区 Session，通过真实 New Session 侧栏行分别导航，用真实 access-mode chip 切到 Read Only，在装配好的提问面板中作答（Blue 选项加自定义文本），在装配好的审批面板点击 Allow once，并断言升级后的 `notes.txt` 落入了验收工作区。
- **载体对每条流的 frame 做端到端节流**：子进程在发送下一条 frame 前等待 Electron main 逐 frame 的 `stream-ack`（headless smoke 驱动方逐 frame 自动确认），renderer 客户端在每个事件的消费方取走它之后才确认——而不是在 preload 分发时确认。因此慢 renderer 会节制有序 source，而不是撑爆有界 relay。

## Alternatives considered

- **把辅助标题调用录制进 fixture** 而非禁用 title-llm：回放脚本只从 `assistant/chunk` 事件派生，辅助标题流无法在录制会话中表达；该 fire-and-forget 调用在调用序列中的位置本身不确定，sidecar 补丁也无法钉住它。
- **通过 `session.prompt` 斜杠行切换沙箱模式**：apiproxy 的 prompt 路径会把消息送入 agent loop（实测：回放的 bash 回合直接运行）；命令只能经 `commands/execute` Remote 执行。
- **手工拼接一个三回合 fixture** 而非三个 fixture 对应三个 live Session：拼接需要手工重编号会话日志并维护一份派生产物；llm-replay 的绑定契约本就按序确定主脚本与子脚本，三个 live Session 还顺带演练了 reopen 证据所依赖的 Session 导航。

## Consequences

- 场景会对任何非 `completed` 的 `turn/end` 响亮失败；既有的 title-llm 欠载会被新断言当场抓住。
- smoke profile 与出厂桌面组合的唯一差异是 title-llm 禁用行——与 Web scaffold 记录在案的差异相同。
- 打包 smoke 现在要求把三个 fixture 复制进启动主目录，录制旅程为录制证据新增四个帧标签（`question-pending`、`question-settled`、`approval-pending`、`approval-settled`）。
- 审批 fixture 的 1784 个有序 chunk 实测了载体的 ack 节流；没有它，relay 的 256 frame 上界会在回合中途中止流，审批面板永远不会渲染出来。
