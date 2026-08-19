# Agent Note: 必需的 Python 运行时拉取请求验证

Status: implemented

[English](2026-08-12-required-python-runtime-pull-request-ci.md) | 中文

## 问题

普通拉取请求 CI 会针对 fake 运行时对端执行完整的 Python SDK pytest 套件，而 Node 快照使用不同的客户端与预期输出。真实 Python 客户端、打包后的 JSON-RPC 可执行文件、exe 专用快照、发布形态 wheel 包与干净安装只在可选的单文件可执行程序工作流或 Python 发布工作流中汇合。因此，运行时事件或闭包发生变化后，陈旧的 Python 投影或损坏的 wheel 包路径仍可能合并，直到后续有人构建 Python 发布候选版本时才失败。

## 决策

[PR/tag CI 分层决策](../process/2026-08-19-pr-tag-ci-tiering.md)取代了本 Note 原先要求在合并时验证可执行文件的安排。每个拉取请求都在 [CI](../../../../.github/workflows/ci.yml) 中运行必需的 `pr-python-sdk` 作业，执行完整的无密钥 Python SDK 套件。发布形态验证在 `v*` 标签上通过 `tag-python-runtime` 运行；该作业调用共享的[单文件可执行程序构建器](../../../../.github/workflows/build-exe-for-python-sdk.yml)验证 linux-x64、linux-arm64 与 macos-arm64，并参与 `tag-checks-passed`。

共享构建器会构建真实可执行文件，运行全部无密钥 Python 完整轮次和直接二进制场景（包括两份检入的快照），构建 SDK 与运行时 wheel 包，将二者安装进干净的虚拟环境，检查可执行文件与原生 addon 的部署要求，并在 manylinux 2.28 容器中运行 Linux wheel 包。Linux 会删除解析出的 `node-pty` 构建目录，并在 manylinux 重建前调用锁文件解析出的 node-gyp；否则，pnpm 的副作用缓存可能恢复来自另一种安装拓扑的生成态相对路径。

进阶 exe 快照会在比较前规范化不透明的会话、消息、subagent 和工作流运行标识符。因此，新增的持久化工作流事件会改变经过审阅的预期输出，但不会把随机运行标识符写入其中。极简场景的[模型可见快照](2026-08-13-python-minimal-model-visible-snapshot.md)覆盖了这份快照所占位化的已组装系统提示词、工具 schema 与消息列表。

## 曾考虑的替代方案

**每个拉取请求都运行完整原生矩阵。** 这会在三个作业中重复平台无关的完整轮次与快照行为，并让每项改动都消耗 ARM64 Linux 和 macOS 容量。Python 发布工作流在需要全部三个产物的环节保留这部分证据。

**针对开发用 Node 载体运行快照。** 这可以捕获协议与事件投影漂移，但不能证明 pkg 组装、部署后的运行时闭包、原生 addon 暂存、wheel 包构建、精确依赖版本与干净安装。标签运行时构建器直接覆盖发布路径。

**通过路径过滤或标签选择 Python SDK 作业。** Python 行为依赖 `python/` 之外共享的 agent、会话、工作流、subagent 与插件加载代码。不完整的依赖过滤会再次延迟发现投影故障，标签则会让证据保持可选。

## 后果

每个拉取请求只承担完整无密钥 Python SDK 套件的成本，因此客户端投影故障仍会阻断合并，而无需同时打包原生运行时。可执行文件、addon、wheel 包与干净安装回归可能晚于拉取请求暴露，改由发布前的三目标标签门禁阻断。
